// 可玩角色域工具 —— gen3d_get/set_playable_profile、set_playable_motion_mapping、
// export_playable_character、adopt_playable_character。
//
// 业务事实来源：移植自一套内部 3D 生成工具链的可玩角色导出段，按 DSH 契约重写。差异：
// - 四层模型收敛为三层：内置 preset → 角色覆盖（custom.playableOverride）→
//   动作映射（custom.motionMapping）。DSH 单工作区没有「游戏级默认档」存储
//   （storage 层无此槽位），gameProfile 一律以内置 preset 为锚（v1），
//   saveAsGameDefault 保留参数但行为等同不保存（只写角色覆盖）；
// - 导出交付物为两件套：`assets/3d/characters/<stem>-merged.glb` +
//   `<stem>.playable.json`，不含任何引擎私有 meta（不再有 *.meta.json，
//   sceneGuid 置空，clip guid 用确定性 `gen3d-<slotId>`）；
// - adopt：候选 = 孤儿 `<stem>-merged.glb`（无 delivery 快照），clip 信息从
//   GLB 动画名直接读取（替代读 engine meta）。

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { NodeIO } from '@gltf-transform/core';

import { motionRefKey, type PlayableDeliverySnapshot } from '../legacy/shared/manifest.js';
import {
  BUILTIN_PROFILE_PRESETS,
  effectiveSlots,
  gameProfileFromPreset,
  type CharacterMotionOverride,
  type GameMotionProfile,
  type MotionMappingDraft,
  type MotionMappingEntry,
  type MotionSlotDef,
  type PlaybackMode,
  type RootMotionStrategy,
} from '../legacy/shared/playable-profile.js';
import { mergePlayableCharacter, resolveExportSlots } from '../legacy/server/merge-playable-character.js';
import {
  defineGen3dTool,
  getStore,
  resultSchema,
  toolDeps,
  ToolError,
  type Gen3dSidecar,
} from './common.js';

// ── 常量与辅助 ───────────────────────────────────────────────────────────────

const ANCHOR_PRESET_ID = 'basic-character-v1';
const PLAYABLE_SLOT_DIR = 'assets/3d/characters';

const VALID_PLAYBACK_MODES: readonly PlaybackMode[] = ['loop', 'once', 'freeze_frame'];
const VALID_ROOT_MOTIONS: readonly RootMotionStrategy[] = ['preserve', 'remove_xz', 'remove_xyz'];

function stemFromAssetPath(assetPath: string): string {
  const base = assetPath.split('/').pop() ?? 'character.glb';
  return base.replace(/\.glb$/i, '') || 'character';
}

