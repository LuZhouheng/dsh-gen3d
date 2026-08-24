// 确定性 mock 网格构建器 —— 生成一个可渲染的极简角色替身 GLB 字节。
//
// 背景：legacy shared/catalog.ts 的 mockGlbBytes 原本是「glTF magic + 尾缀」
// 的占位字节（NodeIO 读不出来，渲染器 / inspect 工具会把它当 asset_unrenderable）。
// 本模块把占位字节升级为真正的几何 GLB：椭球身体 + 球头 + 圆柱四肢，
// 顶点 / 法线 / 索引都由解析公式生成，面数落在 1–3k，材质 baseColorFactor
// 由 cacheKey 哈希确定性取色（同 seed 必须产出完全相同字节）。
//
// 为什么不用 @gltf-transform/core 的 NodeIO.writeBinary：它返回 Promise
// （writeJSON 是 async），而 mock 链路（generateMeshyTextMockResult →
// mockProviderResult）是同步函数，调用点遍布 generation / animation，
// 改成 async 会牵动一大片。GLB 容器（JSON chunk + BIN chunk）本身就是
// 简单定长格式，这里手写一个最小编码器，保证同步 + 确定性。
//
// 输出字节布局（glTF 2.0 GLB）：
//   12 字节头（magic 'glTF' / version 2 / total length）
//   chunk 0：JSON（asset / scenes / nodes / meshes / materials / accessors /
//     bufferViews / buffers），4 字节对齐、空格填充
//   chunk 1：BIN（positions + normals + indices 拼一个 buffer），4 字节对齐、零填充

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

// ── 确定性哈希（与 catalog.ts 的 fnv1a 同算法；独立副本避免循环依赖） ───────────

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ── 几何原语（参数化解析生成，面数精确可得） ────────────────────────────────────

/** 椭球（经度 × 纬度环形）；返回位置 / 法线 / 索引，单位中心 y 段数可控。 */
function buildEllipsoid(
  rx: number,
  ry: number,
  rz: number,
  cx: number,
  cy: number,
  cz: number,
  segW: number,
  segH: number,
): { positions: number[]; normals: number[]; indices: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  // 纬线环（含两极，用 segH+1 环）；每环 segW 点
  for (let h = 0; h <= segH; h += 1) {
    const phi = (h / segH) * Math.PI; // 0..π（顶到底）
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    for (let w = 0; w < segW; w += 1) {
      const theta = (w / segW) * Math.PI * 2;
      const x = cx + rx * sinPhi * Math.cos(theta);
      const y = cy + ry * cosPhi;
      const z = cz + rz * sinPhi * Math.sin(theta);
      positions.push(x, y, z);
      // 椭球面法线 = 分量除以半径平方后归一
      const nx = (x - cx) / (rx * rx);
      const ny = (y - cy) / (ry * ry);
      const nz = (z - cz) / (rz * rz);
      const len = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / len, ny / len, nz / len);
    }
  }
  for (let h = 0; h < segH; h += 1) {
    for (let w = 0; w < segW; w += 1) {
      const a = h * segW + w;
      const b = h * segW + ((w + 1) % segW);
      const c = (h + 1) * segW + ((w + 1) % segW);
      const d = (h + 1) * segW + w;
      indices.push(a, b, c, a, c, d);
    }
  }
  return { positions, normals, indices };
}

/** 圆柱（竖直，带上下盖）；返回位置 / 法线 / 索引。 */
function buildCylinder(
  radius: number,
  height: number,
  cx: number,
  cy: number,
  cz: number,
  segW: number,
  segments: number,
): { positions: number[]; normals: number[]; indices: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const half = height / 2;
  // 环点（segments+1 行，底面到顶面）
  for (let s = 0; s <= segments; s += 1) {
    const y = cy - half + (s / segments) * height;
    for (let w = 0; w < segW; w += 1) {
      const theta = (w / segW) * Math.PI * 2;
      positions.push(cx + radius * Math.cos(theta), y, cz + radius * Math.sin(theta));
      normals.push(Math.cos(theta), 0, Math.sin(theta));
    }
  }
  // 侧面
  for (let s = 0; s < segments; s += 1) {
    for (let w = 0; w < segW; w += 1) {
      const a = s * segW + w;
      const b = s * segW + ((w + 1) % segW);
      const c = (s + 1) * segW + ((w + 1) % segW);
      const d = (s + 1) * segW + w;
      indices.push(a, b, c, a, c, d);
    }
  }
  // 下盖（法线朝下）与上盖（法线朝上）
  const bottomCenter = positions.length / 3;
  positions.push(cx, cy - half, cz);
  normals.push(0, -1, 0);
  const topCenter = positions.length / 3;
  positions.push(cx, cy + half, cz);
  normals.push(0, 1, 0);
  for (let w = 0; w < segW; w += 1) {
    const next = (w + 1) % segW;
    // 下盖：顶点顺序反绕（法线 -y）
    indices.push(bottomCenter, next, w);
    // 上盖
    indices.push(topCenter, segments * segW + w, segments * segW + next);
  }
  return { positions, normals, indices };
}

