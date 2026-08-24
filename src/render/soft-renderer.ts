// 纯 JS 软光栅渲染器 —— 视口级模型预览的渲染核心。
//
// 输入 @gltf-transform/core 的 Document（NodeIO 读 GLB 字节得到；draco 解码在
// glb-reader.ts 处理）；输出每视角的 RGBA Uint8Array 帧。功能：
// - z-buffer 遮挡（1/z 插值）+ 透视校正属性插值（屏幕空间重心线性）
// - Lambert 主光 + 弱补光，材质 baseColorFactor 着色（无贴图采样）
// - 法线插值（缺失法线的 primitive 按平直面法线回退）
// - 网格地面（y=bbox 最底，±1.6r 范围）+ 接触阴影（沿主光投影到地面，乘暗混合）
// - style 三档：shaded（Lambert）/ clay（纯色陶土）/ wireframe（shaded + 边线叠加）
// - turntable：水平环绕 N 视角、相机自动 fit bbox、稍俯视
// - contact-sheet：横向拼图（总宽超限自动最近邻降采样，适配附件 8192 边限制）
//
// 性能目标：30k 三角形 × 8 视角 × 768² ≤ 2s。光栅器热点全部手写紧循环
// （无逐像素函数调用、无逐像素分配）；三角形入口做两项前筛：
// 1. 屏幕空间有符号面积 |area| < 1px 的退化三角形直接剔除；
// 2. 屏幕 bbox 用 Math.floor/ceil 取整成整数像素区间并 clamp 视口（浮点索引
//    会让数组读到 undefined）；
// 3. 重心内点测试绕序无关：edge 函数除以有符号面积 → b0/b1/b2 全部 >= 0。

import type { Document, Node, Primitive } from '@gltf-transform/core';

// ── 公共类型 ──────────────────────────────────────────────────────────────

export type RenderStyle = 'shaded' | 'clay' | 'wireframe';
export type RenderBackground = 'dark' | 'light';

/** 一帧 RGBA 图像（alpha=255）。 */
export interface RenderFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export interface TurntableOptions {
  /** 视口边长（正方形），256–1024。 */
  size: number;
  /** 视角数量，4–24。 */
  angles: number;
  style: RenderStyle;
  background: RenderBackground;
}

export interface TurntableResult {
  frames: RenderFrame[];
  /** 渲染的三角形总数（GL primitive 计数口径）。 */
  faces: number;
  /** 参与渲染的顶点总数。 */
  vertices: number;
}

// ── 常量 ──────────────────────────────────────────────────────────────────

/** 主光方向（世界空间，单位向量：前上偏右）。 */
const KEY_LIGHT: readonly [number, number, number] = [0.45, 0.82, 0.55];
/** 弱补光方向（左后偏上，强度低于主光）。 */
const FILL_LIGHT: readonly [number, number, number] = [-0.55, 0.28, -0.65];
const AMBIENT = 0.30;
const KEY_STRENGTH = 0.72;
const FILL_STRENGTH = 0.20;

const FOV_Y_DEG = 40;
const CAMERA_ELEVATION_DEG = 22; // 稍俯视
const FIT_MARGIN = 1.18;
/** 接触阴影把地面像素乘暗到 62%（模拟软阴影的简单效果）。 */
const SHADOW_DARKEN = 0.62;
/** 阴影 / 线框的深度向相机偏移比例（抑制与地面网格的 z-fighting）。 */
const DEPTH_BIAS = 0.0025;
/** 近平面（相机 fit 后模型几乎不可能穿过；防守半途三角形）。 */
const NEAR_Z = 0.05;

const BG_DARK: readonly [number, number, number] = [24, 27, 34];
const BG_LIGHT: readonly [number, number, number] = [236, 238, 244];
const GRID_DARK: readonly [number, number, number] = [46, 52, 66];
const GRID_LIGHT: readonly [number, number, number] = [196, 201, 214];
const WIRE_DARK: readonly [number, number, number] = [248, 249, 252];
const WIRE_LIGHT: readonly [number, number, number] = [32, 34, 42];

// ── 几何展平 ──────────────────────────────────────────────────────────────

/** 展平网格：世界空间位置 / 法线 / 顶点色（baseColorFactor rgb）与索引流。 */
export interface FlattenedMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  /** 每三角形是否平直着色（primitive 无 NORMAL 属性）。 */
  flat: Uint8Array;
  faces: number;
  vertices: number;
}