/** 原子写（同目录 tmp + rename；失败清理 tmp）。 */
async function writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.__export_tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** 映射指纹（沿用 legacy export-playable-character.mappingFingerprint）。 */
export function mappingFingerprint(
  slots: readonly MotionSlotDef[],
  mappings: readonly { slotId: string; motionRefKey: string | null }[],
  profileId: string,
  profileVersion: number,
): string {
  const map = Object.fromEntries(mappings.map((m) => [m.slotId, m.motionRefKey]));
  const body = {
    profileId,
    profileVersion,
    slots: slots.map((s) => ({
      id: s.slotId,
      required: s.required,
      rootMotion: s.rootMotion,
      speed: s.speed,
      playbackMode: s.playbackMode,
      motion: map[s.slotId] ?? null,
    })),
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** 动作槽校验（沿用 legacy validateMotionSlots 的手写约束）。 */
function validateMotionSlots(raw: unknown): MotionSlotDef[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ToolError('invalid_slots', 'slots 必须是非空数组');
  }
  for (const s of raw as MotionSlotDef[]) {
    if (typeof s.speed !== 'number' || !(s.speed > 0)) {
      throw new ToolError('invalid_slots', `slot ${s.slotId}: speed 必须 > 0，got ${s.speed}`);
    }
    if (!VALID_PLAYBACK_MODES.includes(s.playbackMode)) {
      throw new ToolError('invalid_slots', `slot ${s.slotId}: 无效 playbackMode ${String(s.playbackMode)}`);
    }
    if (!VALID_ROOT_MOTIONS.includes(s.rootMotion)) {
      throw new ToolError('invalid_slots', `slot ${s.slotId}: 无效 rootMotion ${String(s.rootMotion)}`);
    }
  }
  return raw as MotionSlotDef[];
}

/** 映射指纹（沿用 legacy export-playable-character.mappingFingerprint）。 */

interface AdoptClipInfo {
  name: string;
  sourceIndex: number;
}

interface AdoptCandidate {
  modelPath: string;
  playablePath: string;
  clips: AdoptClipInfo[];
}

/** 孤儿候选：<stem>-merged.glb 存在且无 delivery 快照；clip 信息从 GLB 动画名读取。 */
async function inspectAdoptCandidate(assetPath: string): Promise<AdoptCandidate | null> {
  const store = getStore();
  const stem = stemFromAssetPath(assetPath);
  const modelRel = `${PLAYABLE_SLOT_DIR}/${stem}-merged.glb`;
  const abs = join(store.workspaceRoot, modelRel);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(abs));
  } catch {
    return null;
  }
  let clips: AdoptClipInfo[];
  try {
    const doc = await new NodeIO().readBinary(bytes);
    clips = doc.getRoot().listAnimations().map((a, i) => ({ name: a.getName() || `clip_${i}`, sourceIndex: i }));
  } catch {
    return null;
  }
  if (clips.length === 0) return null;
  return { modelPath: modelRel, playablePath: `${PLAYABLE_SLOT_DIR}/${stem}.playable.json`, clips };
}