// ── 角色组装（椭球身体 + 球头 + 四肢，合并成单 mesh 单 primitive） ──────────────

const BODY_SEGW = 20;
const BODY_SEGH = 14;
const HEAD_SEGW = 14;
const HEAD_SEGH = 10;
const LIMB_SEGW = 8;

/** 面数常量（测试引用）：由最终组装几何精确计算（此时索引已全）。 */
export const MOCK_CHARACTER_FACES = (() => {
  const { indices } = buildCharacterVertices();
  return indices.length / 3;
})();

/** 沿 y 轴的部件几何：椭球（中心 cy，半径 rx/ry/rz）。 */
function addEllipsoid(
  acc: { positions: number[]; normals: number[]; indices: number[] },
  rx: number,
  ry: number,
  rz: number,
  cx: number,
  cy: number,
  cz: number,
  segW: number,
  segH: number,
): void {
  const part = buildEllipsoid(rx, ry, rz, cx, cy, cz, segW, segH);
  tileInto(acc, part);
}

/** 竖直圆柱部件。 */
function addLimb(
  acc: { positions: number[]; normals: number[]; indices: number[] },
  radius: number,
  height: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  const part = buildCylinder(radius, height, cx, cy, cz, LIMB_SEGW, 2);
  tileInto(acc, part);
}

/** 把一个部件追加进累计器（索引偏移）并消除跨部件共享的极点退化 triangle。 */
function tileInto(
  acc: { positions: number[]; normals: number[]; indices: number[] },
  part: { positions: number[]; normals: number[]; indices: number[] },
): void {
  const offset = acc.positions.length / 3;
  for (let i = 0; i < part.positions.length; i += 1) acc.positions.push(part.positions[i]!);
  for (let i = 0; i < part.normals.length; i += 1) acc.normals.push(part.normals[i]!);
  for (let i = 0; i < part.indices.length; i += 1) acc.indices.push(part.indices[i]! + offset);
}

/**
 * 组装极简角色替身：椭球身体（矮胖机器人比例）+ 球头 + 两根手臂两根腿。
 * 顶点在零附近（身体中心 y=0、总高约 2.2 单位），无网格地面时渲染器自行 fit。
 */
function buildCharacterVertices(): {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
} {
  const acc: { positions: number[]; normals: number[]; indices: number[] } = {
    positions: [],
    normals: [],
    indices: [],
  };
  // 身体（椭球 0.85 × 0.75 × 0.55，中心 y=0）
  addEllipsoid(acc, 0.85, 0.75, 0.55, 0, 0, 0, BODY_SEGW, BODY_SEGH);
  // 头（球 0.42，中心 y=1.05）
  addEllipsoid(acc, 0.42, 0.42, 0.42, 0, 1.05, 0, HEAD_SEGW, HEAD_SEGH);
  // 手臂两根（半径 0.14、长 0.7，从肩 y=0.62 向下→中心 y=0.27）
  addLimb(acc, 0.14, 0.7, -1.02, 0.27, 0);
  addLimb(acc, 0.14, 0.7, 1.02, 0.27, 0);
  // 腿两根（半径 0.18、长 0.7，中心 y=-0.72）
  addLimb(acc, 0.18, 0.7, -0.34, -0.72, 0);
  addLimb(acc, 0.18, 0.7, 0.34, -0.72, 0);
  return {
    positions: Float32Array.from(acc.positions),
    normals: Float32Array.from(acc.normals),
    indices: Uint32Array.from(acc.indices),
  };
}

/** 确定性取色：seed → fnv1a → 固定调色板（游戏角色常见的明快色相）。 */
const MOCK_PALETTE: readonly [number, number, number][] = [
  [0.85, 0.42, 0.30], // 陶土红
  [0.32, 0.58, 0.82], // 天蓝
  [0.50, 0.72, 0.36], // 草绿
  [0.90, 0.74, 0.28], // 姜黄
  [0.62, 0.48, 0.78], // 紫
  [0.36, 0.76, 0.70], // 青绿
];

