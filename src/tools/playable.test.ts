// src/tools/playable.ts 单测 —— 动作档读写、动作映射、合并导出（含真实
// gltf-transform 合并）、孤儿资产采纳。

import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configureToolDeps } from './common.js';
import {
  gen3dAdoptPlayableCharacter,
  gen3dExportPlayableCharacter,
  gen3dGetPlayableProfile,
  gen3dSetPlayableMotionMapping,
  gen3dSetPlayableProfile,
} from './playable.js';
import {
  buildMotionGlb,
  buildOrphanMerged,
  buildRiggedBase,
  glbBytes,
  makeStore,
  type TempStore,
} from './test-helpers.js';

const EXEC = { signal: new AbortController().signal };

/** 落一个绑骨 + 两个动作的角色资产（meshy rig；动作 101 / 102）。 */
async function seedRiggedCharacter(tmp: TempStore): Promise<{ assetPath: string; motion101: Uint8Array; motion102: Uint8Array }> {
  const assetPath = 'assets/3d/characters/hero.glb';
  const motion101 = await buildMotionGlb('idle');
  const motion102 = await buildMotionGlb('walk');
  await tmp.store.saveAsset({
    slot: 'characters',
    fileName: 'hero.glb',
    data: glbBytes('main'),
    sidecar: {
      dependencies: [{ path: 'hero.rigged_model.glb', hash: 'sha256:r', kind: 'rigged_model', hasSkeleton: true, skeletonProfile: 'humanoid', animationInputReady: true }],
      custom: {
        provider: 'meshy',
        providerMode: 'real',
        mode: 'text',
        readiness: { hasSourceMesh: true, rigged: true, animated: true },
        rig: { rigProvider: 'meshy', rigTaskId: 'rig-1', rigType: null, rigExpiresAt: null },
      },
    },
  });
  // 动作侧文件（真实 GLB 字节）
  const { writeAssetSideFile } = await import('./common.js');
  await writeAssetSideFile(tmp.store, 'characters', 'hero.animated_model.motion-meshy-101.glb', motion101);
  await writeAssetSideFile(tmp.store, 'characters', 'hero.animated_model.motion-meshy-102.glb', motion102);
  await tmp.store.updateSidecar(assetPath, (s) => ({
    ...s,
    dependencies: [
      ...s.dependencies,
      { path: 'hero.animated_model.motion-meshy-101.glb', hash: 'sha256:a', kind: 'animated_model', motionRef: { system: 'meshy', id: 101, label: '待机' } },
      { path: 'hero.animated_model.motion-meshy-102.glb', hash: 'sha256:b', kind: 'animated_model', motionRef: { system: 'meshy', id: 102, label: '走路' } },
    ],
  }));
  return { assetPath, motion101, motion102 };
}

/** 基础角色档（idle/move 双必填槽）。 */
const BASE_SLOTS = [
  { slotId: 'idle', displayName: '待机', required: true, playbackMode: 'loop' as const, speed: 1, matchKeywords: ['idle', '待机'], rootMotion: 'preserve' as const },
  { slotId: 'move', displayName: '移动', required: true, playbackMode: 'loop' as const, speed: 1, matchKeywords: ['move', '移动'], rootMotion: 'remove_xz' as const },
];

