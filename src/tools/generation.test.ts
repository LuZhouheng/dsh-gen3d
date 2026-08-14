// src/tools/generation.ts 单测 —— 生成四件套、provider 状态、资产盘点/删除/
// 重命名、质量评分、凭证状态；mock 回退 + cache-first + 真实 provider 双路径。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureToolDeps, type Gen3dSidecar } from './common.js';
import {
  gen3dCredentialsStatus,
  gen3dDeleteAsset,
  gen3dImageTo3d,
  gen3dListAssets,
  gen3dProviderStatus,
  gen3dRefineMesh,
  gen3dRenameAsset,
  gen3dScoreQuality,
  gen3dTextTo3d,
  gen3dViewsTo3d,
} from './generation.js';
import { FakeProvider, glbBytes, makeStore, meshyResult, mockFetch, writeWorkspaceFile, type TempStore } from './test-helpers.js';

const EXEC = { signal: new AbortController().signal };

function factory(fake: FakeProvider) {
  return async (id: Parameters<NonNullable<Parameters<typeof configureToolDeps>[0]['providerFactory']>>[0]) => {
    expect(id).toBe(fake.id);
    return fake;
  };
}

describe('gen3d_text_to_3d', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('未配置 key → 确定性 mock 回退（usedMock: true，不调 provider）；同参数再跑命中缓存', async () => {
    let factoryCalls = 0;
    configureToolDeps({
      store: tmp.store,
      providerFactory: async (id) => {
        factoryCalls += 1;
        return new FakeProvider(id as 'meshy', false);
      },
    });
    const out = await gen3dTextTo3d.execute({ prompt: '一只猫', provider: 'meshy' }, EXEC);
    expect(out).toMatchObject({ ok: true, cacheHit: false, usedMock: true });
    expect((out as { manifest: Gen3dSidecar }).manifest.custom.providerMode).toBe('mock');
    expect(factoryCalls).toBe(1);

    const hit = await gen3dTextTo3d.execute({ prompt: '一只猫', provider: 'meshy' }, EXEC);
    expect(hit).toMatchObject({ ok: true, cacheHit: true, usedMock: true });
    expect(factoryCalls).toBe(1); // 缓存命中不构造 provider
  });

  it('Meshy 两阶段：preview → refine，meshyTaskRefs 与面数透传正确', async () => {
    const fake = new FakeProvider('meshy', true);
    fake.handlers.submitGeneration = (req) => {
      const isRefine = req.providerOptions?.mode === 'refine';
      return Promise.resolve({ provider: 'meshy', taskId: isRefine ? 'refine-1' : 'preview-1' });
    };
    fake.handlers.pollTask = (handle) =>
      Promise.resolve(
        meshyResult(handle.taskId, [
          { role: 'glb', format: 'glb', url: `https://cdn/${handle.taskId}.glb`, buffer: glbBytes(handle.taskId) },
          { role: 'thumbnail', format: 'png', url: `https://cdn/${handle.taskId}.png`, buffer: glbBytes(`p${handle.taskId}`) },
        ]),
      );
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });

    const out = await gen3dTextTo3d.execute({ prompt: '武士', provider: 'meshy', targetPolycount: 50000, assetName: 'samurai' }, EXEC);
    expect(out).toMatchObject({ ok: true, usedMock: false, cacheHit: false });
    const manifest = (out as { manifest: Gen3dSidecar }).manifest;
    expect(manifest.custom.meshyTaskRefs).toEqual({ previewTaskId: 'preview-1', resultTaskId: 'refine-1' });

    const submits = fake.calls.filter((c) => c.method === 'submitGeneration');
    expect(submits).toHaveLength(2);
    const [previewReq, refineReq] = submits.map((c) => c.args[0] as { prompt: string; providerOptions: Record<string, unknown> });
    expect(previewReq!.providerOptions.mode).toBeUndefined();
    expect(previewReq!.providerOptions.target_polycount).toBe(50000);
    expect(refineReq!.providerOptions).toMatchObject({ mode: 'refine', preview_task_id: 'preview-1', enable_pbr: true });
    // 落盘 + 侧文件
    expect(manifest.custom.assetSlot).toBe('characters');
    expect(manifest.dependencies.some((d) => d.kind === 'preview_image')).toBe(true);
  });

  it('Meshy enablePbr=false → 仅 preview 单阶段', async () => {
    const fake = new FakeProvider('meshy', true);
    fake.handlers.submitGeneration = () => Promise.resolve({ provider: 'meshy', taskId: 'preview-1' });
    fake.handlers.pollTask = () =>
      Promise.resolve(meshyResult('preview-1', [{ role: 'glb', format: 'glb', url: 'u', buffer: glbBytes('p') }]));
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });
    const out = await gen3dTextTo3d.execute({ prompt: '武士', provider: 'meshy', enablePbr: false }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const submits = fake.calls.filter((c) => c.method === 'submitGeneration');
    expect(submits).toHaveLength(1);
    const manifest = (out as { manifest: Gen3dSidecar }).manifest;
    expect(manifest.custom.meshyTaskRefs).toEqual({ previewTaskId: 'preview-1', resultTaskId: 'preview-1' });
  });

  it('prompt 缺失 → invalid_prompt 失败信封', async () => {
    const out = await gen3dTextTo3d.execute({}, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'invalid_args' });
  });
});