function* walkNodes(nodes: readonly Node[]): Generator<Node> {
  for (const node of nodes) {
    yield node;
    yield* walkNodes(node.listChildren());
  }
}

/** 文档 → 展平世界空间网格（默认场景；无场景时遍历全根节点）。 */
export function flattenDocument(doc: Document): FlattenedMesh {
  const root = doc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  const nodes = scene ? walkNodes(scene.listChildren()) : walkNodes(root.listNodes());

  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  let faces = 0;

  for (const node of nodes) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix(); // mat4，列主序（列 c 行 r = m[c*4+r]）
    for (const prim of mesh.listPrimitives()) {
      appendPrimitive(prim, m, positions, normals, colors, indices);
    }
  }

  const vertexCount = positions.length / 3;
  const triCount = indices.length / 3;

  // 平直着色判定：primitive 无 NORMAL 时其三个顶点的法线为 (0,0,0)
  const flat = new Uint8Array(triCount);
  for (let t = 0; t < triCount; t += 1) {
    const v = indices[t * 3]! * 3;
    flat[t] = normals[v] === 0 && normals[v + 1] === 0 && normals[v + 2] === 0 ? 1 : 0;
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    colors: Float32Array.from(colors),
    indices: Uint32Array.from(indices),
    flat,
    faces: triCount,
    vertices: vertexCount,
  };
}

/** 一个 primitive 追加进累计数组（TRIANGLES / STRIP / FAN；点线跳过）。 */
function appendPrimitive(
  prim: Primitive,
  m: number[],
  positions: number[],
  normals: number[],
  colors: number[],
  indices: number[],
): void {
  const posAcc = prim.getAttribute('POSITION');
  if (!posAcc) return;
  const posArray = posAcc.getArray();
  if (!posArray) return;
  const vertexCount = posAcc.getCount();
  if (vertexCount < 3) return;
  const mode = prim.getMode();
  if (mode !== 4 && mode !== 5 && mode !== 6) return;

  const baseVertex = positions.length / 3;
  // 材质 baseColorFactor（无材质 / 无 factor → 白）
  const material = prim.getMaterial();
  const factor = material ? material.getBaseColorFactor() : [1, 1, 1, 1];
  const cr = factor[0] ?? 1;
  const cg = factor[1] ?? 1;
  const cb = factor[2] ?? 1;

  const nrmAcc = prim.getAttribute('NORMAL');
  const nrmArray = nrmAcc ? nrmAcc.getArray() : null;
  const hasNormals = nrmArray !== null && nrmArray.length >= vertexCount * 3;

  // World position = M * p；法线只用旋转部分（3x3）再归一
  const p0 = m[0]!;
  const p1 = m[1]!;
  const p2 = m[2]!;
  const p4 = m[4]!;
  const p5 = m[5]!;
  const p6 = m[6]!;
  const p8 = m[8]!;
  const p9 = m[9]!;
  const p10 = m[10]!;
  const p12 = m[12]!;
  const p13 = m[13]!;
  const p14 = m[14]!;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = posArray[i * 3]!;
    const y = posArray[i * 3 + 1]!;
    const z = posArray[i * 3 + 2]!;
    positions.push(
      p0 * x + p4 * y + p8 * z + p12,
      p1 * x + p5 * y + p9 * z + p13,
      p2 * x + p6 * y + p10 * z + p14,
    );
    if (hasNormals) {
      const nx = nrmArray[i * 3]!;
      const ny = nrmArray[i * 3 + 1]!;
      const nz = nrmArray[i * 3 + 2]!;
      const wx = p0 * nx + p4 * ny + p8 * nz;
      const wy = p1 * nx + p5 * ny + p9 * nz;
      const wz = p2 * nx + p6 * ny + p10 * nz;
      const len = Math.hypot(wx, wy, wz) || 1;
      normals.push(wx / len, wy / len, wz / len);
    } else {
      // 占位 (0,0,0)：flattenDocument 阶段按三角形判 flat 并回退面法线
      normals.push(0, 0, 0);
    }
    colors.push(cr, cg, cb);
  }

  const idxAcc = prim.getIndices();
  const idxArray = idxAcc ? idxAcc.getArray() : null;
  const idxCount = idxArray ? idxArray.length : vertexCount;

  if (mode === 4) {
    for (let i = 0; i + 2 < idxCount; i += 3) {
      const a = idxArray ? idxArray[i]! : i;
      const b = idxArray ? idxArray[i + 1]! : i + 1;
      const c = idxArray ? idxArray[i + 2]! : i + 2;
      if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
      indices.push(baseVertex + a, baseVertex + b, baseVertex + c);
    }
  } else if (mode === 5) {
    // TRIANGLE_STRIP：奇数步翻转绕序
    for (let i = 0; i + 2 < idxCount; i += 1) {
      const a = idxArray ? idxArray[i]! : i;
      const b = idxArray ? idxArray[i + 1]! : i + 1;
      const c = idxArray ? idxArray[i + 2]! : i + 2;
      if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
      if (i % 2 === 1) indices.push(baseVertex + b, baseVertex + a, baseVertex + c);
      else indices.push(baseVertex + a, baseVertex + b, baseVertex + c);
    }
  } else {
    // TRIANGLE_FAN
    for (let i = 1; i + 1 < idxCount; i += 1) {
      const a = idxArray ? idxArray[0]! : 0;
      const b = idxArray ? idxArray[i]! : i;
      const c = idxArray ? idxArray[i + 1]! : i + 1;
      if (a >= vertexCount || b >= vertexCount || c >= vertexCount) continue;
      indices.push(baseVertex + a, baseVertex + b, baseVertex + c);
    }
  }
}