describe('playable 动作档读写', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('set/get-playable-profile：角色覆盖写入 sidecar，effectiveSlots 生效', async () => {
    const { assetPath } = await seedRiggedCharacter(tmp);
    const out = await gen3dSetPlayableProfile.execute({ assetPath, slots: BASE_SLOTS as never }, EXEC);
    expect(out).toMatchObject({ ok: true });
    const g = await gen3dGetPlayableProfile.execute({ assetPath }, EXEC);
    expect(g).toMatchObject({ ok: true, migrationNeeded: false });
    const got = g as { override: { slots: { slotId: string }[] }; effectiveSlots: { slotId: string }[]; presets: unknown[] };
    expect(got.override.slots.map((s) => s.slotId)).toEqual(['idle', 'move']);
    expect(got.effectiveSlots.map((s) => s.slotId)).toEqual(['idle', 'move']);
    expect(got.presets.length).toBeGreaterThanOrEqual(4);
  });

  it('set-playable-motion-mapping：草稿 + confirmed 写入；未确认时导出拒绝', async () => {
    const { assetPath } = await seedRiggedCharacter(tmp);
    await gen3dSetPlayableProfile.execute({ assetPath, slots: BASE_SLOTS as never }, EXEC);
    const m = await gen3dSetPlayableMotionMapping.execute(
      {
        assetPath,
        mappings: [
          { slotId: 'idle', motionRefKey: 'meshy:101', autoMatched: true },
          { slotId: 'move', motionRefKey: 'meshy:102', autoMatched: true },
        ],
        confirmed: false,
      },
      EXEC,
    );
    expect(m).toMatchObject({ ok: true });
    const blocked = await gen3dExportPlayableCharacter.execute({ assetPath }, EXEC);
    expect(blocked).toMatchObject({ ok: false, code: 'mapping_not_confirmed' });
  });

  it('未绑骨资产导出 → not_rigged', async () => {
    const assetPath = 'assets/3d/characters/raw.glb';
    await tmp.store.saveAsset({
      slot: 'characters',
      fileName: 'raw.glb',
      data: glbBytes('raw'),
      sidecar: {
        custom: { provider: 'meshy', providerMode: 'real', mode: 'text', readiness: { hasSourceMesh: true, rigged: false, animated: false } },
      },
    });
    const out = await gen3dExportPlayableCharacter.execute({ assetPath }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'not_rigged' });
  });
});

describe('gen3d_export_playable_character（真实合并）', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('真实 gltf-transform 合并：merged.glb + playable.json 两件套 + 交付快照', async () => {
    const { assetPath } = await seedRiggedCharacter(tmp);
    // rigged_model 依赖换成真实 rigged base GLB（默认依赖是假字节，真实合并会读失败）
    const baseBytes = await buildRiggedBase();
    await tmp.store.updateSidecar(assetPath, (s) => ({
      ...s,
      dependencies: s.dependencies.map((d) => (d.kind === 'rigged_model' ? { ...d, hash: 'sha256:real' } : d)),
    }));
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(`${tmp.root}/assets/3d/characters`, { recursive: true });
    writeFileSync(`${tmp.root}/assets/3d/characters/hero.rigged_model.glb`, baseBytes);

    await gen3dSetPlayableProfile.execute({ assetPath, slots: BASE_SLOTS as never }, EXEC);
    await gen3dSetPlayableMotionMapping.execute(
      {
        assetPath,
        mappings: [
          { slotId: 'idle', motionRefKey: 'meshy:101', autoMatched: true },
          { slotId: 'move', motionRefKey: 'meshy:102', autoMatched: true },
        ],
        confirmed: true,
      },
      EXEC,
    );
    const out = await gen3dExportPlayableCharacter.execute({ assetPath }, EXEC);
    expect(out).toMatchObject({ ok: true, firstExport: true, clipCount: 2, reusedGuidCount: 0 });

    // 两件套落盘
    const glbAbs = `${tmp.root}/assets/3d/characters/hero-merged.glb`;
    const playableAbs = `${tmp.root}/assets/3d/characters/hero.playable.json`;
    expect(existsSync(glbAbs)).toBe(true);
    expect(existsSync(playableAbs)).toBe(true);
    const playable = JSON.parse(readFileSync(playableAbs, 'utf8')) as {
      kind: string;
      clips: Record<string, { guid: string; loop: boolean; speed: number; rootMotion: string }>;
      modelPath: string;
      sceneGuid: string;
    };
    expect(playable.kind).toBe('playable-character-delivery');
    expect(playable.sceneGuid).toBe(''); // 无 engine meta
    expect(Object.keys(playable.clips)).toEqual(['idle', 'move']);
    expect(playable.clips['idle']!.rootMotion).toBe('preserve');
    expect(playable.clips['move']!.rootMotion).toBe('remove_xz');

    // 交付快照写入 sidecar；one-click ready
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.custom.playableDelivery).toMatchObject({ modelPath: 'assets/3d/characters/hero-merged.glb', clipSlotIds: ['idle', 'move'] });
    const g = await gen3dGetPlayableProfile.execute({ assetPath }, EXEC);
    expect((g as { oneClickReady: boolean }).oneClickReady).toBe(true);

    // 再次导出：firstExport=false，guid 复用
    const again = await gen3dExportPlayableCharacter.execute({ assetPath }, EXEC);
    expect(again).toMatchObject({ ok: true, firstExport: false, reusedGuidCount: 2 });
  });

  it('必填槽未映射 → missing_required', async () => {
    const { assetPath } = await seedRiggedCharacter(tmp);
    await gen3dSetPlayableProfile.execute({ assetPath, slots: BASE_SLOTS as never }, EXEC);
    await gen3dSetPlayableMotionMapping.execute(
      { assetPath, mappings: [{ slotId: 'idle', motionRefKey: 'meshy:101', autoMatched: true }], confirmed: true },
      EXEC,
    );
    const out = await gen3dExportPlayableCharacter.execute({ assetPath }, EXEC);
    expect(out).toMatchObject({ ok: false, code: 'missing_required' });
  });
});

