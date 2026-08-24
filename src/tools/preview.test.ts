// gen3d_render_preview 单测 —— mock 资产全链路：
// 1. 确定性 mock 角色 GLB（catalog 新字节）→ 渲染 → PNG/GIF 落盘
//    （<workspace>/.dsh-gen3d/previews/<stem>-contact.png / -turntable.gif）；
// 2. attachments 注入 fake：attached=true，返回附件引用，render 输出 [text,image,image]；
// 3. 占位字节 GLB（旧 36B mock 形状）→ asset_unrenderable 失败信封；
// 4. 参数校验：非法 style / out-of-range 数值 → invalid_args；
// 5. 资产解析：名字 / 相对路径 / 用户标签；不存在 → asset_not_found；
// 6. 附件服务失败不致命：attached=false、文件仍在。
//
// 渲染尺寸用小值（如 160）保证测试速度；不调 provider、零网络。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMockCharacterGlb } from '../legacy/shared/mock-mesh.js';
import { generateMeshyTextMockResult } from '../legacy/shared/catalog.js';
import { configureToolDeps, ToolError } from './common.js';
import { gen3dRenderPreview, resolveAssetPath, setPreviewAttachmentStore } from './preview.js';
import { glbBytes, makeStore, writeWorkspaceFile } from './test-helpers.js';

const EXEC = { signal: new AbortController().signal };

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const GIF_MAGIC = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];

function fakeAttachment(id = 'att-1') {
  return {
    saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => ({
      attachmentId: `${id}-${input.name}`,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
      name: input.name,
    }),
  };
}

let tmp: ReturnType<typeof makeStore>;

beforeEach(() => {
  tmp = makeStore();
  configureToolDeps({ store: tmp.store });
});

afterEach(() => {
  configureToolDeps({});
  setPreviewAttachmentStore(null);
  tmp.cleanup();
});

async function saveMockAsset(name = 'hero', seed = 'mock-seed'): Promise<string> {
  const saved = await tmp.store.saveAsset({
    slot: 'characters',
    fileName: `${name}.glb`,
    data: buildMockCharacterGlb(seed),
    sidecar: {
      custom: {
        provider: 'meshy',
        providerMode: 'mock',
        mode: 'text',
        sourceJobId: 'job-1',
        prompt: 'test',
        sourceInputAssetPaths: [],
        readiness: { hasSourceMesh: true, rigged: false, animated: false },
      },
    },
  });
  return saved.assetPath;
}