/** 只读：可玩角色动作档（presets / 角色覆盖 / 动作映射 / 交付快照 / 采纳候选）。 */
export const gen3dGetPlayableProfile = defineGen3dTool({
  name: 'gen3d_get_playable_profile',
  description:
    '读取可玩角色动作档：内置 preset 列表、当前生效动作槽（effectiveSlots = 角色覆盖 ?? 内置 preset 锚）、角色覆盖（custom.playableOverride）、动作映射草稿（custom.motionMapping）、上次导出交付快照（custom.playableDelivery）与 oneClickReady（映射指纹一致且已确认）。DSH 无游戏级默认档存储，gameProfile 恒为内置 preset 锚（migrationNeeded 恒 false）。',
  parameters: {
    assetPath: { type: 'string', description: '角色资产相对路径（缺省只返回 preset 与锚档）' },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const gameProfile = gameProfileFromPreset(ANCHOR_PRESET_ID, new Date(0).toISOString());
    const assetPath = typeof args.assetPath === 'string' ? args.assetPath.trim() : '';
    let override: CharacterMotionOverride | null = null;
    let mapping: MotionMappingDraft | null = null;
    let delivery: PlayableDeliverySnapshot | null = null;
    let adoptCandidate: AdoptCandidate | null = null;
    if (assetPath) {
      const sidecar = await store.readSidecar(assetPath);
      if (sidecar === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
      if (sidecar.custom.assetSlot !== 'characters') {
        throw new ToolError('not_a_character', '本工具只适用于 characters 槽位资产');
      }
      override = sidecar.custom.playableOverride ?? null;
      mapping = sidecar.custom.motionMapping ?? null;
      delivery = sidecar.custom.playableDelivery ?? null;
      if (delivery === null) adoptCandidate = await inspectAdoptCandidate(assetPath);
    }
    const slots = effectiveSlots(gameProfile, override);
    const profileId = override?.basedOnProfileId ?? gameProfile.profileId;
    const profileVersion = override?.basedOnProfileVersion ?? gameProfile.profileVersion;
    const currentFingerprint = mapping?.confirmed
      ? mappingFingerprint(slots, mapping.mappings, profileId, profileVersion)
      : null;
    return {
      ok: true,
      presets: BUILTIN_PROFILE_PRESETS.map((p) => ({
        ...p,
        slots: p.slots.map((s) => ({ ...s, matchKeywords: [...s.matchKeywords] })),
      })),
      gameProfile,
      effectiveSlots: slots,
      override,
      mapping,
      delivery,
      oneClickReady: Boolean(delivery && currentFingerprint && delivery.mappingFingerprint === currentFingerprint),
      migrationNeeded: false,
      adoptCandidate,
    };
  },
});

// ── gen3d_set_playable_profile ──────────────────────────────────────────────

/** 写角色覆盖（custom.playableOverride）；saveAsGameDefault 保留参数但 DSH 无游戏级默认档存储。 */
export const gen3dSetPlayableProfile = defineGen3dTool({
  name: 'gen3d_set_playable_profile',
  description:
    '设置角色的动作槽配置：写入角色覆盖 custom.playableOverride（整槽替换生效槽位，基于内置 preset 锚记录 basedOnProfileId/Version）。saveAsGameDefault 为 legacy 兼容参数——DSH 单工作区没有游戏级默认档存储，行为等同不保存（只写角色覆盖）。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '角色资产相对路径（characters 槽位）' },
    slots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slotId: { type: 'string', required: true, description: '稳定槽位 id（如 idle / move / attack）' },
          displayName: { type: 'string', required: true, description: '槽位显示名' },
          required: { type: 'boolean', required: true, description: '是否为必填槽（导出前 F1 校验）' },
          playbackMode: { type: 'string', enum: ['loop', 'once', 'freeze_frame'], required: true, description: '播放模式' },
          speed: { type: 'number', required: true, description: '播放倍速（>0）' },
          matchKeywords: { type: 'array', items: { type: 'string' }, required: true, description: '自动匹配关键词' },
          rootMotion: { type: 'string', enum: ['preserve', 'remove_xz', 'remove_xyz'], required: true, description: '根运动策略' },
        },
      },
      description: '完整动作槽列表（非空）',
    },
    profileId: { type: 'string', default: 'basic-character-v1', description: '基准 preset id（basic-character-v1 / action-adventure-v1 / platformer-v1 / blank-custom-v1）' },
    displayName: { type: 'string', description: '档位显示名（记录进 override）' },
    saveAsGameDefault: { type: 'boolean', default: false, description: 'legacy 兼容：DSH 无游戏级默认档存储，恒等同不保存' },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const assetPath = typeof args.assetPath === 'string' ? args.assetPath.trim() : '';
    if (!assetPath) throw new ToolError('invalid_asset_path', 'assetPath 必填');
    const slots = validateMotionSlots(args.slots);
    const sidecar = await store.readSidecar(assetPath);
    if (sidecar === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    if (sidecar.custom.assetSlot !== 'characters') throw new ToolError('not_a_character', '本工具只适用于 characters 槽位资产');

    const profileId = typeof args.profileId === 'string' && args.profileId.trim() ? args.profileId.trim() : ANCHOR_PRESET_ID;
    const now = new Date().toISOString();
    const gameProfile: GameMotionProfile = {
      ...gameProfileFromPreset(profileId, now),
      ...(typeof args.displayName === 'string' && args.displayName.trim()
        ? { displayName: args.displayName.trim() }
        : {}),
    };
    const override: CharacterMotionOverride = {
      schemaVersion: 1,
      slots,
      basedOnProfileId: gameProfile.profileId,
      basedOnProfileVersion: gameProfile.profileVersion,
      updatedAt: now,
    };
    const manifest = await store.updateSidecar(assetPath, (s) => ({
      ...s,
      custom: { ...s.custom, playableOverride: override },
    }));
    return {
      ok: true,
      gameProfile,
      override,
      saveAsGameDefaultApplied: false,
      note: 'DSH 无游戏级默认档存储；saveAsGameDefault 仅保留兼容参数，行为等同不保存（只写角色覆盖）',
      manifest,
    };
  },
});

// ── gen3d_set_playable_motion_mapping ───────────────────────────────────────

