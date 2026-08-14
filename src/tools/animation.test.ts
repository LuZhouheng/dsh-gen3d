// src/tools/animation.ts 单测 —— auto-rig / apply-motion 的 rig 分发路由、
// rig_expired 判定、幂等、mock 回退；list-motions 目录查询。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureToolDeps } from './common.js';
import { gen3dApplyMotion, gen3dAutoRig, gen3dListMotions } from './animation.js';
import { FakeProvider, glbBytes, makeStore, meshyResult, mockFetch, type TempStore } from './test-helpers.js';

const EXEC = { signal: new AbortController().signal };

const FUTURE = Date.now() + 3 * 24 * 3600_000;
const PAST = Date.now() - 1000;

function factory(fake: FakeProvider) {
  return async (id: string) => {
    expect(id).toBe(fake.id);
    return fake;
  };
}

/** auto 路由会预扫描 meshy→hunyuan3d→tripo3d：目标 id 返回 fake，其余返回未配置 fake。 */
function factoryWithFallback(fake: FakeProvider) {
  return async (id: string) => (id === fake.id ? fake : new FakeProvider(id as never, false));
}

/** 落一个带 meshyTaskRefs 的源资产（生成产物，未绑骨）。 */
async function seedMeshAsset(tmp: TempStore): Promise<string> {
  const assetPath = 'assets/3d/characters/hero.glb';
  await tmp.store.saveAsset({
    slot: 'characters',
    fileName: 'hero.glb',
    data: glbBytes('main'),
    sidecar: {
      custom: {
        provider: 'meshy',
        providerMode: 'real',
        mode: 'text',
        readiness: { hasSourceMesh: true, rigged: false, animated: false },
        meshyTaskRefs: { previewTaskId: 'preview-1', resultTaskId: 'mesh-task-1' },
      },
    },
  });
  return assetPath;
}

/** 落一个已绑骨的资产（rig 链可配置）。 */
async function seedRiggedAsset(
  tmp: TempStore,
  rig: { rigProvider: string; rigTaskId: string; rigExpiresAt: number | null },
): Promise<string> {
  const assetPath = await seedMeshAsset(tmp);
  await tmp.store.updateSidecar(assetPath, (s) => ({
    ...s,
    dependencies: [{ path: 'hero.rigged_model.glb', hash: 'sha256:r', kind: 'rigged_model', hasSkeleton: true, skeletonProfile: 'humanoid', animationInputReady: true }],
    custom: {
      ...s.custom,
      readiness: { hasSourceMesh: true, rigged: true, animated: false },
      rig: { rigProvider: rig.rigProvider as never, rigTaskId: rig.rigTaskId, rigType: null, rigExpiresAt: rig.rigExpiresAt },
    },
  }));
  return assetPath;
}

/** Meshy rig 任务结果（rigged GLB/FBX + 免费 walk/run）。 */
function rigTaskResult(taskId: string): ReturnType<typeof meshyResult> {
  return meshyResult(taskId, [
    { role: 'rigged_character_glb', format: 'glb', url: `u/${taskId}.glb`, buffer: glbBytes('rg') },
    { role: 'rigged_character_fbx', format: 'fbx', url: `u/${taskId}.fbx`, buffer: glbBytes('rf') },
  ], {
    basicAnimations: [
      { category: 'walking', files: [{ role: 'walking_glb', format: 'glb', url: `u/${taskId}-w.glb`, buffer: glbBytes('w') }] },
    ],
    expiresAtMs: FUTURE,
  });
}

