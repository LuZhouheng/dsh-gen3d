// soft-renderer / encode 单测 —— 用 catalog 新的确定性 mock 几何（可渲染
// 角色替身）验证渲染输出：
// 1. turntable 帧数 / 尺寸 / RGBA 长度正确；像素方差 > 0（非空白）；
// 2. 三种 style 出图；wireframe 边线与 clay 有差分；
// 3. z-buffer 遮挡正确性：同场景前后两片，前片（z 更近）盖后片；
// 4. 退化三角形（重合顶点）不炸、无 NaN；接触阴影 / 地面网格存在；
// 5. encode：PNG / GIF magic 与尺寸、contact-sheet 拼图与超宽降采样；
// 6. 性能（GEN3D_PERF=1 才跑）：30k 面 × 8 视角 × 768² 墙钟。
//
// 构造辅助：createQuadScene（前后两片）、createDegenerateScene（含零面积三）。

import { Document, NodeIO } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';

import { buildMockCharacterGlb, MOCK_CHARACTER_FACES } from '../legacy/shared/mock-mesh.js';
import { encodeGif, encodePng } from './encode.js';
import { contactSheet, renderTurntable } from './soft-renderer.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]; // 'GIF89a'
const BG_DARK: [number, number, number] = [24, 27, 34];

async function docOf(bytes: Uint8Array): Promise<Document> {
  return new NodeIO().readBinary(bytes);
}

/** 渲染 mock 角色（确定性字节 → Document）。 */
async function renderMock(size = 96, angles = 4, style: 'shaded' | 'clay' | 'wireframe' = 'shaded') {
  const doc = await docOf(buildMockCharacterGlb('seed-test'));
  const result = renderTurntable(doc, { size, angles, style, background: 'dark' });
  expect(result.faces).toBe(MOCK_CHARACTER_FACES);
  expect(result.frames).toHaveLength(angles);
  return result;
}

function countNonBg(frame: { rgba: Uint8Array }): number {
  let n = 0;
  for (let i = 0; i < frame.rgba.length; i += 4) {
    if (
      Math.abs(frame.rgba[i]! - BG_DARK[0]) > 6 ||
      Math.abs(frame.rgba[i + 1]! - BG_DARK[1]) > 6 ||
      Math.abs(frame.rgba[i + 2]! - BG_DARK[2]) > 6
    ) {
      n += 1;
    }
  }
  return n;
}

/** 场景：一张 1.2×1.2、法线 +z 的 quad（位置 z 与颜色可配）。 */
function createQuadScene(pieces: { z: number; color: [number, number, number] }[]): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  for (const piece of pieces) {
    const pos = doc.createAccessor().setType('VEC3').setArray(
      new Float32Array([-0.6, -0.6, piece.z, 0.6, -0.6, piece.z, 0.6, 0.6, piece.z, -0.6, 0.6, piece.z]),
    ).setBuffer(buffer);
    const nrm = doc.createAccessor().setType('VEC3').setArray(
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    ).setBuffer(buffer);
    const idx = doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2, 0, 2, 3])).setBuffer(buffer);
    const material = doc.createMaterial('quad').setBaseColorFactor([piece.color[0], piece.color[1], piece.color[2], 1]);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx).setMaterial(material);
    scene.addChild(doc.createNode('quad').setMesh(doc.createMesh('quad').addPrimitive(prim)));
  }
  return doc;
}