describe('gen3d_image_to_3d', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('URL 直填：透传给 provider 的 imageUrls', async () => {
    const fake = new FakeProvider('hunyuan3d', true);
    fake.handlers.submitGeneration = () => Promise.resolve({ provider: 'hunyuan3d', taskId: 'j1' });
    fake.handlers.pollTask = () =>
      Promise.resolve({ status: 'succeeded', downloads: { glb: 'https://cdn/m.glb' }, raw: {} });
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake), fetchImpl: mockFetch({ 'https://cdn/m.glb': glbBytes('m') }) });
    const out = await gen3dImageTo3d.execute({ imageUrl: 'https://img.example/cat.png', provider: 'hunyuan3d' }, EXEC);
    expect(out).toMatchObject({ ok: true, usedMock: false });
    const req = fake.calls.find((c) => c.method === 'submitGeneration')!.args[0] as { imageUrls?: string[] };
    expect(req.imageUrls).toEqual(['https://img.example/cat.png']);
  });

  it('base64：Meshy 走 data URI、Hunyuan 走 image_base64', async () => {
    const b64 = 'aGVsbG8='; // "hello"
    // Meshy
    const meshyFake = new FakeProvider('meshy', true);
    meshyFake.handlers.submitGeneration = () => Promise.resolve({ provider: 'meshy', taskId: 'p1' });
    meshyFake.handlers.pollTask = () =>
      Promise.resolve(meshyResult('p1', [{ role: 'glb', format: 'glb', url: 'u', buffer: glbBytes('g') }]));
    configureToolDeps({ store: tmp.store, providerFactory: factory(meshyFake) });
    const out = await gen3dImageTo3d.execute({ imageBase64: b64, provider: 'meshy' }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const meshyReq = meshyFake.calls.find((c) => c.method === 'submitGeneration')!.args[0] as { imageUrls?: string[] };
    expect(meshyReq.imageUrls![0]!).toMatch(/^data:image\/png;base64,aGVsbG8=$/);

    // Hunyuan：image_base64 进 providerOptions
    const hyFake = new FakeProvider('hunyuan3d', true);
    hyFake.handlers.submitGeneration = () => Promise.resolve({ provider: 'hunyuan3d', taskId: 'j1' });
    hyFake.handlers.pollTask = () =>
      Promise.resolve({ status: 'succeeded', downloads: { glb: 'https://cdn/m.glb' }, raw: {} });
    configureToolDeps({ store: tmp.store, providerFactory: factory(hyFake), fetchImpl: mockFetch({ 'https://cdn/m.glb': glbBytes('m') }) });
    const out2 = await gen3dImageTo3d.execute({ imageBase64: b64, provider: 'hunyuan3d' }, EXEC);
    expect(out2).toMatchObject({ ok: true });
    const hyReq = hyFake.calls.find((c) => c.method === 'submitGeneration')!.args[0] as { providerOptions: Record<string, unknown> };
    expect(hyReq.providerOptions.image_base64).toBe(b64);
  });

  it('base64 传给 Tripo/Rodin → not_supported；本地路径仅 Tripo 支持', async () => {
    const out = await gen3dImageTo3d.execute({ imageBase64: 'aGk=', provider: 'tripo3d' }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'not_supported' });
    const out2 = await gen3dImageTo3d.execute({ imageFilePath: '/tmp/x.png', provider: 'meshy' }, EXEC);
    expect(out2).toMatchObject({ ok: false, code: 'not_supported' });
  });

  it('Tripo 本地路径：读取字节 → uploadImage → file_token 进 providerOptions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-gen3d-img-'));
    writeWorkspaceFile(root, 'local.png', glbBytes('img'));
    const fake = new FakeProvider('tripo3d', true);
    fake.handlers.uploadImage = (data, filename) => {
      expect(filename).toBe('local.png');
      expect(data.byteLength).toBeGreaterThan(0);
      return Promise.resolve('token-1');
    };
    fake.handlers.submitGeneration = () => Promise.resolve({ provider: 'tripo3d', taskId: 't1' });
    fake.handlers.pollTask = () =>
      Promise.resolve({ status: 'succeeded', downloads: { glb: 'https://cdn/m.glb' }, raw: {} });
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake), fetchImpl: mockFetch({ 'https://cdn/m.glb': glbBytes('m') }) });
    const out = await gen3dImageTo3d.execute({ imageFilePath: join(root, 'local.png'), provider: 'tripo3d' }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const req = fake.calls.find((c) => c.method === 'submitGeneration')!.args[0] as { providerOptions: Record<string, unknown> };
    expect(req.providerOptions.file_token).toBe('token-1');
    rmSync(root, { recursive: true, force: true });
  });
});