describe('gen3d_auto_rig', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('Meshy 真实绑骨：input_task_id 直传（无 COS）、rig 链 / readiness / 免费片段落盘', async () => {
    const assetPath = await seedMeshAsset(tmp);
    const fake = new FakeProvider('meshy', true);
    fake.handlers.getBalance = () => Promise.resolve({ balance: 100 });
    fake.handlers.submitRig = (req) => {
      expect((req.providerOptions as Record<string, unknown>).input_task_id).toBe('mesh-task-1');
      return Promise.resolve({ provider: 'meshy', taskId: 'rig-1' });
    };
    fake.handlers.pollTask = (handle) => Promise.resolve(rigTaskResult(handle.taskId));
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });

    const out = await gen3dAutoRig.execute({ assetPath, rigProvider: 'meshy', heightMeters: 1.8 }, EXEC);
    expect(out).toMatchObject({ ok: true, usedMock: false });
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.custom.readiness).toEqual({ hasSourceMesh: true, rigged: true, animated: true });
    expect(sidecar!.custom.rig).toMatchObject({ rigProvider: 'meshy', rigTaskId: 'rig-1', rigExpiresAt: FUTURE });
    expect(sidecar!.dependencies.some((d) => d.kind === 'rigged_model' && d.path.endsWith('.glb'))).toBe(true);
    expect(sidecar!.dependencies.some((d) => d.kind === 'animated_model' && d.motionRef?.id === -1)).toBe(true);
    // 余额预检被调用
    expect(fake.calls.some((c) => c.method === 'getBalance')).toBe(true);
  });

  it('幂等：已绑骨且未 force → 直接返回，不调 provider', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'meshy', rigTaskId: 'rig-x', rigExpiresAt: FUTURE });
    const fake = new FakeProvider('meshy', true);
    fake.handlers.submitRig = () => Promise.resolve({ provider: 'meshy', taskId: 'rig-2' });
    fake.handlers.pollTask = () => Promise.resolve(rigTaskResult('rig-2'));
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });
    const out = await gen3dAutoRig.execute({ assetPath }, EXEC);
    expect(out).toMatchObject({ ok: true, usedMock: false });
    expect(fake.calls.filter((c) => c.method === 'submitRig')).toHaveLength(0);
  });

  it('force=true：清除旧绑骨与动作后重跑', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'meshy', rigTaskId: 'rig-old', rigExpiresAt: FUTURE });
    const fake = new FakeProvider('meshy', true);
    fake.handlers.getBalance = () => Promise.resolve({ balance: 100 });
    fake.handlers.submitRig = () => Promise.resolve({ provider: 'meshy', taskId: 'rig-new' });
    fake.handlers.pollTask = () => Promise.resolve(rigTaskResult('rig-new'));
    configureToolDeps({ store: tmp.store, providerFactory: factoryWithFallback(fake) });
    const out = await gen3dAutoRig.execute({ assetPath, force: true }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.custom.rig?.rigTaskId).toBe('rig-new');
  });

  it('未配置 key → mock 绑骨（usedMock: true，rigTaskId=mock-rig:…）', async () => {
    const assetPath = await seedMeshAsset(tmp);
    configureToolDeps({
      store: tmp.store,
      providerFactory: async (id) => new FakeProvider(id as 'meshy', false),
    });
    const out = await gen3dAutoRig.execute({ assetPath }, EXEC);
    expect(out).toMatchObject({ ok: true, usedMock: true });
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.custom.rig?.rigTaskId).toBe(`mock-rig:${assetPath}`);
    expect(sidecar!.custom.rig?.rigType).toBe('mock');
  });

  it('hunyuan3d 路由缺 sourceUrl → missing_source_url', async () => {
    const assetPath = await seedMeshAsset(tmp);
    const fake = new FakeProvider('hunyuan3d', true);
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });
    const out = await gen3dAutoRig.execute({ assetPath, rigProvider: 'hunyuan3d' }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'missing_source_url' });
  });

  it('hunyuan3d 路由带 sourceUrl：submitRig fileType=GLB', async () => {
    const assetPath = await seedMeshAsset(tmp);
    const fake = new FakeProvider('hunyuan3d', true);
    fake.handlers.submitRig = (req) => {
      expect(req.assetUrl).toBe('https://cdn/hero.glb');
      return Promise.resolve({ provider: 'hunyuan3d', taskId: 'hy-rig-1' });
    };
    fake.handlers.pollTask = () =>
      Promise.resolve({ status: 'succeeded', downloads: { glb: 'https://cdn/r.glb', fbx: 'https://cdn/r.fbx' }, raw: {} });
    configureToolDeps({
      store: tmp.store,
      providerFactory: factory(fake),
      fetchImpl: mockFetch({ 'https://cdn/r.glb': glbBytes('r'), 'https://cdn/r.fbx': glbBytes('rf') }),
    });
    const out = await gen3dAutoRig.execute({ assetPath, rigProvider: 'hunyuan3d', sourceUrl: 'https://cdn/hero.glb' }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.custom.rig?.rigProvider).toBe('hunyuan3d');
  });

  it('tripo3d 路由：非 tripo3d 资产无任务 id → missing_input_task', async () => {
    const assetPath = await seedMeshAsset(tmp);
    const fake = new FakeProvider('tripo3d', true);
    fake.handlers.submitRig = () => Promise.resolve({ provider: 'tripo3d', taskId: 't-rig-1' });
    fake.handlers.pollTask = () =>
      Promise.resolve({ status: 'succeeded', downloads: { glb: 'https://cdn/t.glb' }, raw: {} });
    configureToolDeps({
      store: tmp.store,
      providerFactory: factory(fake),
      fetchImpl: mockFetch({ 'https://cdn/t.glb': glbBytes('t') }),
    });
    const out = await gen3dAutoRig.execute({ assetPath, rigProvider: 'tripo3d' }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'missing_input_task' });
  });
});