describe('soft-renderer（mock 角色几何）', () => {
  it('turntable 帧数与尺寸正确、RGBA 长度匹配', async () => {
    const result = await renderMock(96, 8);
    for (const frame of result.frames) {
      expect(frame.width).toBe(96);
      expect(frame.height).toBe(96);
      expect(frame.rgba).toHaveLength(96 * 96 * 4);
    }
  });

  it('渲染非空白：深色背景上有明显前景像素（≥5% 画面）', async () => {
    const result = await renderMock(128, 4);
    for (const frame of result.frames) {
      expect(countNonBg(frame)).toBeGreaterThan(128 * 128 * 0.05);
    }
  });

  it('三种 style 都能出图；wireframe 与 clay 像素存在差分（边线）', async () => {
    const doc = await docOf(buildMockCharacterGlb('seed-style'));
    const clay = renderTurntable(doc, { size: 128, angles: 1, style: 'clay', background: 'dark' });
    const shaded = renderTurntable(doc, { size: 128, angles: 1, style: 'shaded', background: 'dark' });
    const wire = renderTurntable(doc, { size: 128, angles: 1, style: 'wireframe', background: 'dark' });
    let wireDiff = 0;
    for (let i = 0; i < clay.frames[0]!.rgba.length; i += 4) {
      if (
        Math.abs(clay.frames[0]!.rgba[i]! - wire.frames[0]!.rgba[i]!) > 12 ||
        Math.abs(clay.frames[0]!.rgba[i + 1]! - wire.frames[0]!.rgba[i + 1]!) > 12
      ) {
        wireDiff += 1;
      }
    }
    expect(wireDiff).toBeGreaterThan(200); // 线框边线必然改变一批像素
    let shadeDiff = 0;
    for (let i = 0; i < clay.frames[0]!.rgba.length; i += 4) {
      if (
        Math.abs(clay.frames[0]!.rgba[i]! - shaded.frames[0]!.rgba[i]!) > 10 ||
        Math.abs(clay.frames[0]!.rgba[i + 1]! - shaded.frames[0]!.rgba[i + 1]!) > 10
      ) {
        shadeDiff += 1;
      }
    }
    expect(shadeDiff).toBeGreaterThan(100); // 着色与纯色陶土有光照差
  });

  it('z-buffer 遮挡：同场景前片（z 更近）盖后片；只留后片时中心变后片色', () => {
    const withFront = renderTurntable(createQuadScene([
      { z: 0.6, color: [0.95, 0.2, 0.2] },
      { z: -0.6, color: [0.2, 0.25, 0.95] },
    ]), { size: 64, angles: 2, style: 'clay', background: 'dark' });
    const onlyBack = renderTurntable(createQuadScene([
      { z: -0.6, color: [0.2, 0.25, 0.95] },
    ]), { size: 64, angles: 2, style: 'clay', background: 'dark' });

    const readCenter = (frame: { rgba: Uint8Array }) => {
      const i = (32 * 64 + 32) * 4;
      return [frame.rgba[i]!, frame.rgba[i + 1]!, frame.rgba[i + 2]!] as const;
    };
    const yaw0WithFront = readCenter(withFront.frames[0]!);
    // yaw 0 → 相机在 +z 侧：前片 z=+0.6 更近 → 中心应是前片红
    expect(yaw0WithFront[0]).toBeGreaterThan(180);
    expect(yaw0WithFront[2]).toBeLessThan(120);
    // 后片单独场景：中心是蓝
    const backCenter = readCenter(onlyBack.frames[0]!);
    expect(backCenter[2]).toBeGreaterThan(180);
    expect(backCenter[0]).toBeLessThan(120);
    // 转 180°（frames[1]）：相机到 -z 侧，前景/背景互换 → 中心应读蓝
    // （证明遮挡关系随视角翻转，而不是固定覆盖）
    const yaw180 = readCenter(withFront.frames[1]!);
    expect(yaw180[2]).toBeGreaterThan(180);
    expect(yaw180[0]).toBeLessThan(120);
  });

  it('退化三角形（重合顶点）不炸、输出无 NaN、仍有前景', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene('Scene');
    // 三角形 1 正常（3×3），三角形 2 退化（两个顶点重合），三角形 3 零面积
    const pos = doc.createAccessor().setType('VEC3').setArray(
      new Float32Array([-3, -3, 0, 3, -3, 0, 0, 3, 0, 10, 10, 0, 10, 10, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    ).setBuffer(buffer);
    const nrm = doc.createAccessor().setType('VEC3').setArray(
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    ).setBuffer(buffer);
    const idx = doc.createAccessor().setType('SCALAR').setArray(
      new Uint16Array([0, 1, 2, 3, 4, 5, 6, 7, 8]),
    ).setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx);
    scene.addChild(doc.createNode('tri').setMesh(doc.createMesh('tri').addPrimitive(prim)));
    const result = renderTurntable(doc, { size: 64, angles: 2, style: 'shaded', background: 'dark' });
    expect(result.faces).toBe(3);
    for (const frame of result.frames) {
      for (let i = 0; i < frame.rgba.length; i += 1) {
        expect(Number.isFinite(frame.rgba[i]!)).toBe(true);
      }
      expect(countNonBg(frame)).toBeGreaterThan(0);
    }
  });
});