/** 三角形面法线（世界空间）。 */
function faceNormal(
  positions: Float32Array,
  a: number,
  b: number,
  c: number,
): [number, number, number] {
  const ax = positions[a * 3]!;
  const ay = positions[a * 3 + 1]!;
  const az = positions[a * 3 + 2]!;
  const bx = positions[b * 3]!;
  const by = positions[b * 3 + 1]!;
  const bz = positions[b * 3 + 2]!;
  const cx = positions[c * 3]!;
  const cy = positions[c * 3 + 1]!;
  const cz = positions[c * 3 + 2]!;
  let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
  let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return [0, 1, 0];
  nx /= len;
  ny /= len;
  nz /= len;
  return [nx, ny, nz];
}

// ── 帧状态与相机 ──────────────────────────────────────────────────────────

interface ViewBasis {
  eye: [number, number, number];
  r: [number, number, number];
  u: [number, number, number];
  f: [number, number, number];
}

interface RenderTarget {
  size: number;
  framebuffer: Uint8Array;
  zbuf: Float32Array;
  /** 每顶点屏幕投影缓存（可按帧重建）。 */
  sx: Float32Array;
  sy: Float32Array;
  invZ: Float32Array;
  /** 投影焦距（fov 缩放）。 */
  focal: number;
  /** 当前帧相机基。 */
  view: ViewBasis;
}

/** bbox 中心 / 半径 / 底。 */
interface Bounds {
  cx: number;
  cy: number;
  cz: number;
  radius: number;
  minY: number;
}

function computeBounds(positions: Float32Array): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) {
    return { cx: 0, cy: 0, cz: 0, radius: 1, minY: 0 };
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dz = maxZ - minZ;
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    cz: (minZ + maxZ) / 2,
    radius: Math.max(Math.hypot(dx, dy, dz) / 2, 1e-3),
    minY,
  };
}

/** 相机 fit 包围球的位置缓存：yaw → eye（elev 固定）。 */
function cameraEye(bounds: Bounds, yaw: number, distance: number): [number, number, number] {
  const elev = (CAMERA_ELEVATION_DEG * Math.PI) / 180;
  const cosE = Math.cos(elev);
  return [
    bounds.cx + distance * cosE * Math.sin(yaw),
    bounds.cy + distance * Math.sin(elev),
    bounds.cz + distance * cosE * Math.cos(yaw),
  ];
}

/** 看向 center 的 view 基（up = (0,1,0)）。 */
function makeViewBasis(eye: [number, number, number], center: [number, number, number]): ViewBasis {
  let fx = center[0] - eye[0];
  let fy = center[1] - eye[1];
  let fz = center[2] - eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = normalize(cross(f, up))；up = (0,1,0) → cross = (fz, 0, -fx)
  let rx = fz;
  let rz = -fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl;
  rz /= rl;
  const ry = 0;
  // u = cross(r, f)
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;
  return { eye: [eye[0], eye[1], eye[2]], r: [rx, ry, rz], u: [ux, uy, uz], f: [fx, fy, fz] };
}