describe('gen3d_apply_motion', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('Meshy 路由：actionId + rig_task_id 分发，animated_model 幂等追加', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'meshy', rigTaskId: 'rig-1', rigExpiresAt: FUTURE });
    const fake = new FakeProvider('meshy', true);
    fake.handlers.getBalance = () => Promise.resolve({ balance: 50 });
    fake.handlers.submitAnimation = (req) => {
      expect(req.rigTaskId).toBe('rig-1');
      expect(req.actionId).toBe(101);
      return Promise.resolve({ provider: 'meshy', taskId: 'anim-1' });
    };
    fake.handlers.pollTask = () =>
      Promise.resolve(
        meshyResult('anim-1', [
          { role: 'animation_glb', format: 'glb', url: 'u/a.glb', buffer: glbBytes('a') },
          { role: 'animation_fbx', format: 'fbx', url: 'u/a.fbx', buffer: glbBytes('af') },
        ]),
      );
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });

    const out = await gen3dApplyMotion.execute({ assetPath, actionId: 101, label: 'Walk' }, EXEC);
    expect(out).toMatchObject({ ok: true, usedMock: false });
    const sidecar = await tmp.store.readSidecar(assetPath);
    const animDeps = sidecar!.dependencies.filter((d) => d.kind === 'animated_model');
    expect(animDeps).toHaveLength(2);
    expect(animDeps[0]!.motionRef).toEqual({ system: 'meshy', id: 101, label: 'Walk' });
    expect(animDeps[0]!.path).toMatch(/motion-meshy-101/);

    // 同一动作幂等：不再调 provider
    const again = await gen3dApplyMotion.execute({ assetPath, actionId: 101 }, EXEC);
    expect(again).toMatchObject({ ok: true });
    expect(fake.calls.filter((c) => c.method === 'submitAnimation')).toHaveLength(1);
  });

  it('rig 过期（官方 expires_at 已过）→ rig_expired；autoReRig 先重绑再套', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'meshy', rigTaskId: 'rig-old', rigExpiresAt: PAST });
    const fake = new FakeProvider('meshy', true);
    fake.handlers.getBalance = () => Promise.resolve({ balance: 100 });
    fake.handlers.submitRig = () => Promise.resolve({ provider: 'meshy', taskId: 'rig-new' });
    fake.handlers.pollTask = (handle) =>
      handle.taskId === 'rig-new'
        ? Promise.resolve(rigTaskResult('rig-new'))
        : Promise.resolve(
            meshyResult('anim-1', [{ role: 'animation_glb', format: 'glb', url: 'u/a.glb', buffer: glbBytes('a') }]),
          );
    fake.handlers.submitAnimation = () => Promise.resolve({ provider: 'meshy', taskId: 'anim-1' });
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });

    const blocked = await gen3dApplyMotion.execute({ assetPath, actionId: 101 }, EXEC);
    expect(blocked).toMatchObject({ ok: false, code: 'rig_expired' });

    const rerigged = await gen3dApplyMotion.execute({ assetPath, actionId: 101, autoReRig: true }, EXEC);
    expect(rerigged).toMatchObject({ ok: true });
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.custom.rig?.rigTaskId).toBe('rig-new');
    expect(sidecar!.dependencies.some((d) => d.kind === 'animated_model')).toBe(true);
  });

  it('Hunyuan 路由：motionType 1–48；provider 无 submitAnimation → provider_capability_missing', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'hunyuan3d', rigTaskId: 'hy-rig-1', rigExpiresAt: null });
    // 最小 provider：实现契约但未实现可选能力 submitAnimation
    const stripped = {
      id: 'hunyuan3d',
      isConfigured: () => true,
      submitGeneration: async () => { throw new Error('n/a'); },
      pollTask: async () => { throw new Error('n/a'); },
    } as never;
    configureToolDeps({ store: tmp.store, providerFactory: async () => stripped as never });
    const out = await gen3dApplyMotion.execute({ assetPath, motionType: 23 }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'provider_capability_missing' });
  });

  it('Hunyuan 路由：provider 实现 submitAnimation → motionType 透传并落盘', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'hunyuan3d', rigTaskId: 'hy-rig-1', rigExpiresAt: null });
    const fake = new FakeProvider('hunyuan3d', true);
    fake.handlers.submitAnimation = (req) => {
      expect(req.actionId).toBe(23);
      return Promise.resolve({ provider: 'hunyuan3d', taskId: 'hy-anim-1' });
    };
    fake.handlers.pollTask = () =>
      Promise.resolve({ status: 'succeeded', downloads: { glb: 'https://cdn/h.glb' }, raw: {} });
    configureToolDeps({
      store: tmp.store,
      providerFactory: factory(fake),
      fetchImpl: mockFetch({ 'https://cdn/h.glb': glbBytes('h') }),
    });
    const out = await gen3dApplyMotion.execute({ assetPath, motionType: 23 }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const sidecar = await tmp.store.readSidecar(assetPath);
    const dep = sidecar!.dependencies.find((d) => d.kind === 'animated_model')!;
    expect(dep.motionRef).toMatchObject({ system: 'hunyuan_v1', id: 23 });
  });

  it('Tripo 路由：preset 前缀补齐并透传 submitAnimation', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'tripo3d', rigTaskId: 't-rig-1', rigExpiresAt: null });
    const fake = new FakeProvider('tripo3d', true);
    fake.handlers.submitAnimation = (req) => {
      expect(req.actionId).toBe('preset:walk');
      return Promise.resolve({ provider: 'tripo3d', taskId: 't-anim-1' });
    };
    fake.handlers.pollTask = () =>
      Promise.resolve({ status: 'succeeded', downloads: { glb: 'https://cdn/t.glb' }, raw: {} });
    configureToolDeps({
      store: tmp.store,
      providerFactory: factory(fake),
      fetchImpl: mockFetch({ 'https://cdn/t.glb': glbBytes('t') }),
    });
    const out = await gen3dApplyMotion.execute({ assetPath, preset: 'walk' }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.dependencies.some((d) => d.kind === 'animated_model')).toBe(true);
  });

  it('未绑骨 → not_rigged；未配置 key → mock 动作', async () => {
    const assetPath = await seedMeshAsset(tmp);
    const out = await gen3dApplyMotion.execute({ assetPath, actionId: 101 }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'not_rigged' });

    const riggedPath = await seedRiggedAsset(tmp, { rigProvider: 'meshy', rigTaskId: 'rig-1', rigExpiresAt: FUTURE });
    configureToolDeps({
      store: tmp.store,
      providerFactory: async (id) => new FakeProvider(id as 'meshy', false),
    });
    const mockOut = await gen3dApplyMotion.execute({ assetPath: riggedPath, actionId: 101 }, EXEC);
    expect(mockOut).toMatchObject({ ok: true, usedMock: true });
    const sidecar = await tmp.store.readSidecar(riggedPath);
    expect(sidecar!.dependencies.some((d) => d.kind === 'animated_model')).toBe(true);
  });
});