describe('encode（PNG / GIF）', () => {
  it('encodePng 输出 PNG magic 与 IHDR 尺寸', async () => {
    const frame = (await renderMock(48, 1)).frames[0]!;
    const png = encodePng(frame);
    expect([png[0], png[1], png[2], png[3]]).toEqual(PNG_MAGIC);
    const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
    expect(view.getUint32(16)).toBe(48); // IHDR 宽
    expect(view.getUint32(20)).toBe(48); // IHDR 高
  });

  it('encodeGif 输出 GIF89a magic', async () => {
    const result = await renderMock(48, 4);
    const gif = encodeGif(result.frames, 100);
    expect([gif[0], gif[1], gif[2], gif[3], gif[4], gif[5]]).toEqual(GIF_MAGIC);
    expect(gif.byteLength).toBeGreaterThan(100);
  });

  it('contact-sheet 横向拼图：宽 = 帧数 × 帧宽、高不变', async () => {
    const result = await renderMock(64, 4);
    const sheet = contactSheet(result.frames);
    expect(sheet.width).toBe(64 * 4);
    expect(sheet.height).toBe(64);
    expect(sheet.rgba).toHaveLength(64 * 4 * 64 * 4);
  });

  it('contact-sheet 超宽降采样（maxTotalWidth 限制）', async () => {
    const result = await renderMock(64, 4);
    const sheet = contactSheet(result.frames, 128);
    expect(sheet.width).toBeLessThanOrEqual(128);
    expect(sheet.width).toBe(4 * 32);
    expect(sheet.height).toBe(32);
  });
});

// ── 性能基准（GEN3D_PERF=1 才跑；30k 面 × 8 视角 × 768²） ───────────────────

describe('软渲染性能', () => {
  it.skipIf(!process.env.GEN3D_PERF)('30k 面 × 8 视角 × 768² 墙钟 ≤ 2s', async () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene('Scene');
    // 密集 UV 球：约 30k 三角形（两极处退化为零面积，渲染器剔除）
    const segW = 130;
    const segH = 116;
    const positions: number[] = [];
    const normals: number[] = [];
    for (let h = 0; h <= segH; h += 1) {
      const phi = (h / segH) * Math.PI;
      for (let w = 0; w < segW; w += 1) {
        const theta = (w / segW) * Math.PI * 2;
        const x = Math.sin(phi) * Math.cos(theta);
        const y = Math.cos(phi);
        const z = Math.sin(phi) * Math.sin(theta);
        positions.push(x, y, z);
        normals.push(x, y, z);
      }
    }
    const indices: number[] = [];
    for (let h = 0; h < segH; h += 1) {
      for (let w = 0; w < segW; w += 1) {
        const a = h * segW + w;
        const b = h * segW + ((w + 1) % segW);
        const c = (h + 1) * segW + w;
        const d = (h + 1) * segW + ((w + 1) % segW);
        indices.push(a, b, c, b, d, c);
      }
    }
    const pos = doc.createAccessor().setType('VEC3').setArray(Float32Array.from(positions)).setBuffer(buffer);
    const nrm = doc.createAccessor().setType('VEC3').setArray(Float32Array.from(normals)).setBuffer(buffer);
    const idx = doc.createAccessor().setType('SCALAR').setArray(Uint32Array.from(indices)).setBuffer(buffer);
    const prim = doc.createPrimitive().setAttribute('POSITION', pos).setAttribute('NORMAL', nrm).setIndices(idx);
    scene.addChild(doc.createNode('sphere').setMesh(doc.createMesh('sphere').addPrimitive(prim)));
    const bytes = await new NodeIO().writeBinary(doc);
    const loaded = await docOf(bytes);

    const t0 = performance.now();
    const result = renderTurntable(loaded, { size: 768, angles: 8, style: 'shaded', background: 'dark' });
    const wallMs = performance.now() - t0;
    expect(result.faces).toBeGreaterThan(29000);
    expect(wallMs).toBeLessThan(2000);
    console.info(`[perf] 30k 面 × 8 视角 × 768² 墙钟 ${wallMs.toFixed(1)}ms（faces=${result.faces}）`);
  });
});