/** 世界点 → 屏幕 + invZ；返回 false 表示点在近平面后。 */
function projectPoint(
  target: RenderTarget,
  x: number,
  y: number,
  z: number,
  out: { sx: number; sy: number; invZ: number },
): boolean {
  const { view, size, focal } = target;
  const dx = x - view.eye[0];
  const dy = y - view.eye[1];
  const dz = z - view.eye[2];
  const vx = view.r[0] * dx + view.r[1] * dy + view.r[2] * dz;
  const vy = view.u[0] * dx + view.u[1] * dy + view.u[2] * dz;
  const vz = view.f[0] * dx + view.f[1] * dy + view.f[2] * dz;
  if (vz < NEAR_Z) return false;
  out.sx = size / 2 + focal * (vx / vz) * (size / 2);
  out.sy = size / 2 - focal * (vy / vz) * (size / 2);
  out.invZ = 1 / vz;
  return true;
}

/** 世界点 → view 空间（无屏幕投影；供线段近平面裁剪）。 */
function worldToView(view: ViewBasis, x: number, y: number, z: number): [number, number, number] {
  const dx = x - view.eye[0];
  const dy = y - view.eye[1];
  const dz = z - view.eye[2];
  return [
    view.r[0] * dx + view.r[1] * dy + view.r[2] * dz,
    view.u[0] * dx + view.u[1] * dy + view.u[2] * dz,
    view.f[0] * dx + view.f[1] * dy + view.f[2] * dz,
  ];
}

// ── 光栅化 ────────────────────────────────────────────────────────────────

const EDGE_EPS = 1e-7;

interface TriangleRasterOpts {
  mode: 'replace' | 'multiply';
  /** 平直着色时使用的面法线（世界空间）。 */
  flatNormal: [number, number, number] | null;
  /** 面法线朝向远离相机时翻转插值法线（三角形级决定）。 */
  flipNormal: boolean;
  /** clay / wireframe / shaded 的着色分支（wireframe 底层用 shaded）。 */
  style: RenderStyle;
  background: RenderBackground;
}

/**
 * 光栅化一个三角形。
 * - mode='replace'：z-buffer + 透视校正属性插值写入（模型 / 地面网格用）；
 * - mode='multiply'：只做 z 偏置测试并乘暗 framebuffer（接触阴影用）。
 */