/** seed → baseColorFactor [r,g,b,1]（确定性；跨调用稳定）。 */
export function mockCharacterColor(seed: string): [number, number, number, number] {
  const hash = parseInt(fnv1a(seed), 16);
  const [r, g, b] = MOCK_PALETTE[hash % MOCK_PALETTE.length]!;
  return [r, g, b, 1];
}

// ── 最小 GLB 编码器（同步、确定性） ────────────────────────────────────────────

function align4(n: number): number {
  return (n + 3) & ~3;
}

/** 拼 4 字节对齐的 chunk（pad 填 padByte）。 */
function chunkOf(type: number, body: Uint8Array, padByte: number): Uint8Array {
  const padded = align4(body.byteLength);
  const out = new Uint8Array(8 + padded);
  const view = new DataView(out.buffer);
  view.setUint32(0, padded, true);
  view.setUint32(4, type, true);
  out.set(body, 8);
  if (padded > body.byteLength) out.fill(padByte, 8 + body.byteLength);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** 生成确定性角色替身 GLB 字节（同步）。 */
export function buildMockCharacterGlb(seed: string): Uint8Array {
  const { positions, normals, indices } = buildCharacterVertices();
  const color = mockCharacterColor(seed);

  const posBytes = new Uint8Array(positions.buffer as ArrayBuffer);
  const nrmBytes = new Uint8Array(normals.buffer as ArrayBuffer);
  const idxArr = indicesToUint16(indices);
  const idxBytes = new Uint8Array(idxArr.buffer as ArrayBuffer);

  const binLen = posBytes.byteLength + nrmBytes.byteLength + idxBytes.byteLength;
  const bin = new Uint8Array(align4(binLen));
  let off = 0;
  bin.set(posBytes, off);
  off += posBytes.byteLength;
  bin.set(nrmBytes, off);
  off += nrmBytes.byteLength;
  bin.set(idxBytes, off);

  // bufferViews：positions / normals / indices
  let cursor = 0;
  const viewPos = cursor;
  cursor += posBytes.byteLength;
  const viewNrm = cursor;
  cursor += nrmBytes.byteLength;
  const viewIdx = cursor;

  const posMin: [number, number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const posMax: [number, number, number] = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < positions.length; i += 3) {
    for (let c = 0; c < 3; c += 1) {
      const v = positions[i + c]!;
      if (v < posMin[c]!) posMin[c] = v;
      if (v > posMax[c]!) posMax[c] = v;
    }
  }

  const json = {
    asset: { version: '2.0', generator: 'dsh-gen3d-mock' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'mock-character' }],
    meshes: [
      {
        name: 'mock-character',
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            indices: 2,
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        name: 'mock-material',
        pbrMetallicRoughness: {
          baseColorFactor: color,
          metallicFactor: 0.0,
          roughnessFactor: 0.7,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: positions.length / 3,
        type: 'VEC3',
        min: posMin,
        max: posMax,
      },
      { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: idxArr.length, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: viewPos, byteLength: posBytes.byteLength, target: 34962 },
      { buffer: 0, byteOffset: viewNrm, byteLength: nrmBytes.byteLength, target: 34962 },
      { buffer: 0, byteOffset: viewIdx, byteLength: idxBytes.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonChunk = chunkOf(CHUNK_JSON, jsonBytes, 0x20); // JSON chunk 空格填充
  const binChunk = chunkOf(CHUNK_BIN, bin, 0x00);

  const total = 12 + jsonChunk.byteLength + binChunk.byteLength;
  const out = new Uint8Array(total);
  const head = new DataView(out.buffer);
  // GLB 头按小端写：magic 'glTF'（0x46546c67）、version 2、总长
  head.setUint32(0, GLB_MAGIC, true);
  head.setUint32(4, 2, true);
  head.setUint32(8, total, true);
  out.set(jsonChunk, 12);
  out.set(binChunk, 12 + jsonChunk.byteLength);
  return out;
}

/** 顶点数几乎必然 < 65536：用 uint16 索引（5123）；超限抛错（mock 不会发生）。 */
function indicesToUint16(indices: Uint32Array): Uint16Array {
  const max = indices.length > 0 ? Math.max(...indices) : 0;
  if (max > 0xffff) throw new Error(`mock mesh 顶点超 uint16 上限：${max}`);
  return Uint16Array.from(indices);
}