/** 写动作映射草稿（custom.motionMapping；confirmed 标记人工确认）。 */
export const gen3dSetPlayableMotionMapping = defineGen3dTool({
  name: 'gen3d_set_playable_motion_mapping',
  description:
    '设置角色的动作映射草稿 custom.motionMapping：每个槽位映射一个已套动作的 motionRefKey（gen3d_list_motions 的 system:id 键，如 meshy:101；null = 未映射）。confirmed=true 标记映射已经人工确认（导出前置条件）。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '角色资产相对路径' },
    mappings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slotId: { type: 'string', required: true, description: '槽位 id' },
          motionRefKey: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: '动作结构键（system:id，如 meshy:101）；null = 未映射' },
          autoMatched: { type: 'boolean', required: true, description: '是否自动匹配（人工确认前为 true）' },
        },
      },
      description: '槽位 → 动作映射列表',
    },
    confirmed: { type: 'boolean', default: false, description: '标记映射已人工确认（导出前置条件）' },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const assetPath = typeof args.assetPath === 'string' ? args.assetPath.trim() : '';
    if (!assetPath) throw new ToolError('invalid_asset_path', 'assetPath 必填');
    if (!Array.isArray(args.mappings)) throw new ToolError('invalid_mappings', 'mappings 必须是数组');
    const sidecar = await store.readSidecar(assetPath);
    if (sidecar === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    if (sidecar.custom.assetSlot !== 'characters') throw new ToolError('not_a_character', '本工具只适用于 characters 槽位资产');
    const mapping: MotionMappingDraft = {
      schemaVersion: 1,
      mappings: args.mappings as MotionMappingEntry[],
      confirmed: args.confirmed === true,
      updatedAt: new Date().toISOString(),
    };
    const manifest = await store.updateSidecar(assetPath, (s) => ({
      ...s,
      custom: { ...s.custom, motionMapping: mapping },
    }));
    return { ok: true, mapping, manifest };
  },
});

// ── gen3d_export_playable_character ─────────────────────────────────────────

interface PlayableClipDelivery {
  guid: string;
  sourceIndex: number;
  loop: boolean;
  speed: number;
  rootMotion: RootMotionStrategy;
}

interface PlayableDeliveryJson {
  schemaVersion: 1;
  kind: 'playable-character-delivery';
  sourceAssetPath: string;
  modelPath: string;
  profileId: string;
  profileVersion: number;
  sceneGuid: string;
  clips: Record<string, PlayableClipDelivery>;
}

/** 读取依赖文件（motionRefKey → 字节）。 */
async function collectSlotFiles(
  sidecar: Gen3dSidecar,
  assetPath: string,
): Promise<{ baseBytes: Uint8Array; byKey: Map<string, Uint8Array> }> {
  const store = getStore();
  const dir = dirname(store.absolutePath(assetPath));
  const readDep = async (path: string, what: string): Promise<Uint8Array> => {
    try {
      return new Uint8Array(await readFile(join(dir, path)));
    } catch (err) {
      throw new ToolError('motion_file_missing', `读取 ${what} 失败：${join(dir, path)}（${err instanceof Error ? err.message : String(err)}）`, true);
    }
  };
  const baseDep = sidecar.dependencies.find((d) => d.kind === 'rigged_model' && d.path.toLowerCase().endsWith('.glb'));
  if (!baseDep) throw new ToolError('missing_rigged_glb', '资产没有 rigged_model GLB 依赖；请先 gen3d_auto_rig');
  const baseBytes = await readDep(baseDep.path, 'rigged_model GLB');
  const byKey = new Map<string, Uint8Array>();
  for (const d of sidecar.dependencies) {
    if (d.kind !== 'animated_model' || !d.motionRef) continue;
    byKey.set(motionRefKey(d.motionRef), await readDep(d.path, `动作 ${motionRefKey(d.motionRef)}`));
  }
  return { baseBytes, byKey };
}