function rasterTriangle(target: RenderTarget, mesh: FlattenedMesh, a: number, b: number, c: number, opts: TriangleRasterOpts): void {
  const { sx, sy, invZ, zbuf, size } = target;
  const x0 = sx[a]!;
  const y0 = sy[a]!;
  const x1 = sx[b]!;
  const y1 = sy[b]!;
  const x2 = sx[c]!;
  const y2 = sy[c]!;

  // 退化三角形（屏幕面积 < 1px）剔除
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1.0) return;

  // bbox：floor/ceil 取整成整数像素区间（浮点索引会读 undefined）
  let minX = Math.floor(Math.min(x0, x1, x2));
  let maxX = Math.ceil(Math.max(x0, x1, x2)) - 1;
  let minY = Math.floor(Math.min(y0, y1, y2));
  let maxY = Math.ceil(Math.max(y0, y1, y2)) - 1;
  if (minX < 0) minX = 0;
  if (minY < 0) minY = 0;
  if (maxX >= size) maxX = size - 1;
  if (maxY >= size) maxY = size - 1;
  if (minX > maxX || minY > maxY) return;

  const invArea = 1 / area;
  const iz0 = invZ[a]!;
  const iz1 = invZ[b]!;
  const iz2 = invZ[c]!;
  const fb = target.framebuffer;

  const { positions, normals, colors } = mesh;
  const isFlat = opts.flatNormal !== null;
  const fn = opts.flatNormal ?? [0, 1, 0];
  const useMultiply = opts.mode === 'multiply';
  const clay = opts.style === 'clay';

  // 透视校正插值所需的 (attr / z)
  const pr0 = colors[a * 3]!;
  const pg0 = colors[a * 3 + 1]!;
  const pb0 = colors[a * 3 + 2]!;
  const pr1 = colors[b * 3]!;
  const pg1 = colors[b * 3 + 1]!;
  const pb1 = colors[b * 3 + 2]!;
  const pr2 = colors[c * 3]!;
  const pg2 = colors[c * 3 + 1]!;
  const pb2 = colors[c * 3 + 2]!;
  const nr0 = normals[a * 3]!;
  const ng0 = normals[a * 3 + 1]!;
  const nb0 = normals[a * 3 + 2]!;
  const nr1 = normals[b * 3]!;
  const ng1 = normals[b * 3 + 1]!;
  const nb1 = normals[b * 3 + 2]!;
  const nr2 = normals[c * 3]!;
  const ng2 = normals[c * 3 + 1]!;
  const nb2 = normals[c * 3 + 2]!;

  // 背面翻转时顶点法线整体取反（平直着色同样适用）
  const fDot = opts.flipNormal ? -1 : 1;

  for (let y = minY; y <= maxY; y += 1) {
    const py = y + 0.5;
    const rowBase = y * size;
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      // 绕序无关内点测试：edge 除以有符号面积 → 内点 b0/b1/b2 恒 >= 0。
      // 注意配对：e0 是边 (v0→v1) 的 edge 函数、对应**对边顶点 c** 的权重，
      // 因此 b0 ↔ c、b1 ↔ a、b2 ↔ b（下文武茨权重按此配对）。
      const e0 = (x1 - x0) * (py - y0) - (y1 - y0) * (px - x0);
      const e1 = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
      const e2 = (x0 - x2) * (py - y2) - (y0 - y2) * (px - x2);
      const b0 = e0 * invArea; // w(c)
      const b1 = e1 * invArea; // w(a)
      const b2 = 1 - b0 - b1; // w(b) = e2 / area
      if (b0 < -EDGE_EPS || b1 < -EDGE_EPS || b2 < -EDGE_EPS) continue;

      const wa = b1;
      const wb = b2;
      const wc = b0;
      const iw = wa * iz0 + wb * iz1 + wc * iz2;
      const idx = rowBase + x;
      if (useMultiply) {
        // 阴影：与地面共面，靠深度偏置赢过网格线
        if (iw + DEPTH_BIAS * iw <= zbuf[idx]!) continue;
      } else {
        if (iw <= zbuf[idx]!) continue;
        zbuf[idx] = iw;
      }

      const fb4 = idx * 4;
      if (useMultiply) {
        fb[fb4] = fb[fb4]! * SHADOW_DARKEN;
        fb[fb4 + 1] = fb[fb4 + 1]! * SHADOW_DARKEN;
        fb[fb4 + 2] = fb[fb4 + 2]! * SHADOW_DARKEN;
        fb[fb4 + 3] = 255;
        continue;
      }

      // 透视校正：attr = Σ(w_i · attr_i/z_i) / Σ(w_i/z_i)，分母即 iw
      const r = (wa * pr0 * iz0 + wb * pr1 * iz1 + wc * pr2 * iz2) / iw;
      const g = (wa * pg0 * iz0 + wb * pg1 * iz1 + wc * pg2 * iz2) / iw;
      const bl = (wa * pb0 * iz0 + wb * pb1 * iz1 + wc * pb2 * iz2) / iw;

      let outR: number;
      let outG: number;
      let outB: number;
      if (clay) {
        // 纯色陶土：无方向光，只保留材质色（轮廓由地面 / 阴影衬托）
        outR = r * 255;
        outG = g * 255;
        outB = bl * 255;
      } else {
        let nr: number;
        let ng: number;
        let nb: number;
        if (isFlat) {
          nr = fn[0] * fDot;
          ng = fn[1] * fDot;
          nb = fn[2] * fDot;
        } else {
          const nx = (b0 * nr0 * iz0 + b1 * nr1 * iz1 + b2 * nr2 * iz2) / iw;
          const ny = (b0 * ng0 * iz0 + b1 * ng1 * iz1 + b2 * ng2 * iz2) / iw;
          const nz = (b0 * nb0 * iz0 + b1 * nb1 * iz1 + b2 * nb2 * iz2) / iw;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nr = (nx / nl) * fDot;
          ng = (ny / nl) * fDot;
          nb = (nz / nl) * fDot;
        }
        // Lambert：主光 + 弱补光
        const d1 = Math.max(nr * KEY_LIGHT[0] + ng * KEY_LIGHT[1] + nb * KEY_LIGHT[2], 0);
        const d2 = Math.max(nr * FILL_LIGHT[0] + ng * FILL_LIGHT[1] + nb * FILL_LIGHT[2], 0);
        const light = AMBIENT + KEY_STRENGTH * d1 + FILL_STRENGTH * d2;
        outR = r * light * 255;
        outG = g * light * 255;
        outB = bl * light * 255;
      }
      fb[fb4] = outR > 255 ? 255 : outR;
      fb[fb4 + 1] = outG > 255 ? 255 : outG;
      fb[fb4 + 2] = outB > 255 ? 255 : outB;
      fb[fb4 + 3] = 255;
    }
  }
}