describe('gen3d_views_to_3d', () => {
  it('Meshy 按 [前,后,左,右] 顺序提交；front 必填', async () => {
    const tmp = makeStore();
    configureToolDeps({ store: tmp.store });
    const fake = new FakeProvider('meshy', true);
    fake.handlers.submitGeneration = () => Promise.resolve({ provider: 'meshy', taskId: 'p1' });
    fake.handlers.pollTask = () =>
      Promise.resolve(meshyResult('p1', [{ role: 'glb', format: 'glb', url: 'u', buffer: glbBytes('g') }]));
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });
    const out = await gen3dViewsTo3d.execute(
      {
        views: { front_image_url: 'https://i/f.png', back_image_url: 'https://i/b.png', left_image_url: 'https://i/l.png', right_image_url: 'https://i/r.png' },
        provider: 'meshy',
      },
      EXEC,
    );
    expect(out).toMatchObject({ ok: true });
    const req = fake.calls.find((c) => c.method === 'submitGeneration')!.args[0] as { imageUrls?: string[] };
    expect(req.imageUrls).toEqual(['https://i/f.png', 'https://i/b.png', 'https://i/l.png', 'https://i/r.png']);
    configureToolDeps({});
    tmp.cleanup();
  });

  it('views 缺失 front → invalid_views', async () => {
    const out = await gen3dViewsTo3d.execute({ views: { back_image_url: 'https://i/b.png' } }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'invalid_views' });
  });
});

describe('gen3d_refine_mesh', () => {
  it('Meshy refine：mode=refine + preview_task_id 透传，mock 回退可用', async () => {
    const tmp = makeStore();
    configureToolDeps({ store: tmp.store });
    const fake = new FakeProvider('meshy', true);
    fake.handlers.submitGeneration = (req) => {
      expect(req.providerOptions!.mode).toBe('refine');
      expect(req.providerOptions!.preview_task_id).toBe('preview-9');
      return Promise.resolve({ provider: 'meshy', taskId: 'refine-9' });
    };
    fake.handlers.pollTask = () =>
      Promise.resolve(meshyResult('refine-9', [{ role: 'glb', format: 'glb', url: 'u', buffer: glbBytes('r') }]));
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });
    const out = await gen3dRefineMesh.execute({ previewTaskId: 'preview-9', texturePrompt: '加金属质感' }, EXEC);
    expect(out).toMatchObject({ ok: true, usedMock: false });
    const manifest = (out as { manifest: Gen3dSidecar }).manifest;
    expect(manifest.custom.meshyTaskRefs).toEqual({ previewTaskId: 'preview-9', resultTaskId: 'refine-9' });
    configureToolDeps({});
    tmp.cleanup();
  });
});