/** 本地合并导出：merged.glb + playable.json 两件套（无 engine meta），并写 delivery 快照。 */
export const gen3dExportPlayableCharacter = defineGen3dTool({
  name: 'gen3d_export_playable_character',
  description:
    '导出可玩角色：按生效动作槽 + 已确认动作映射，把 rigged_model GLB 与各槽位 animated_model 动作 GLB 合并（gltf-transform 字节级合并，沿用 legacy merge-playable-character 语义），产出两件套：assets/3d/characters/<stem>-merged.glb 与 <stem>.playable.json（playable-character-delivery，无 engine meta，clip guid 为确定性 gen3d-<slotId>），并把交付快照写入 sidecar custom.playableDelivery。前置：已绑骨、动作映射已确认（confirmed）、必填槽全部映射。本工具不调 provider、不消耗配额。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '角色资产相对路径（characters 槽位、已绑骨）' },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const assetPath = typeof args.assetPath === 'string' ? args.assetPath.trim() : '';
    if (!assetPath) throw new ToolError('invalid_asset_path', 'assetPath 必填');
    const sidecar = await store.readSidecar(assetPath);
    if (sidecar === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    if (sidecar.custom.assetSlot !== 'characters') throw new ToolError('not_a_character', '导出只适用于 characters 槽位资产');
    if (!sidecar.custom.readiness.rigged) throw new ToolError('not_rigged', '资产未绑骨；请先 gen3d_auto_rig 再导出');

    const override = sidecar.custom.playableOverride ?? null;
    const mapping = sidecar.custom.motionMapping ?? null;
    if (!mapping || !mapping.confirmed) {
      throw new ToolError('mapping_not_confirmed', '动作映射未确认；请先 gen3d_set_playable_motion_mapping 并 confirmed: true');
    }
    const gameProfile = gameProfileFromPreset(ANCHOR_PRESET_ID, new Date(0).toISOString());
    const slots = effectiveSlots(gameProfile, override);
    const resolved = resolveExportSlots({ slots, mappings: mapping.mappings });
    if (!resolved.ok) throw new ToolError(resolved.code, resolved.message);

    const { baseBytes, byKey } = await collectSlotFiles(sidecar, assetPath);
    const mergeSlots: { slotId: string; motionGlbBytes: Uint8Array; rootMotion: RootMotionStrategy }[] = [];
    for (const slotId of resolved.exportSlotIds) {
      const key = resolved.mappingBySlot.get(slotId)!;
      const bytes = byKey.get(key);
      if (!bytes) {
        throw new ToolError('motion_file_missing', `槽位 ${slotId} 映射的动作 ${key} 不在磁盘上（请先 gen3d_apply_motion）`);
      }
      const slotDef = slots.find((s) => s.slotId === slotId)!;
      mergeSlots.push({ slotId, motionGlbBytes: bytes, rootMotion: slotDef.rootMotion });
    }

    const merge = toolDeps().mergePlayableCharacter ?? mergePlayableCharacter;
    const merged = await merge({ baseRiggedGlbBytes: baseBytes, slots: mergeSlots });
    if (!merged.ok) throw new ToolError(merged.code, merged.message);

    const stem = stemFromAssetPath(assetPath);
    const modelRel = `${PLAYABLE_SLOT_DIR}/${stem}-merged.glb`;
    const playableRel = `${PLAYABLE_SLOT_DIR}/${stem}.playable.json`;
    const clips: Record<string, PlayableClipDelivery> = {};
    resolved.exportSlotIds.forEach((slotId, i) => {
      const slotDef = slots.find((s) => s.slotId === slotId)!;
      clips[slotId] = {
        guid: `gen3d-${slotId}`,
        sourceIndex: i,
        loop: slotDef.playbackMode === 'loop',
        speed: slotDef.speed,
        rootMotion: slotDef.rootMotion,
      };
    });
    const profileId = override?.basedOnProfileId ?? gameProfile.profileId;
    const profileVersion = override?.basedOnProfileVersion ?? gameProfile.profileVersion;
    const playable: PlayableDeliveryJson = {
      schemaVersion: 1,
      kind: 'playable-character-delivery',
      sourceAssetPath: assetPath,
      modelPath: modelRel,
      profileId,
      profileVersion,
      sceneGuid: '',
      clips,
    };
    const firstExport = sidecar.custom.playableDelivery === undefined;
    await writeAtomic(join(store.workspaceRoot, modelRel), merged.bytes);
    await writeAtomic(join(store.workspaceRoot, playableRel), `${JSON.stringify(playable, null, 2)}\n`);

    const fp = mappingFingerprint(slots, mapping.mappings, profileId, profileVersion);
    const snapshot: PlayableDeliverySnapshot = {
      modelPath: modelRel,
      playablePath: playableRel,
      profileId,
      profileVersion,
      clipSlotIds: resolved.exportSlotIds,
      slotGuidRegistry: Object.fromEntries(resolved.exportSlotIds.map((id) => [id, `gen3d-${id}`])),
      mappingFingerprint: fp,
      exportedAt: new Date().toISOString(),
    };
    const manifest = await store.updateSidecar(assetPath, (s) => ({
      ...s,
      custom: { ...s.custom, playableDelivery: snapshot },
    }));
    return {
      ok: true,
      firstExport,
      modelPath: modelRel,
      playablePath: playableRel,
      clipCount: resolved.exportSlotIds.length,
      reusedGuidCount: firstExport ? 0 : resolved.exportSlotIds.length,
      message: '可玩角色已导出（merged.glb + playable.json 两件套，无 engine meta）',
      manifest,
    };
  },
});