/** view 空间线段 → 屏幕投影画线（近平面裁剪 + 深度偏置）。 */
function drawViewLine(
  target: RenderTarget,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  color: readonly [number, number, number],
  bias: number,
): void {
  const { size, zbuf } = target;
  const focal = target.focal;
  if (z0 < NEAR_Z && z1 < NEAR_Z) return;
  let t0 = 0;
  let t1 = 1;
  if (z0 < NEAR_Z) t0 = (NEAR_Z - z0) / (z1 - z0);
  if (z1 < NEAR_Z) t1 = (NEAR_Z - z0) / (z1 - z0);
  const ax = x0 + (x1 - x0) * t0;
  const ay = y0 + (y1 - y0) * t0;
  const az = z0 + (z1 - z0) * t0;
  const bx = x0 + (x1 - x0) * t1;
  const by = y0 + (y1 - y0) * t1;
  const bz = z0 + (z1 - z0) * t1;
  const sx0 = size / 2 + focal * (ax / az) * (size / 2);
  const sy0 = size / 2 - focal * (ay / az) * (size / 2);
  const sx1 = size / 2 + focal * (bx / bz) * (size / 2);
  const sy1 = size / 2 - focal * (by / bz) * (size / 2);
  const steps = Math.max(Math.ceil(Math.abs(sx1 - sx0)), Math.ceil(Math.abs(sy1 - sy0)), 1);
  const iz0 = 1 / az;
  const iz1 = 1 / bz;
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = Math.round(sx0 + (sx1 - sx0) * t);
    const y = Math.round(sy0 + (sy1 - sy0) * t);
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const iw = iz0 + (iz1 - iz0) * t;
    const idx = y * size + x;
    if (iw + bias * iw <= zbuf[idx]!) continue;
    zbuf[idx] = iw + bias * iw;
    const fb4 = idx * 4;
    target.framebuffer[fb4] = color[0];
    target.framebuffer[fb4 + 1] = color[1];
    target.framebuffer[fb4 + 2] = color[2];
    target.framebuffer[fb4 + 3] = 255;
  }
}

/** 屏幕边线（线框叠加）：两顶点直接插值屏幕坐标与 invZ。 */
function drawEdge(target: RenderTarget, a: number, b: number, color: readonly [number, number, number]): void {
  const { sx, sy, invZ, zbuf, size } = target;
  const xa = sx[a]!;
  const ya = sy[a]!;
  const xb = sx[b]!;
  const yb = sy[b]!;
  const steps = Math.max(Math.abs(Math.round(xb) - Math.round(xa)), Math.abs(Math.round(yb) - Math.round(ya)), 1);
  const iza = invZ[a]!;
  const izb = invZ[b]!;
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const x = Math.round(xa + (xb - xa) * t);
    const y = Math.round(ya + (yb - ya) * t);
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    const iw = iza + (izb - iza) * t;
    const idx = y * size + x;
    if (iw + DEPTH_BIAS * iw <= zbuf[idx]!) continue;
    zbuf[idx] = iw + DEPTH_BIAS * iw;
    const fb4 = idx * 4;
    target.framebuffer[fb4] = color[0];
    target.framebuffer[fb4 + 1] = color[1];
    target.framebuffer[fb4 + 2] = color[2];
    target.framebuffer[fb4 + 3] = 255;
  }
}

// ── 主渲染循环 ────────────────────────────────────────────────────────────