describe('gen3d_list_motions', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('Meshy 静态目录：query 收窄生效，usedMock=false（本地零配额）', async () => {
    const fake = new FakeProvider('meshy', true);
    fake.handlers.listMotions = (q) =>
      Promise.resolve([
        { id: 101, label: 'Walk', category: 'locomotion' },
        { id: 28, label: 'Big Wave Hello', category: 'gesture' },
      ].filter((m) => !q?.query || m.label.toLowerCase().includes(q.query.toLowerCase())));
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });
    const out = await gen3dListMotions.execute({ query: 'walk' }, EXEC);
    expect(out).toMatchObject({ ok: true, system: 'meshy', usedMock: false, total: 1 });
    const motions = (out as { motions: { id: number; label: string }[] }).motions;
    expect(motions[0]!.label).toBe('Walk');
  });

  it('按资产 rig 来源收窄：tripo3d rig → tripo 预设目录', async () => {
    const assetPath = await seedRiggedAsset(tmp, { rigProvider: 'tripo3d', rigTaskId: 't-1', rigExpiresAt: null });
    const fake = new FakeProvider('tripo3d', true);
    fake.handlers.listMotions = () =>
      Promise.resolve([{ id: 'preset:walk', label: 'Walk', category: 'Biped', rigType: 'biped' }]);
    configureToolDeps({ store: tmp.store, providerFactory: factory(fake) });
    const out = await gen3dListMotions.execute({ assetPath }, EXEC);
    expect(out).toMatchObject({ ok: true, system: 'tripo3d', total: 1 });
  });
});
