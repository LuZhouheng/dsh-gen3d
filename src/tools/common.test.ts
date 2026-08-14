// src/tools/common.ts 单测 —— provider 工厂、cache-first、mock 回退、错误包装、
// DSL 校验、派生文件追加。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProviderError } from '../providers/types.js';
import { makeCacheKey } from '../legacy/shared/catalog.js';
import { configureToolDeps, generateCacheFirst, mockProviderResult, resolveProviderOrMock, toToolFailure, ToolError, createProvider, appendDerivedFiles, clearRigAndMotions, persistProviderResult, defineGen3dTool, type GenerationCtx, type ToolProviderResult } from './common.js';
import { FakeProvider, glbBytes, makeStore } from './test-helpers.js';

describe('createProvider 工厂', () => {
  it('四家 provider 都能构造（真实类，无网络）', async () => {
    for (const id of ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'] as const) {
      const p = await createProvider(id, { fetchImpl: async () => { throw new Error('no network'); } });
      expect(p.id).toBe(id);
      expect(typeof p.isConfigured).toBe('function');
    }
  });
});

describe('resolveProviderOrMock', () => {
  afterEach(() => configureToolDeps({}));

  it('未配置 → mock 回退（provider: null, usedMock: true）', async () => {
    configureToolDeps({ providerFactory: async (id) => new FakeProvider(id, false) });
    const { provider, usedMock } = await resolveProviderOrMock('meshy');
    expect(provider).toBeNull();
    expect(usedMock).toBe(true);
  });

  it('已配置 → 返回实例', async () => {
    const fake = new FakeProvider('meshy', true);
    configureToolDeps({ providerFactory: async () => fake });
    const { provider, usedMock } = await resolveProviderOrMock('meshy');
    expect(provider).toBe(fake);
    expect(usedMock).toBe(false);
  });
});

describe('mockProviderResult', () => {
  it('确定性 mock：providerMode=mock，打标请求的 provider/mode', () => {
    const a = mockProviderResult('hunyuan3d', 'text', '一只猫');
    const b = mockProviderResult('hunyuan3d', 'text', '一只猫');
    expect(a.providerMode).toBe('mock');
    expect(a.provider).toBe('hunyuan3d');
    expect(a.mode).toBe('text');
    expect(a.files.some((f) => f.role === 'source_mesh' && f.format === 'glb')).toBe(true);
    expect(a.sourceJobId).toBeNull();
    // 确定性：同输入同字节
    expect(Buffer.from(a.files[0]!.data).equals(Buffer.from(b.files[0]!.data))).toBe(true);
  });
});

describe('generateCacheFirst（cache-first 语义）', () => {
  let ctx: GenerationCtx;
  let produceCount: number;
  let result: ToolProviderResult;
  let tmp: ReturnType<typeof makeStore>;

  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
    ctx = {
      provider: 'meshy',
      mode: 'text',
      cacheKey: makeCacheKey('meshy', 'text', { assetSlot: 'characters', prompt: '一只猫', faceCount: 30000, enablePbr: true }),
      slot: 'characters',
      assetName: '猫',
      prompt: '一只猫',
    };
    produceCount = 0;
    result = mockProviderResult('meshy', 'text', '一只猫');
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('未命中：调 produce → 落盘 → 成功后才写 cache', async () => {
    const out = await generateCacheFirst(ctx, async () => {
      produceCount += 1;
      return result;
    });
    expect(out.cacheHit).toBe(false);
    expect(out.usedMock).toBe(true);
    expect(out.assetPath).toBe('assets/3d/characters/猫.glb');
    expect(out.manifest.custom.cacheKey).toBe(ctx.cacheKey);
    expect(out.manifest.custom.providerMode).toBe('mock');
    // 侧文件（预览 png）落盘且进 dependencies
    expect(out.manifest.dependencies.some((d) => d.kind === 'preview_image')).toBe(true);
    expect(produceCount).toBe(1);
    // 二次调用：缓存命中，不调 produce
    const hit = await generateCacheFirst(ctx, async () => {
      produceCount += 1;
      return result;
    });
    expect(hit.cacheHit).toBe(true);
    expect(hit.assetPath).toBe(out.assetPath);
    expect(hit.usedMock).toBe(true); // 命中时 usedMock 取既有资产的 providerMode
    expect(produceCount).toBe(1);
  });

  it('tombstone 后视为未命中，重新生成（不复活已删资产）', async () => {
    await generateCacheFirst(ctx, async () => result);
    // 对同 key 打 tombstone → 命中失效
    await tmp.store.tombstoneCache(ctx.cacheKey);
    const out = await generateCacheFirst(ctx, async () => {
      produceCount += 1;
      return result;
    });
    expect(out.cacheHit).toBe(false);
    expect(produceCount).toBe(1);
  });

  it('缓存指向已删文件（无 tombstone）→ 落空重生成', async () => {
    await generateCacheFirst(ctx, async () => result);
    const tmp = makeStore();
    configureToolDeps({ store: tmp.store });
    // 拷贝缓存行但让资产消失：写 live 条目指向不存在的路径
    await tmp.store.putCache(ctx.cacheKey, 'assets/3d/characters/不存在.glb');
    const out = await generateCacheFirst(ctx, async () => {
      produceCount += 1;
      return result;
    });
    expect(out.cacheHit).toBe(false);
    expect(produceCount).toBe(1);
  });
});