/** 渲染 turntable：N 个水平环绕视角，每帧 size×size RGBA。 */
export function renderTurntable(doc: Document, options: TurntableOptions): TurntableResult {
  const { size, angles, style, background } = options;
  const mesh = flattenDocument(doc);

  // 视口预分配（复用跨帧缓冲）
  const framebuffer = new Uint8Array(size * size * 4);
  const zbuf = new Float32Array(size * size);
  const sx = new Float32Array(mesh.vertices);
  const sy = new Float32Array(mesh.vertices);
  const invZ = new Float32Array(mesh.vertices);

  const bounds = computeBounds(mesh.positions);
  const focal = 1 / Math.tan((FOV_Y_DEG / 2) * (Math.PI / 180));
  const distance = focal * bounds.radius * FIT_MARGIN;

  const target: RenderTarget = {
    size,
    framebuffer,
    zbuf,
    sx,
    sy,
    invZ,
    focal,
    view: makeViewBasis([0, 0, 0], [0, 0, 0]),
  };

  // 相机 fit（elev 固定）：eye 高度含 radius 修正（俯视时中心略降，模型完整入框）
  const bg = background === 'dark' ? BG_DARK : BG_LIGHT;
  const gridColor = background === 'dark' ? GRID_DARK : GRID_LIGHT;
  const wireColor = background === 'dark' ? WIRE_DARK : WIRE_LIGHT;

  const frames: RenderFrame[] = [];
  const projBuf = { sx: 0, sy: 0, invZ: 0 };

  for (let i = 0; i < angles; i += 1) {
    const yaw = (i / angles) * Math.PI * 2;
    const eye = cameraEye(bounds, yaw, distance);
    target.view = makeViewBasis(eye, [bounds.cx, bounds.cy, bounds.cz]);

    // 顶点投影（模型）
    for (let v = 0; v < mesh.vertices; v += 1) {
      if (projectPoint(target, mesh.positions[v * 3]!, mesh.positions[v * 3 + 1]!, mesh.positions[v * 3 + 2]!, projBuf)) {
        sx[v] = projBuf.sx;
        sy[v] = projBuf.sy;
        invZ[v] = projBuf.invZ;
      } else {
        sx[v] = -1e9;
        sy[v] = -1e9;
        invZ[v] = 0;
      }
    }

    // 背景清屏
    for (let p = 0; p < size * size; p += 1) {
      const fb4 = p * 4;
      framebuffer[fb4] = bg[0];
      framebuffer[fb4 + 1] = bg[1];
      framebuffer[fb4 + 2] = bg[2];
      framebuffer[fb4 + 3] = 255;
    }
    zbuf.fill(0);

    // 地面网格（y=minY，±1.6r，6×6 格线；先画写进 zbuf，模型会覆盖它）
    const floorY = bounds.minY;
    const ext = bounds.radius * 1.6;
    const step = (ext * 2) / 6;
    for (let g = -3; g <= 3; g += 1) {
      const x = bounds.cx + g * step;
      const z0 = bounds.cz - ext;
      const z1 = bounds.cz + ext;
      const [vx0, vy0, vz0] = worldToView(target.view, x, floorY, z0);
      const [vx1, vy1, vz1] = worldToView(target.view, x, floorY, z1);
      drawViewLine(target, vx0, vy0, vz0, vx1, vy1, vz1, gridColor, 0.0004);
      const zz = bounds.cz + g * step;
      const [wx0, wy0, wz0] = worldToView(target.view, bounds.cx - ext, floorY, zz);
      const [wx1, wy1, wz1] = worldToView(target.view, bounds.cx + ext, floorY, zz);
      drawViewLine(target, wx0, wy0, wz0, wx1, wy1, wz1, gridColor, 0.0004);
    }

    // 接触阴影：沿主光投影到地面（独立投影缓存，乘暗混合；先画，模型后覆盖）
    const lx = KEY_LIGHT[0];
    const ly = KEY_LIGHT[1];
    const lz = KEY_LIGHT[2];
    if (ly > 1e-3) {
      const shadowView = shadowProjection(target, mesh, bounds, lx, ly, lz);
      for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
        const a = mesh.indices[t]!;
        const b = mesh.indices[t + 1]!;
        const c = mesh.indices[t + 2]!;
        rasterTriangle(shadowView, mesh, a, b, c, {
          mode: 'multiply',
          flatNormal: null,
          flipNormal: false,
          style,
          background,
        });
      }
    }

    // 模型（replace；背面翻转由面法线决定）
    for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
      const a = mesh.indices[t]!;
      const b = mesh.indices[t + 1]!;
      const c = mesh.indices[t + 2]!;
      // 相机后顶点：跳过（相机 fit 后几乎不可能，防守极端输入）
      if (sx[a]! < -1e8 || sx[b]! < -1e8 || sx[c]! < -1e8) continue;
      // 面法线 + 朝向判定（flat 时同时用作着色法线）
      const fn = faceNormal(mesh.positions, a, b, c);
      // 重心 → 相机方向（决定是否翻转法线做双面着色）
      const toEyeX = eye[0] - (mesh.positions[a * 3]! + mesh.positions[b * 3]! + mesh.positions[c * 3]!) / 3;
      const toEyeY = eye[1] - (mesh.positions[a * 3 + 1]! + mesh.positions[b * 3 + 1]! + mesh.positions[c * 3 + 1]!) / 3;
      const toEyeZ = eye[2] - (mesh.positions[a * 3 + 2]! + mesh.positions[b * 3 + 2]! + mesh.positions[c * 3 + 2]!) / 3;
      const facing = fn[0] * toEyeX + fn[1] * toEyeY + fn[2] * toEyeZ;
      rasterTriangle(target, mesh, a, b, c, {
        mode: 'replace',
        flatNormal: mesh.flat[t] === 1 ? fn : null,
        flipNormal: facing < 0,
        style,
        background,
      });
    }

    // wireframe：模型上叠加三角形边线（深度偏置，可见边自然被 z-buffer 裁掉）
    if (style === 'wireframe') {
      for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
        const a = mesh.indices[t]!;
        const b = mesh.indices[t + 1]!;
        const c = mesh.indices[t + 2]!;
        if (sx[a]! < -1e8 || sx[b]! < -1e8 || sx[c]! < -1e8) continue;
        drawEdge(target, a, b, wireColor);
        drawEdge(target, b, c, wireColor);
        drawEdge(target, c, a, wireColor);
      }
    }

    frames.push({ width: size, height: size, rgba: framebuffer.slice() });
  }

  return { frames, faces: mesh.faces, vertices: mesh.vertices };
}