// ── gen3d_adopt_playable_character ──────────────────────────────────────────

interface AdoptSlotMapping {
  slotId: string;
  /** 按 GLB 动画名匹配（优先）。 */
  clipName?: string | null;
  /** 按动画序号匹配。 */
  sourceIndex?: number | null;
}

function resolveClip(clips: AdoptClipInfo[], mapping: AdoptSlotMapping): AdoptClipInfo | null {
  if (typeof mapping.clipName === 'string' && mapping.clipName.trim()) {
    const want = mapping.clipName.trim().toLowerCase();
    const byName = clips.find((c) => c.name.toLowerCase() === want);
    if (byName) return byName;
  }
  if (typeof mapping.sourceIndex === 'number') {
    return clips.find((c) => c.sourceIndex === mapping.sourceIndex) ?? null;
  }
  return null;
}

/** 采纳孤儿 merged.glb（无 delivery 快照）为交付物：写 playable.json + 快照。 */
export const gen3dAdoptPlayableCharacter = defineGen3dTool({
  name: 'gen3d_adopt_playable_character',
  description:
    '采纳一个孤儿 <stem>-merged.glb（已存在但源资产还没有交付快照）为可玩角色交付物：从 GLB 动画名读取 clip 列表，按 slotMappings（clipName 优先 / sourceIndex 兜底）映射到生效槽位（必填槽必须全部映射），写 <stem>.playable.json 与 sidecar 交付快照。必须 confirmed: true。本工具不调 provider、不消耗配额。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '角色资产相对路径（characters 槽位）' },
    slotMappings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slotId: { type: 'string', required: true, description: '槽位 id' },
          clipName: { type: 'string', description: '孤儿 GLB 的动画名（优先匹配）' },
          sourceIndex: { type: 'integer', description: '动画序号（兜底匹配）' },
        },
      },
      description: '槽位 → clip 映射（必填槽必须全部映射到）',
    },
    confirmed: { type: 'boolean', default: false, description: '确认采纳（必须 true）' },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const assetPath = typeof args.assetPath === 'string' ? args.assetPath.trim() : '';
    if (!assetPath) throw new ToolError('invalid_asset_path', 'assetPath 必填');
    if (args.confirmed !== true) {
      throw new ToolError('not_confirmed', '请确认槽位 → clip 映射后再采纳（confirmed: true）');
    }
    const sidecar = await store.readSidecar(assetPath);
    if (sidecar === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    if (sidecar.custom.assetSlot !== 'characters') throw new ToolError('not_a_character', '本工具只适用于 characters 槽位资产');
    if (sidecar.custom.playableDelivery !== undefined) {
      throw new ToolError('nothing_to_adopt', '该资产已有交付快照（或先 gen3d_get_playable_profile 检查候选）');
    }
    const candidate = await inspectAdoptCandidate(assetPath);
    if (!candidate) {
      throw new ToolError('nothing_to_adopt', '未找到孤儿 merged.glb（或无动画 clip）；请先手动放置 <stem>-merged.glb');
    }

    const gameProfile = gameProfileFromPreset(ANCHOR_PRESET_ID, new Date(0).toISOString());
    const slots = effectiveSlots(gameProfile, sidecar.custom.playableOverride ?? null);
    if (!slots.some((s) => s.required)) {
      throw new ToolError('no_required_slots', '生效档没有必填槽；请先 gen3d_set_playable_profile');
    }
    const slotMappings = Array.isArray(args.slotMappings) ? (args.slotMappings as AdoptSlotMapping[]) : [];
    const mappingBySlot = new Map(slotMappings.map((m) => [m.slotId, m]));
    const clips: Record<string, PlayableClipDelivery> = {};
    const missing: string[] = [];
    for (const slot of slots) {
      const m = mappingBySlot.get(slot.slotId);
      const clip = m ? resolveClip(candidate.clips, m) : null;
      if (!clip) {
        if (slot.required) missing.push(slot.slotId);
        continue;
      }
      clips[slot.slotId] = {
        guid: `gen3d-${slot.slotId}`,
        sourceIndex: clip.sourceIndex,
        loop: slot.playbackMode === 'loop',
        speed: slot.speed,
        rootMotion: slot.rootMotion,
      };
    }
    if (missing.length > 0) {
      throw new ToolError('missing_required_slots', `必填槽未映射到 clip：${missing.join(', ')}`);
    }

    const profileId = sidecar.custom.playableOverride?.basedOnProfileId ?? gameProfile.profileId;
    const profileVersion = sidecar.custom.playableOverride?.basedOnProfileVersion ?? gameProfile.profileVersion;
    const playable: PlayableDeliveryJson = {
      schemaVersion: 1,
      kind: 'playable-character-delivery',
      sourceAssetPath: assetPath,
      modelPath: candidate.modelPath,
      profileId,
      profileVersion,
      sceneGuid: '',
      clips,
    };
    await writeAtomic(join(store.workspaceRoot, candidate.playablePath), `${JSON.stringify(playable, null, 2)}\n`);

    const exportSlotIds = Object.keys(clips);
    // 采纳的交付没有源动作映射：指纹用 null motion 引用，one-click 保持关闭直到真实映射确认
    const fp = mappingFingerprint(
      slots,
      slots.map((s) => ({ slotId: s.slotId, motionRefKey: null })),
      profileId,
      profileVersion,
    );
    const snapshot: PlayableDeliverySnapshot = {
      modelPath: candidate.modelPath,
      playablePath: candidate.playablePath,
      profileId,
      profileVersion,
      clipSlotIds: exportSlotIds,
      slotGuidRegistry: Object.fromEntries(exportSlotIds.map((id) => [id, `gen3d-${id}`])),
      mappingFingerprint: fp,
      exportedAt: new Date().toISOString(),
    };
    const manifest = await store.updateSidecar(assetPath, (s) => ({
      ...s,
      custom: { ...s.custom, playableDelivery: snapshot },
    }));
    return {
      ok: true,
      modelPath: candidate.modelPath,
      playablePath: candidate.playablePath,
      clipCount: exportSlotIds.length,
      reusedGuidCount: 0,
      message: '已采纳孤儿 merged.glb 为可玩角色交付物（无 engine meta）',
      manifest,
    };
  },
});

export const playableTools = [
  gen3dGetPlayableProfile,
  gen3dSetPlayableProfile,
  gen3dSetPlayableMotionMapping,
  gen3dExportPlayableCharacter,
  gen3dAdoptPlayableCharacter,
];