describe('persistProviderResult', () => {
  it('主 GLB + 侧文件 + sidecar 落盘；非 glb 的 source_mesh 侧文件不落盘（沿用 legacy）', async () => {
    const tmp = makeStore();
    configureToolDeps({ store: tmp.store });
    const result: ToolProviderResult = {
      provider: 'hunyuan3d',
      mode: 'image',
      providerMode: 'real',
      sourceJobId: 'job-1',
      prompt: null,
      files: [
        { role: 'source_mesh', format: 'glb', data: glbBytes('main') },
        { role: 'source_mesh', format: 'fbx', data: glbBytes('fbx') }, // 应跳过
        { role: 'preview_image', format: 'png', data: glbBytes('prev') },
        { role: 'texture', format: 'png', data: glbBytes('tex') },
      ],
    };
    const { assetPath, manifest } = await persistProviderResult(result, {
      provider: 'hunyuan3d',
      mode: 'image',
      cacheKey: 'k1',
      slot: 'characters',
      assetName: 'hero',
      prompt: null,
    });
    expect(assetPath).toBe('assets/3d/characters/hero.glb');
    const kinds = manifest.dependencies.map((d) => d.kind).sort();
    expect(kinds).toEqual(['preview_image', 'texture']);
    // 磁盘上确实有侧文件
    const { readFileSync, existsSync } = await import('node:fs');
    const root = tmp.root;
    expect(existsSync(`${root}/assets/3d/characters/hero.png`)).toBe(true);
    expect(existsSync(`${root}/assets/3d/characters/hero.texture.png`)).toBe(true);
    expect(existsSync(`${root}/assets/3d/characters/hero.source_mesh.fbx`)).toBe(false);
    void readFileSync;
    tmp.cleanup();
  });
  afterEach(() => configureToolDeps({}));
});