describe('gen3d_adopt_playable_character', () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeStore();
    configureToolDeps({ store: tmp.store });
  });
  afterEach(() => {
    configureToolDeps({});
    tmp.cleanup();
  });

  it('采纳孤儿 merged.glb：按动画名映射槽位，写 playable.json + 快照', async () => {
    const { assetPath } = await seedRiggedCharacter(tmp);
    const orphan = await buildOrphanMerged(['Idle', 'Walk']);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(`${tmp.root}/assets/3d/characters`, { recursive: true });
    writeFileSync(`${tmp.root}/assets/3d/characters/hero-merged.glb`, orphan);

    await gen3dSetPlayableProfile.execute({ assetPath, slots: BASE_SLOTS as never }, EXEC);
    // get-playable-profile 应报告采纳候选（动画名 Idle / Walk）
    const g = await gen3dGetPlayableProfile.execute({ assetPath }, EXEC);
    const candidate = (g as { adoptCandidate: { clips: { name: string }[] } | null }).adoptCandidate;
    expect(candidate).not.toBeNull();
    expect(candidate!.clips.map((c) => c.name)).toEqual(['Idle', 'Walk']);

    const out = await gen3dAdoptPlayableCharacter.execute(
      {
        assetPath,
        confirmed: true,
        slotMappings: [
          { slotId: 'idle', clipName: 'Idle' },
          { slotId: 'move', sourceIndex: 1 },
        ],
      },
      EXEC,
    );
    expect(out).toMatchObject({ ok: true, clipCount: 2 });
    const playableAbs = `${tmp.root}/assets/3d/characters/hero.playable.json`;
    expect(existsSync(playableAbs)).toBe(true);
    const sidecar = await tmp.store.readSidecar(assetPath);
    expect(sidecar!.custom.playableDelivery).toMatchObject({ modelPath: 'assets/3d/characters/hero-merged.glb' });
    // 已采纳 → 无候选
    const g2 = await gen3dGetPlayableProfile.execute({ assetPath }, EXEC);
    expect((g2 as { adoptCandidate: unknown }).adoptCandidate).toBeNull();
    // one-click 关闭（采纳无源动作映射）
    expect((g2 as { oneClickReady: boolean }).oneClickReady).toBe(false);
  });

  it('未确认 → not_confirmed；必填槽未映射 → missing_required_slots', async () => {
    const { assetPath } = await seedRiggedCharacter(tmp);
    const orphan = await buildOrphanMerged(['Idle']);
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(`${tmp.root}/assets/3d/characters`, { recursive: true });
    writeFileSync(`${tmp.root}/assets/3d/characters/hero-merged.glb`, orphan);
    await gen3dSetPlayableProfile.execute({ assetPath, slots: BASE_SLOTS as never }, EXEC);

    const unconfirmed = await gen3dAdoptPlayableCharacter.execute(
      { assetPath, confirmed: false, slotMappings: [] },
      EXEC,
    );
    expect(unconfirmed).toMatchObject({ ok: false, code: 'not_confirmed' });

    const incomplete = await gen3dAdoptPlayableCharacter.execute(
      {
        assetPath,
        confirmed: true,
        slotMappings: [{ slotId: 'idle', clipName: 'Idle' }], // move 未映射
      },
      EXEC,
    );
    expect(incomplete).toMatchObject({ ok: false, code: 'missing_required_slots' });
  });

  it('无孤儿 merged.glb → nothing_to_adopt', async () => {
    const { assetPath } = await seedRiggedCharacter(tmp);
    const out = await gen3dAdoptPlayableCharacter.execute(
      { assetPath, confirmed: true, slotMappings: [{ slotId: 'idle', clipName: 'Idle' }] },
      EXEC,
    );
    expect(out).toMatchObject({ ok: false, code: 'nothing_to_adopt' });
  });
});