describe('资产盘点 / 删除 / 重命名', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  async function seedAsset(): Promise<string> {
    await tmp.store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: glbBytes('main'),
      sidecar: {
        dependencies: [{ path: 'hero.png', hash: 'sha256:abc', kind: 'preview_image' }],
        custom: {
          provider: 'meshy',
          providerMode: 'real',
          mode: 'text',
          readiness: { hasSourceMesh: true, rigged: false, animated: false },
          cacheKey: 'ck-1',
          userLabel: '英雄',
        },
      },
    });
    return 'assets/3d/characters/hero.glb';
  }

  it('list-assets：盘点 + provider 过滤', async () => {
    await seedAsset();
    const all = await gen3dListAssets.execute({}, EXEC);
    expect(all).toMatchObject({ ok: true, count: 1 });
    const filtered = await gen3dListAssets.execute({ provider: 'rodin' }, EXEC);
    expect(filtered).toMatchObject({ ok: true, count: 0 });
  });

  it('delete-asset：删除 + tombstone（缓存不再命中）', async () => {
    const assetPath = await seedAsset();
    await tmp.store.putCache('ck-1', assetPath);
    const del = await gen3dDeleteAsset.execute({ assetPath }, EXEC);
    expect(del).toMatchObject({ ok: true, deleted: true, tombstoned: true });
    const cache = await tmp.store.getCacheEntry('ck-1');
    expect(cache?.status).toBe('tombstone');
  });

  it('rename-asset：userLabel 写入 sidecar，磁盘路径不变', async () => {
    const assetPath = await seedAsset();
    const out = await gen3dRenameAsset.execute({ assetPath, label: '新名字' }, EXEC);
    expect(out).toMatchObject({ ok: true, userLabel: '新名字' });
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar?.custom.userLabel).toBe('新名字');
  });
});

describe('gen3d_score_quality', () => {
  it('五维评分：objective + manual 混合加权并落 sidecar', async () => {
    const tmp = makeStore();
    configureToolDeps({ store: tmp.store });
    await tmp.store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: glbBytes('main'),
      sidecar: {
        custom: { provider: 'meshy', providerMode: 'real', mode: 'text', readiness: { hasSourceMesh: true, rigged: false, animated: false } },
      },
    });
    const out = await gen3dScoreQuality.execute(
      {
        assetPath: 'assets/3d/characters/hero.glb',
        objective: { geometry: 80, topology: 60 },
        manual: { texture: 90, prompt_fidelity: 70, notes: '不错' },
      },
      EXEC,
    );
    expect(out).toMatchObject({ ok: true, usedMock: false });
    const sidecar = await tmp.store.readSidecar('assets/3d/characters/hero.glb');
    const q = sidecar!.custom.quality!;
    expect(q.geometry).toEqual({ value: 80, source: 'auto' });
    expect(q.texture).toEqual({ value: 90, source: 'manual' });
    expect(q.method).toBe('mixed');
    expect(q.total).toBeGreaterThan(0);
    expect(q.notes).toBe('不错');
    configureToolDeps({});
    tmp.cleanup();
  });
});

describe('provider / 凭证状态', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = originalEnv;
    configureToolDeps({});
  });

  it('provider-status：配置态正确（meshy 已配置 → real；其余 mock）', async () => {
    process.env.MESHY_API_KEY = 'msy-test-key-1234567890';
    const out = await gen3dProviderStatus.execute({}, EXEC);
    expect(out).toMatchObject({ ok: true, quotaSafe: false });
    const providers = (out as { providers: { providerId: string; mode: string }[] }).providers;
    expect(providers.find((p) => p.providerId === 'meshy')!.mode).toBe('real');
    expect(providers.find((p) => p.providerId === 'rodin')!.mode).toBe('mock');
  });

  it('credentials-status：掩码展示，绝不输出完整 key', async () => {
    process.env.MESHY_API_KEY = 'msy-1234567890abcdef';
    const out = await gen3dCredentialsStatus.execute({}, EXEC);
    const text = JSON.stringify(out);
    expect(text).not.toContain('msy-1234567890abcdef');
    expect(text).toContain('…');
    const providers = (out as { providers: { providerId: string; configured: boolean; source: string | null; keyMasked?: string }[] }).providers;
    const meshy = providers.find((p) => p.providerId === 'meshy')!;
    expect(meshy.configured).toBe(true);
    expect(meshy.source).toBe('env');
    expect(meshy.keyMasked).toBe('msy-…cdef');
  });
});