/**
 * 接触阴影准备：浅拷贝 RenderTarget（共享 framebuffer / zbuf / view / focal /
 * size），但使用独立的 sx/sy/invZ 缓存 —— 把每个顶点沿主光方向投影到地面
 * y=minY，并用当前相机重新投影覆盖该缓存（invZ 即地面点真实深度，与地面
 * 网格共面，配合 DEPTH_BIAS 赢得 z-test）。阴影画完后模型 pass 用的是
 * 原始投影缓存，互不干扰。
 */
function shadowProjection(
  target: RenderTarget,
  mesh: FlattenedMesh,
  bounds: Bounds,
  lx: number,
  ly: number,
  lz: number,
): RenderTarget {
  const { positions } = mesh;
  const n = mesh.vertices;
  const shadow: RenderTarget = {
    size: target.size,
    framebuffer: target.framebuffer,
    zbuf: target.zbuf,
    sx: new Float32Array(n),
    sy: new Float32Array(n),
    invZ: new Float32Array(n),
    focal: target.focal,
    view: target.view,
  };
  const projBuf = { sx: 0, sy: 0, invZ: 0 };
  for (let v = 0; v < n; v += 1) {
    const px = positions[v * 3]!;
    const py = positions[v * 3 + 1]!;
    const pz = positions[v * 3 + 2]!;
    const s = (py - bounds.minY) / ly; // 沿 -L 方向落到地面（光从上往下）
    const gx = px - lx * s;
    const gy = bounds.minY;
    const gz = pz - lz * s;
    if (projectPoint(shadow, gx, gy, gz, projBuf)) {
      shadow.sx[v] = projBuf.sx;
      shadow.sy[v] = projBuf.sy;
      shadow.invZ[v] = projBuf.invZ;
    } else {
      shadow.sx[v] = -1e9;
      shadow.sy[v] = -1e9;
      shadow.invZ[v] = 0;
    }
  }
  return shadow;
}

// ── contact sheet ─────────────────────────────────────────────────────────

/**
 * 横向拼图：frames 依次并排成一行。总宽超过 maxTotalWidth 时按最近邻
 * 降采样（附件平台限制边长 ≤8192，24 视角 × 1024 会超）。
 */
export function contactSheet(frames: readonly RenderFrame[], maxTotalWidth = 8192): RenderFrame {
  const count = frames.length;
  if (count === 0) {
    throw new Error('contactSheet 需要至少 1 帧');
  }
  const per = Math.max(1, Math.min(frames[0]!.width, Math.floor(maxTotalWidth / count)));
  const scale = per / frames[0]!.width;
  const height = Math.max(1, Math.round(frames[0]!.height * scale));
  const out = new Uint8Array(per * count * height * 4);

  const srcW = frames[0]!.width;
  for (let f = 0; f < count; f += 1) {
    const frame = frames[f]!;
    for (let y = 0; y < height; y += 1) {
      const sySrc = Math.min(Math.round(y / scale), srcW - 1);
      const srcRow = sySrc * srcW;
      const dstRow = y * per * count + f * per;
      for (let x = 0; x < per; x += 1) {
        const sxSrc = Math.min(Math.round(x / scale), srcW - 1);
        const src = (srcRow + sxSrc) * 4;
        const dst = (dstRow + x) * 4;
        out[dst] = frame.rgba[src]!;
        out[dst + 1] = frame.rgba[src + 1]!;
        out[dst + 2] = frame.rgba[src + 2]!;
        out[dst + 3] = 255;
      }
    }
  }
  return { width: per * count, height, rgba: out };
}