describe('appendDerivedFiles / clearRigAndMotions', () => {
  it('绑骨追加：dependencies 增加、readiness 翻转、rig 链写入', async () => {
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
    const sidecar = await appendDerivedFiles({
      assetPath: 'assets/3d/characters/hero.glb',
      files: [
        { role: 'rigged_model', format: 'glb', data: glbBytes('rig') },
        { role: 'animated_model', format: 'glb', data: glbBytes('walk'), motionRef: { system: 'meshy', id: -1, label: '走路（免费）' } },
      ],
      skeleton: { hasSkeleton: true, skeletonProfile: 'humanoid', animationInputReady: true },
      rigChain: { rigProvider: 'meshy', rigTaskId: 'rig-1', rigType: null, rigExpiresAt: 1234567890 },
    });
    expect(sidecar.custom.readiness).toEqual({ hasSourceMesh: true, rigged: true, animated: true });
    expect(sidecar.custom.rig).toMatchObject({ rigProvider: 'meshy', rigTaskId: 'rig-1' });
    const dep = sidecar.dependencies.find((d) => d.kind === 'animated_model')!;
    expect(dep.path).toBe('hero.animated_model.motion-meshy--1.glb');
    expect(dep.motionRef).toEqual({ system: 'meshy', id: -1, label: '走路（免费）' });
    // 幂等追加同 motion：覆盖而非重复
    await appendDerivedFiles({
      assetPath: 'assets/3d/characters/hero.glb',
      files: [{ role: 'animated_model', format: 'glb', data: glbBytes('walk2'), motionRef: { system: 'meshy', id: -1, label: '走路（免费）' } }],
    });
    const after = await tmp.store.readSidecar('assets/3d/characters/hero.glb');
    expect(after!.dependencies.filter((d) => d.kind === 'animated_model')).toHaveLength(1);
    tmp.cleanup();
  });

  it('clearRigAndMotions：删除派生文件与记录，rig 链清除', async () => {
    const tmp = makeStore();
    configureToolDeps({ store: tmp.store });
    await tmp.store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: glbBytes('main'),
      sidecar: {
        dependencies: [],
        custom: { provider: 'meshy', providerMode: 'real', mode: 'text', readiness: { hasSourceMesh: true, rigged: false, animated: false } },
      },
    });
    await appendDerivedFiles({
      assetPath: 'assets/3d/characters/hero.glb',
      files: [{ role: 'rigged_model', format: 'glb', data: glbBytes('rig') }],
      skeleton: { hasSkeleton: true, skeletonProfile: 'humanoid', animationInputReady: true },
      rigChain: { rigProvider: 'meshy', rigTaskId: 'rig-1', rigType: null, rigExpiresAt: null },
    });
    const cleared = await clearRigAndMotions('assets/3d/characters/hero.glb');
    expect(cleared.custom.rig).toBeUndefined();
    expect(cleared.custom.readiness.rigged).toBe(false);
    expect(cleared.dependencies.some((d) => d.kind === 'rigged_model')).toBe(false);
    const { existsSync } = await import('node:fs');
    expect(existsSync(`${tmp.root}/assets/3d/characters/hero.rigged_model.glb`)).toBe(false);
    tmp.cleanup();
  });
  afterEach(() => configureToolDeps({}));
});

describe('错误包装', () => {
  it('ProviderError → 结构化失败信封（保留 provider_* 错误码）', () => {
    const err = new ProviderError({ code: 'provider_rate_limited', message: '限流', httpStatus: 429 });
    expect(toToolFailure(err)).toEqual({ ok: false, code: 'provider_rate_limited', message: '限流', retryable: true });
  });

  it('ToolError → 信封；未知错误 → internal_error', () => {
    expect(toToolFailure(new ToolError('asset_not_found', 'x'))).toMatchObject({ ok: false, code: 'asset_not_found' });
    expect(toToolFailure(new Error('boom'))).toMatchObject({ ok: false, code: 'internal_error' });
  });
});

describe('defineGen3dTool', () => {
  it('必填参数缺失 → invalid_args 失败信封；业务抛错 → 信封；成功原样返回', async () => {
    const tool = defineGen3dTool({
      name: 't_test',
      description: 'x',
      parameters: { p: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true } },
      async run(args) {
        if (args.p === 'boom') throw new ToolError('bad', '业务错误');
        return { ok: true, p: args.p };
      },
    });
    const exec = { signal: new AbortController().signal };
    const missing = await tool.execute({}, exec);
    expect(missing).toMatchObject({ ok: false, code: 'invalid_args' });
    const boom = await tool.execute({ p: 'boom' }, exec);
    expect(boom).toMatchObject({ ok: false, code: 'bad' });
    const fine = await tool.execute({ p: 'hi' }, exec);
    expect(fine).toEqual({ ok: true, p: 'hi' });
    // render 可用
    expect(tool.output.render({}, { ok: true })[0]!.type).toBe('text');
    expect(typeof tool.name).toBe('string');
  });
});