describe('gen3d_render_preview', () => {
  it('mock 资产全链路：落盘 PNG/GIF + attached=true + 规范值齐备', async () => {
    await saveMockAsset('hero');
    setPreviewAttachmentStore(fakeAttachment());
    const out = (await gen3dRenderPreview.execute(
      { asset: 'hero', angles: 4, size: 256, style: 'shaded', background: 'dark' },
      EXEC,
    )) as { ok: boolean; assetPath: string; faces: number; attached: boolean; previewPng: { name?: string } | null; previewGif: { name?: string } | null };

    expect(out).toMatchObject({
      ok: true,
      assetPath: 'assets/3d/characters/hero.glb',
      attached: true,
      angles: 4,
      size: 256,
      style: 'shaded',
    });
    expect(out.faces).toBeGreaterThan(1000); // mock 角色 1–3k 面
    expect(out.previewPng?.name).toBe('hero-contact.png');
    expect(out.previewGif?.name).toBe('hero-turntable.gif');

    const dir = join(tmp.root, '.dsh-gen3d', 'previews');
    const png = readFileSync(join(dir, 'hero-contact.png'));
    const gif = readFileSync(join(dir, 'hero-turntable.gif'));
    expect([png[0], png[1], png[2], png[3]]).toEqual(PNG_MAGIC);
    expect([gif[0], gif[1], gif[2], gif[3], gif[4], gif[5]]).toEqual(GIF_MAGIC);
    expect(png.byteLength).toBeGreaterThan(500);
    expect(gif.byteLength).toBeGreaterThan(500);
  });

  it('render 输出 [text, image, image]：text 自足（路径/面数/视角数/文件相对路径）', async () => {
    await saveMockAsset('hero');
    setPreviewAttachmentStore(fakeAttachment());
    const out = (await gen3dRenderPreview.execute(
      { asset: 'hero', angles: 4, size: 256 },
      EXEC,
    )) as { previewPng: unknown; previewGif: unknown };
    const blocks = gen3dRenderPreview.output.render({ asset: 'hero' }, out) as {
      type: string;
      text?: string;
      attachment?: { attachmentId?: string };
    }[];
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.type).toBe('text');
    expect(blocks[0]!.text).toContain('hero.glb');
    expect(blocks[0]!.text).toContain('模型面数：1032'); // 面数在文本里（确定性 mock）
    expect(blocks[0]!.text).toContain('视角数：4');
    expect(blocks[0]!.text).toContain('.dsh-gen3d/previews/hero-contact.png');
    expect(blocks[0]!.text).toContain('.dsh-gen3d/previews/hero-turntable.gif');
    expect(blocks[1]).toMatchObject({ type: 'image' });
    expect(blocks[2]).toMatchObject({ type: 'image' });
  });

  it('presentationMeta 递文件路径（web keyed 卡片摄取面，与规范值里的附件引用分离）', async () => {
    await saveMockAsset('hero');
    setPreviewAttachmentStore(fakeAttachment());
    const out = (await gen3dRenderPreview.execute(
      { asset: 'hero', angles: 4, size: 256 },
      EXEC,
    )) as Record<string, unknown>;
    const meta = gen3dRenderPreview.output.presentationMeta?.({ asset: 'hero' }, out);
    expect(meta).toMatchObject({
      assetPath: 'assets/3d/characters/hero.glb',
      previewPng: '.dsh-gen3d/previews/hero-contact.png',
      previewGif: '.dsh-gen3d/previews/hero-turntable.gif',
      angles: 4,
      size: 256,
      style: 'shaded',
      attached: true,
    });
    expect((meta as { faces: number }).faces).toBeGreaterThan(1000);
  });

  it('附件服务失败不致命：attached=false，图片文件仍在', async () => {
    await saveMockAsset('hero');
    setPreviewAttachmentStore({
      saveImage: async () => {
        throw new Error('attachment full');
      },
    });
    const out = (await gen3dRenderPreview.execute({ asset: 'hero', size: 256 }, EXEC)) as {
      ok: boolean;
      attached: boolean;
      previewPng: unknown;
      previewGif: unknown;
    };
    expect(out.ok).toBe(true);
    expect(out.attached).toBe(false);
    expect(out.previewPng).toBeNull();
    expect(out.previewGif).toBeNull();
    expect(existsSync(join(tmp.root, '.dsh-gen3d', 'previews', 'hero-contact.png'))).toBe(true);
  });

  it('占位字节 GLB（旧 mock 形状）→ asset_unrenderable', async () => {
    const tmp2 = makeStore();
    configureToolDeps({ store: tmp2.store });
    writeWorkspaceFile(tmp2.root, 'assets/3d/characters/legacy.glb', glbBytes('old'));
    const out = (await gen3dRenderPreview.execute(
      { asset: 'assets/3d/characters/legacy.glb', size: 256 },
      EXEC,
    )) as { ok: boolean; code?: string };
    expect(out.ok).toBe(false);
    expect(out.code).toBe('asset_unrenderable');
    expect(existsSync(join(tmp2.root, '.dsh-gen3d', 'previews'))).toBe(false);
    tmp2.cleanup();
  });

  it('参数校验：非法 style / 数值越界 → invalid_args', async () => {
    const out1 = (await gen3dRenderPreview.execute({ asset: 'x', style: 'holographic' }, EXEC)) as {
      ok: boolean;
      code?: string;
    };
    expect(out1.code).toBe('invalid_args');
    const out2 = (await gen3dRenderPreview.execute({ asset: 'x', size: 5000 }, EXEC)) as {
      ok: boolean;
      code?: string;
    };
    expect(out2.code).toBe('invalid_args');
    const out3 = (await gen3dRenderPreview.execute({ asset: 'x', angles: 2 }, EXEC)) as {
      ok: boolean;
      code?: string;
    };
    expect(out3.code).toBe('invalid_args');
  });

  it('资产解析：名字 / 相对路径 / userLabel；不存在 → asset_not_found', async () => {
    const path = await saveMockAsset('hero');
    expect(await resolveAssetPath(tmp.store, 'hero')).toBe(path);
    expect(await resolveAssetPath(tmp.store, 'assets/3d/characters/hero.glb')).toBe(path);
    await expect(resolveAssetPath(tmp.store, 'missing')).rejects.toThrowError(ToolError);
    await expect(resolveAssetPath(tmp.store, 'missing')).rejects.toMatchObject({ code: 'asset_not_found' });
  });

  it('空字节 GLB → asset_unrenderable', async () => {
    writeWorkspaceFile(tmp.root, 'assets/3d/characters/empty.glb', new Uint8Array(0));
    const out = (await gen3dRenderPreview.execute(
      { asset: 'assets/3d/characters/empty.glb', size: 256 },
      EXEC,
    )) as { ok: boolean; code?: string };
    expect(out.ok).toBe(false);
    expect(out.code).toBe('asset_unrenderable');
  });
});

describe('mock 字节确定性（catalog → buildMockCharacterGlb）', () => {
  it('同一 cacheKey 两次生成字节完全相同；不同 seed 字节不同', () => {
    const a = generateMeshyTextMockResult({ prompt: '一只猫' });
    const b = generateMeshyTextMockResult({ prompt: '一只猫' });
    const glbA = a.result.files.find((f) => f.role === 'source_mesh' && f.format === 'glb')!.data;
    const glbB = b.result.files.find((f) => f.role === 'source_mesh' && f.format === 'glb')!.data;
    expect(Buffer.from(glbA).equals(Buffer.from(glbB))).toBe(true);
    expect(glbA.byteLength).toBeGreaterThan(1000); // 真几何，不再是 36B 占位

    const c = generateMeshyTextMockResult({ prompt: '一只狗' });
    const glbC = c.result.files.find((f) => f.role === 'source_mesh' && f.format === 'glb')!.data;
    expect(Buffer.from(glbA).equals(Buffer.from(glbC))).toBe(false);
  });

  it('mock GLB 能被 NodeIO 读回（可渲染前提）', async () => {
    const { NodeIO } = await import('@gltf-transform/core');
    const bytes = buildMockCharacterGlb('readable-seed');
    const doc = await new NodeIO().readBinary(bytes);
    const root = doc.getRoot();
    expect(root.listMeshes()).toHaveLength(1);
    expect(root.listMaterials()).toHaveLength(1);
    const prim = root.listMeshes()[0]!.listPrimitives()[0]!;
    expect(prim.getAttribute('POSITION')).toBeDefined();
    expect(prim.getAttribute('NORMAL')).toBeDefined();
    expect(prim.getIndices()).toBeDefined();
  });
});

