// 绑骨与动作域工具 —— gen3d_auto_rig / gen3d_apply_motion / gen3d_list_motions。
//
// 业务事实来源：移植自一套内部 3D 生成工具链的绑骨/动作段，按 DSH 契约重写。差异：
// - 无 slug / COS：Meshy 绑骨经 meshyTaskRefs.resultTaskId 直传任务 id
//   （不再 shareAssetFileUrl 到 COS）；Hunyuan3D 智能拓扑类后处理仍需要
//   公网源 URL（sourceUrl 参数）；Tripo3D 绑骨只接受 Tripo 侧模型任务 id
//   （资产须由 tripo3d 生成，取 sourceJobId）；
// - rig 分发按 manifest.rig.rigProvider：meshy → actionId + rig_task_id；
//   hunyuan3d → motionType（官方 48 个 MotionType 预设）；tripo3d → preset:*；
//   legacy 'hunyuan_rest' 按 hunyuan3d 处理；
// - rig_expired 语义保留：Meshy 用官方 expires_at（expiresAtMs）显式判定，
//   mock 任务（rigTaskId 以 mock 开头）同样视为过期；
// - list-motions 的 Meshy / Tripo / Hunyuan 目录均为本地静态表（零网络
//   零配额），不再用 mock 样例（legacy 的 MOCK_MESHY_MOTIONS 仅作兜底）。

import { MESHY_FREE_RUN_ID, MESHY_FREE_WALK_ID, type MotionRef, type MotionType } from '../legacy/shared/manifest.js';
import { HUNYUAN_MOTION_TYPES } from '../providers/hunyuan3d.js';
import type { MeshyTaskResult } from '../providers/meshy.js';
import type {
  AnimationRequest,
  Gen3dProvider,
  MotionItem,
  MotionQuery,
  ProviderId,
  TaskResult,
} from '../providers/types.js';
import type { Gen3dStore } from '../storage.js';
import {
  appendDerivedFiles,
  clearRigAndMotions,
  createProvider,
  defineGen3dTool,
  getStore,
  mockModelBytes,
  providerResultFromTask,
  resolveProviderOrMock,
  resultSchema,
  toFileFormat,
  toolDeps,
  ToolError,
  type AppendDerivedFileInput,
  type DshRigChain,
  type Gen3dSidecar,
} from './common.js';

// ── 常量 ────────────────────────────────────────────────────────────────────

/** Meshy 计费参考：rig ~5 / animation ~3 credits。 */
export const MESHY_RIG_COST = 5;
export const MESHY_ANIM_COST = 3;

/** Hunyuan3D 官方 MotionType 预设 1–48（auto-rig 内置动作 / apply-motion 输入）。 */
export const HUNYUAN_MOTION_TYPE_MIN = 1;
export const HUNYUAN_MOTION_TYPE_MAX = 48;

const HUMANOID_SKELETON = {
  hasSkeleton: true,
  skeletonProfile: 'humanoid' as const,
  animationInputReady: true,
};

/** Meshy rig 结果自带的免费 walk/run 片段（保留 id，isFree 语义）。 */
function freeMotionRef(category: 'walking' | 'running'): MotionRef {
  return category === 'walking'
    ? { system: 'meshy', id: MESHY_FREE_WALK_ID, label: '走路（免费）' }
    : { system: 'meshy', id: MESHY_FREE_RUN_ID, label: '跑步（免费）' };
}

/** motionRef 的稳定性键（沿用 legacy motionRefKey）。 */
function motionRefKeyOf(ref: MotionRef): string {
  return `${ref.system}:${ref.id}`;
}

/**
 * 绑骨 / 套动作的 submit 审计（与生成类 generateCacheFirst 的 submit 事件
 * 对齐；cacheKey 不填）。只在 appendDerivedFiles 成功之后调用：成功落盘的
 * 计费提交才有账。
 */
async function auditSubmit(
  store: Gen3dStore,
  provider: ProviderId,
  mode: 'rig' | 'motion',
  sourceJobId: string | null,
  assetPath: string,
): Promise<void> {
  await store.appendAudit({ ts: new Date().toISOString(), provider, mode, event: 'submit', sourceJobId, assetPath });
}

// ── 校验辅助 ────────────────────────────────────────────────────────────────

function asString(raw: unknown, key: string, code = 'invalid_args'): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ToolError(code, `${key} 必须是非空字符串`);
  }
  return raw.trim();
}

function asPositiveInt(raw: unknown, key: string, code: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new ToolError(code, `${key} 必须为正整数，got ${String(raw)}`);
  }
  return raw;
}

function parseHeightMeters(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return undefined;
  if (n < 0.1 || n > 5) throw new ToolError('invalid_height_meters', 'heightMeters 必须在 0.1–5 之间');
  return n;
}

/** Meshy 余额预检（可选能力；失败跳过，由 402 反应式兜底）。 */
async function assertMeshyBalance(provider: Gen3dProvider, needed: number, op: string): Promise<void> {
  if (typeof provider.getBalance !== 'function') return;
  try {
    const info = await provider.getBalance();
    const balance = typeof info.balance === 'number' ? info.balance : undefined;
    if (balance !== undefined && balance < needed) {
      throw new ToolError(
        'provider_insufficient_credits',
        `${op} 约需 ${needed} Meshy credits，但当前余额 ${balance}；请充值或跳过该步骤`,
      );
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    // 余额接口失败（网络 / 未开放）→ 跳过预检，调用时由 402 反应式处理
  }
}

/** 该动作是否已套过（幂等，按 motionRef 结构键）。 */
function hasMotion(sidecar: Gen3dSidecar, ref: MotionRef): boolean {
  const key = motionRefKeyOf(ref);
  return sidecar.dependencies.some(
    (d) => d.kind === 'animated_model' && d.motionRef !== undefined && motionRefKeyOf(d.motionRef) === key,
  );
}

/** Meshy rig 任务过期判定：mock 任务或超过官方 expires_at。 */
function meshyRigStale(rig: { rigTaskId: string | null; rigExpiresAt: number | null } | undefined): boolean {
  if (!rig || !rig.rigTaskId) return true;
  if (rig.rigTaskId.startsWith('mock')) return true;
  return rig.rigExpiresAt !== null && Date.now() > rig.rigExpiresAt;
}

// ── gen3d_auto_rig ──────────────────────────────────────────────────────────

interface RigOutcome {
  files: AppendDerivedFileInput[];
  rigChain: DshRigChain;
  skeleton: typeof HUMANOID_SKELETON;
}

/**
 * 真实 Meshy 绑骨：经 meshyTaskRefs.resultTaskId 直传任务 id（无 COS）。
 * 结果追加 rigged_model GLB+FBX + 免费 walk/run 片段；rigExpiresAt 取官方
 * expires_at（毫秒 epoch）。
 */
async function meshyRig(provider: Gen3dProvider, sourceJobId: string | null, heightMeters?: number, exec?: { signal: AbortSignal }): Promise<RigOutcome> {
  const taskId = sourceJobId;
  if (!taskId || taskId.startsWith('mock')) {
    throw new ToolError(
      'missing_input_task',
      'Meshy 绑骨需要源资产的 Meshy 任务 id（sidecar custom.meshyTaskRefs.resultTaskId 或 meshy 生成的 sourceJobId）；mock / 外部资产无任务 id，无法真实绑骨',
    );
  }
  if (typeof provider.submitRig !== 'function') {
    throw new ToolError('provider_capability_missing', 'Meshy provider 未实现 submitRig（并行任务推进中）');
  }
  await assertMeshyBalance(provider, MESHY_RIG_COST, 'auto-rig');
  const handle = await provider.submitRig(
    {
      assetUrl: '',
      providerOptions: {
        input_task_id: taskId,
        ...(heightMeters !== undefined ? { height_meters: heightMeters } : {}),
      },
    },
    { signal: exec?.signal },
  );
  const result = (await provider.pollTask(handle, { signal: exec?.signal })) as MeshyTaskResult;
  const files: AppendDerivedFileInput[] = [];
  for (const f of result.files) {
    if (f.role === 'rigged_character_glb') files.push({ role: 'rigged_model', format: 'glb', data: f.buffer });
    else if (f.role === 'rigged_character_fbx') files.push({ role: 'rigged_model', format: 'fbx', data: f.buffer });
  }
  for (const ba of result.basicAnimations ?? []) {
    const ref = freeMotionRef(ba.category);
    for (const f of ba.files) {
      files.push({ role: 'animated_model', format: toFileFormat(f.format), data: f.buffer, motionRef: ref });
    }
  }
  if (!files.some((f) => f.role === 'rigged_model' && f.format === 'glb')) {
    throw new ToolError('provider_empty_download', `Meshy 绑骨任务成功但无 rigged_model GLB（${handle.taskId}）`);
  }
  return {
    files,
    rigChain: { rigProvider: 'meshy', rigTaskId: result.taskId, rigType: null, rigExpiresAt: result.expiresAtMs ?? null },
    skeleton: HUMANOID_SKELETON,
  };
}

/** 真实 Hunyuan3D 绑骨：腾讯云 API 3.0 SubmitAutoRiggingJob（需公网源 GLB URL）。 */
async function hunyuanRig(provider: Gen3dProvider, sourceUrl: string, exec?: { signal: AbortSignal }): Promise<RigOutcome> {
  if (typeof provider.submitRig !== 'function') {
    throw new ToolError('provider_capability_missing', 'Hunyuan3D provider 未实现 submitRig（并行任务推进中）');
  }
  const handle = await provider.submitRig(
    { assetUrl: sourceUrl, providerOptions: { fileType: 'GLB' } },
    { signal: exec?.signal },
  );
  const result = await provider.pollTask(handle, { signal: exec?.signal });
  const converted = await providerResultFromTask('hunyuan3d', 'image', handle.taskId, result, null);
  const files: AppendDerivedFileInput[] = converted.files.map((f) => ({
    role: 'rigged_model',
    format: f.format,
    data: f.data,
  }));
  return {
    files,
    rigChain: { rigProvider: 'hunyuan3d', rigTaskId: handle.taskId, rigType: null, rigExpiresAt: null },
    skeleton: HUMANOID_SKELETON,
  };
}

/** 真实 Tripo3D 绑骨：animate_rig 只接受 Tripo 侧模型任务 id（资产须由 tripo3d 生成）。 */
async function tripoRig(provider: Gen3dProvider, modelTaskId: string, exec?: { signal: AbortSignal }): Promise<RigOutcome> {
  if (typeof provider.submitRig !== 'function') {
    throw new ToolError('provider_capability_missing', 'Tripo3D provider 未实现 submitRig（并行任务推进中）');
  }
  const handle = await provider.submitRig({ assetUrl: modelTaskId }, { signal: exec?.signal });
  const result = await provider.pollTask(handle, { signal: exec?.signal });
  const converted = await providerResultFromTask('tripo3d', 'image', handle.taskId, result, null);
  const files: AppendDerivedFileInput[] = converted.files.map((f) => ({
    role: 'rigged_model',
    format: f.format,
    data: f.data,
  }));
  return {
    files,
    rigChain: { rigProvider: 'tripo3d', rigTaskId: handle.taskId, rigType: null, rigExpiresAt: null },
    skeleton: HUMANOID_SKELETON,
  };
}

/** mock 绑骨：确定性占位字节（rigged GLB+FBX + 免费 walk/run），零配额。 */
function mockRig(assetPath: string, rigProvider: ProviderId): RigOutcome {
  const files: AppendDerivedFileInput[] = [
    { role: 'rigged_model', format: 'glb', data: mockModelBytes(`rig-glb:${assetPath}`) },
    { role: 'rigged_model', format: 'fbx', data: mockModelBytes(`rig-fbx:${assetPath}`) },
    { role: 'animated_model', format: 'glb', data: mockModelBytes(`walk-glb:${assetPath}`), motionRef: freeMotionRef('walking') },
    { role: 'animated_model', format: 'fbx', data: mockModelBytes(`walk-fbx:${assetPath}`), motionRef: freeMotionRef('walking') },
    { role: 'animated_model', format: 'glb', data: mockModelBytes(`run-glb:${assetPath}`), motionRef: freeMotionRef('running') },
    { role: 'animated_model', format: 'fbx', data: mockModelBytes(`run-fbx:${assetPath}`), motionRef: freeMotionRef('running') },
  ];
  return {
    files,
    rigChain: { rigProvider, rigTaskId: `mock-rig:${assetPath}`, rigType: 'mock', rigExpiresAt: null },
    skeleton: HUMANOID_SKELETON,
  };
}

/**
 * 计费：自动绑骨（人形；保贴图）。按 rigProvider 分发：meshy（默认，用
 * meshyTaskRefs.resultTaskId）、hunyuan3d（sourceUrl 公网源 GLB）、tripo3d
 * （资产须由 tripo3d 生成，取 sourceJobId）。幂等：已绑骨且未 force 直接返回
 * 既有状态；force=true 先清除旧绑骨与动作再重跑。未配置 key 回退 mock。
 */
export const gen3dAutoRig = defineGen3dTool({
  name: 'gen3d_auto_rig',
  description:
    '自动绑骨：给带贴图的人形资产追加 rigged_model GLB+FBX（保贴图）并翻转 readiness.rigged，Meshy 路径附带免费走路/跑步片段。幂等：已绑骨且未 force 时不重复消耗；force=true 先清除旧绑骨与动作再重跑（重新计费）。分发：meshy（默认，经源资产 Meshy 任务 id 直传，无需公网 URL）/ hunyuan3d（需要 sourceUrl：公网可达的源 GLB URL，腾讯云 API 3.0 路径）/ tripo3d（资产须由 tripo3d 生成，经其任务 id 绑骨）。计费工具（Meshy 约 5 credits），审批确认后执行；未配置 key 回退 mock（usedMock: true）。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '待绑骨资产相对路径（characters 槽位人形）' },
    rigProvider: {
      type: 'string',
      enum: ['auto', 'meshy', 'hunyuan3d', 'tripo3d'],
      default: 'auto',
      description: '绑骨路由：auto 按 meshy → hunyuan3d → tripo3d 配置优先；显式指定则强制该路由（未配置时回退 mock）',
    },
    force: { type: 'boolean', default: false, description: '已绑骨时是否清除旧绑骨与动作并重跑（重新计费）' },
    heightMeters: { type: 'number', description: '角色近似身高（米，0.1–5；仅 Meshy；缺省官方默认 ~1.7）' },
    sourceUrl: { type: 'string', description: '源 GLB 的公网 URL（仅 hunyuan3d 路由需要；mock 不需要）' },
  },
  billing: { credits: 5, note: 'Meshy 绑骨约 5 credits；各 provider 实际消耗以官方计费为准' },
  output: { schema: resultSchema({}) },
  async run(args, exec) {
    const store = getStore();
    const assetPath = asString(args.assetPath, 'assetPath', 'invalid_asset_path');
    let sidecar = await store.readSidecar(assetPath);
    if (sidecar === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    if (sidecar.custom.readiness.rigged) {
      if (args.force !== true) {
        return {
          ok: true,
          usedMock: sidecar.custom.providerMode === 'mock',
          assetPath,
          manifest: sidecar,
        };
      }
      sidecar = await clearRigAndMotions(assetPath);
    }

    const route = typeof args.rigProvider === 'string' ? args.rigProvider : 'auto';
    const routeProvider: ProviderId =
      route === 'auto' ? 'meshy' : route === 'meshy' || route === 'hunyuan3d' || route === 'tripo3d' ? route : 'meshy';
    const heightMeters = parseHeightMeters(args.heightMeters);

    // auto：按配置优先级选第一个已配置的（meshy → hunyuan3d → tripo3d）
    let target: ProviderId = routeProvider;
    if (route === 'auto') {
      const order: ProviderId[] = ['meshy', 'hunyuan3d', 'tripo3d'];
      const configured: ProviderId[] = [];
      for (const id of order) {
        const { provider, usedMock } = await resolveProviderOrMock(id);
        if (provider) configured.push(id);
      }
      target = configured[0] ?? 'meshy';
    }

    const { provider, usedMock } = await resolveProviderOrMock(target);
    if (!provider) {
      const outcome = mockRig(assetPath, target);
      const manifest = await appendDerivedFiles({ assetPath, files: outcome.files, skeleton: outcome.skeleton, rigChain: outcome.rigChain });
      await auditSubmit(store, target, 'rig', outcome.rigChain.rigTaskId, assetPath);
      return { ok: true, usedMock: true, assetPath, manifest };
    }

    let outcome: RigOutcome;
    if (target === 'hunyuan3d') {
      const sourceUrl = asString(args.sourceUrl, 'sourceUrl', 'missing_source_url');
      outcome = await hunyuanRig(provider, sourceUrl, exec);
    } else if (target === 'tripo3d') {
      const modelTaskId = sidecar.custom.provider === 'tripo3d' ? sidecar.custom.sourceJobId : null;
      if (!modelTaskId || modelTaskId.startsWith('mock')) {
        throw new ToolError(
          'missing_input_task',
          'Tripo3D 绑骨需要 Tripo 侧模型任务 id（资产须由 tripo3d 生成，取 sourceJobId）；mock / 其他 provider 资产请先真实生成或改走 meshy/hunyuan3d 路由',
        );
      }
      outcome = await tripoRig(provider, modelTaskId, exec);
    } else {
      const sourceJobId = sidecar.custom.meshyTaskRefs?.resultTaskId ?? sidecar.custom.sourceJobId;
      outcome = await meshyRig(provider, sourceJobId, heightMeters, exec);
    }
    const manifest = await appendDerivedFiles({ assetPath, files: outcome.files, skeleton: outcome.skeleton, rigChain: outcome.rigChain });
    await auditSubmit(store, target, 'rig', outcome.rigChain.rigTaskId, assetPath);
    return { ok: true, usedMock: false, assetPath, manifest };
  },
});

// ── gen3d_apply_motion ──────────────────────────────────────────────────────

/**
 * 计费：套动作（一次一个；按动作幂等）。按 manifest.rig.rigProvider 分发：
 * meshy → actionId + rig_task_id（rig 过期按官方 expires_at 判定，rig_expired
 * 或 autoReRig 重绑）；hunyuan3d → motionType（官方 48 预设）；tripo3d → preset
 * （preset:* 预设名）。未配置 key 回退 mock。
 */
export const gen3dApplyMotion = defineGen3dTool({
  name: 'gen3d_apply_motion',
  description:
    '给已绑骨资产套一个动作（追加 animated_model GLB+FBX，翻转 readiness.animated；同一动作幂等不重复追加）。按资产记录的 rig 系统分发：Meshy（默认）用 actionId（gen3d_list_motions 的正整数 id）+ 源资产 rig 任务 id，rig 超过官方 expires_at（约 3 天）报 rig_expired，传 autoReRig=true 先重绑再套（额外计费）；Hunyuan3D 用 motionType（官方 MotionType 1–48 预设）；Tripo3D 用 preset（如 walk → preset:walk）。计费工具（Meshy 约 3 credits），审批确认后执行；未配置 key 回退 mock。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '已绑骨资产相对路径' },
    actionId: { type: 'integer', description: 'Meshy 动作 id（gen3d_list_motions 返回的正整数；Meshy 路由必填）' },
    motionType: { type: 'integer', description: 'Hunyuan3D 官方 MotionType 预设（1–48；Hunyuan 路由必填）' },
    preset: { type: 'string', description: 'Tripo3D 预设动作名（如 walk / run / idle；Tripo 路由必填，自动补 preset: 前缀）' },
    label: { type: 'string', description: '动作显示名（缺省 动作 <id>）' },
    autoReRig: { type: 'boolean', default: false, description: 'Meshy rig 已过期（或 mock）时是否先重绑再套动作（额外计费）' },
  },
  billing: { credits: 3, note: 'Meshy 套动作约 3 credits；autoReRig 时另加绑骨约 5 credits' },
  output: { schema: resultSchema({}) },
  async run(args, exec) {
    const store = getStore();
    const assetPath = asString(args.assetPath, 'assetPath', 'invalid_asset_path');
    const sidecar = await store.readSidecar(assetPath);
    if (sidecar === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    if (!sidecar.custom.readiness.rigged) {
      throw new ToolError('not_rigged', '资产未绑骨；请先运行 gen3d_auto_rig');
    }

    const rigProvider = (sidecar.custom.rig?.rigProvider as string | undefined) ?? 'meshy';
    const rig = sidecar.custom.rig;

    // ── Tripo3D 路由：preset:* 预设 ──
    if (rigProvider === 'tripo3d') {
      const presetRaw = typeof args.preset === 'string' ? args.preset.trim() : '';
      if (!presetRaw) throw new ToolError('invalid_action_id', 'Tripo3D 路由需要 preset（如 walk / run）');
      const preset = presetRaw.startsWith('preset:') ? presetRaw : `preset:${presetRaw}`;
      // 沿用 legacy MotionRef 形状：tripo preset 用 hunyuan_v2（string id）槽位表达
      const ref: MotionRef = { system: 'hunyuan_v2', id: preset, label: `Tripo ${preset}` };
      if (hasMotion(sidecar, ref)) {
        return { ok: true, usedMock: sidecar.custom.providerMode === 'mock', assetPath, manifest: sidecar };
      }
      const { provider, usedMock } = await resolveProviderOrMock('tripo3d');
      if (!provider) {
        const files: AppendDerivedFileInput[] = [
          { role: 'animated_model', format: 'glb', data: mockModelBytes(`motion-tripo-${preset}-glb:${assetPath}`), motionRef: ref },
          { role: 'animated_model', format: 'fbx', data: mockModelBytes(`motion-tripo-${preset}-fbx:${assetPath}`), motionRef: ref },
        ];
        const manifest = await appendDerivedFiles({ assetPath, files });
        await auditSubmit(store, 'tripo3d', 'motion', `mock-motion:${ref.system}-${ref.id}`, assetPath);
        return { ok: true, usedMock: true, assetPath, manifest };
      }
      if (typeof provider.submitAnimation !== 'function') {
        throw new ToolError('provider_capability_missing', 'Tripo3D provider 未实现 submitAnimation（并行任务推进中）');
      }
      const req: AnimationRequest = { rigTaskId: rig?.rigTaskId ?? '', actionId: preset, label: ref.label };
      const handle = await provider.submitAnimation(req, { signal: exec.signal });
      const result = await provider.pollTask(handle, { signal: exec.signal });
      const files = await animationFilesFromDownloads('tripo3d', handle.taskId, result, ref, exec);
      const manifest = await appendDerivedFiles({ assetPath, files });
      await auditSubmit(store, 'tripo3d', 'motion', handle.taskId, assetPath);
      return { ok: true, usedMock: false, assetPath, manifest };
    }

    // ── Hunyuan3D 路由（含 legacy 'hunyuan_rest'）：MotionType 预设 ──
    if (rigProvider === 'hunyuan3d' || rigProvider === 'hunyuan_rest') {
      const motionTypeRaw = args.motionType;
      if (typeof motionTypeRaw !== 'number' || !Number.isInteger(motionTypeRaw) || motionTypeRaw < HUNYUAN_MOTION_TYPE_MIN || motionTypeRaw > HUNYUAN_MOTION_TYPE_MAX) {
        throw new ToolError('invalid_motion_type', `motionType 必须在 ${HUNYUAN_MOTION_TYPE_MIN}–${HUNYUAN_MOTION_TYPE_MAX}（官方 48 预设），got ${String(motionTypeRaw)}`);
      }
      const entry = HUNYUAN_MOTION_TYPES.find((m) => m.id === motionTypeRaw);
      // 沿用 legacy MotionRef 形状（system 收窄为 'hunyuan_v1'；id 现覆盖官方 1–48，超出 legacy 类型 9–16）
      const ref: MotionRef = { system: 'hunyuan_v1', id: motionTypeRaw as MotionType, label: entry?.name ?? `动作 ${motionTypeRaw}` };
      if (hasMotion(sidecar, ref)) {
        return { ok: true, usedMock: sidecar.custom.providerMode === 'mock', assetPath, manifest: sidecar };
      }
      const { provider, usedMock } = await resolveProviderOrMock('hunyuan3d');
      if (!provider) {
        const files: AppendDerivedFileInput[] = [
          { role: 'animated_model', format: 'glb', data: mockModelBytes(`motion-hunyuan-${motionTypeRaw}-glb:${assetPath}`), motionRef: ref },
          { role: 'animated_model', format: 'fbx', data: mockModelBytes(`motion-hunyuan-${motionTypeRaw}-fbx:${assetPath}`), motionRef: ref },
        ];
        const manifest = await appendDerivedFiles({ assetPath, files });
        await auditSubmit(store, 'hunyuan3d', 'motion', `mock-motion:${ref.system}-${ref.id}`, assetPath);
        return { ok: true, usedMock: true, assetPath, manifest };
      }
      if (typeof provider.submitAnimation !== 'function') {
        throw new ToolError(
          'provider_capability_missing',
          'Hunyuan3D provider 未实现 submitAnimation（并行任务推进中）；Hunyuan 绑骨内置 MotionType 预设动作可在 auto-rig 时经 providerOptions.motionType 指定',
        );
      }
      const req: AnimationRequest = {
        rigTaskId: rig?.rigTaskId ?? '',
        actionId: motionTypeRaw,
        label: ref.label,
        providerOptions: { motion_type: motionTypeRaw },
      };
      const handle = await provider.submitAnimation(req, { signal: exec.signal });
      const result = await provider.pollTask(handle, { signal: exec.signal });
      const files = await animationFilesFromDownloads('hunyuan3d', handle.taskId, result, ref, exec);
      const manifest = await appendDerivedFiles({ assetPath, files });
      await auditSubmit(store, 'hunyuan3d', 'motion', handle.taskId, assetPath);
      return { ok: true, usedMock: false, assetPath, manifest };
    }

    // ── Meshy 路由（默认）：actionId + rig_task_id ──
    const actionId = asPositiveInt(args.actionId, 'actionId', 'invalid_action_id');
    const label = typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : `动作 ${actionId}`;
    const ref: MotionRef = { system: 'meshy', id: actionId, label };
    if (hasMotion(sidecar, ref)) {
      return { ok: true, usedMock: sidecar.custom.providerMode === 'mock', assetPath, manifest: sidecar };
    }

    const { provider, usedMock } = await resolveProviderOrMock('meshy');
    if (!provider) {
      const files: AppendDerivedFileInput[] = [
        { role: 'animated_model', format: 'glb', data: mockModelBytes(`motion-meshy-${actionId}-glb:${assetPath}`), motionRef: ref },
        { role: 'animated_model', format: 'fbx', data: mockModelBytes(`motion-meshy-${actionId}-fbx:${assetPath}`), motionRef: ref },
      ];
      const manifest = await appendDerivedFiles({ assetPath, files });
      await auditSubmit(store, 'meshy', 'motion', `mock-motion:${ref.system}-${ref.id}`, assetPath);
      return { ok: true, usedMock: true, assetPath, manifest };
    }

    const willReRig = meshyRigStale(rig);
    if (willReRig && args.autoReRig !== true) {
      return {
        ok: false,
        code: 'rig_expired',
        message: 'Meshy rig 任务已过期（超过官方 expires_at 或为 mock）；重跑 gen3d_auto_rig 或传 autoReRig: true',
        retryable: true,
      };
    }
    await assertMeshyBalance(provider, (willReRig ? MESHY_RIG_COST : 0) + MESHY_ANIM_COST, 'apply-motion');
    if (willReRig) {
      const sourceJobId = sidecar.custom.meshyTaskRefs?.resultTaskId ?? sidecar.custom.sourceJobId;
      const outcome = await meshyRig(provider, sourceJobId, undefined, exec);
      await appendDerivedFiles({ assetPath, files: outcome.files, skeleton: outcome.skeleton, rigChain: outcome.rigChain });
      await auditSubmit(store, 'meshy', 'rig', outcome.rigChain.rigTaskId, assetPath);
    }
    const rigTaskId = (await store.readSidecar(assetPath))?.custom.rig?.rigTaskId;
    if (!rigTaskId) {
      return { ok: false, code: 'rig_expired', message: '资产没有 Meshy rig 任务 id；请重跑 gen3d_auto_rig', retryable: true };
    }
    const req: AnimationRequest = { rigTaskId, actionId, label };
    if (typeof provider.submitAnimation !== 'function') {
      throw new ToolError('provider_capability_missing', 'Meshy provider 未实现 submitAnimation（并行任务推进中）');
    }
    const handle = await provider.submitAnimation(req, { signal: exec.signal });
    const result = (await provider.pollTask(handle, { signal: exec.signal })) as MeshyTaskResult;
    const files: AppendDerivedFileInput[] = [];
    for (const f of result.files) {
      if (f.role === 'animation_glb') files.push({ role: 'animated_model', format: 'glb', data: f.buffer, motionRef: ref });
      else if (f.role === 'animation_fbx') files.push({ role: 'animated_model', format: 'fbx', data: f.buffer, motionRef: ref });
    }
    if (files.length === 0) {
      throw new ToolError('provider_empty_download', `Meshy 套动作任务成功但无动画资产（${handle.taskId}）`);
    }
    const manifest = await appendDerivedFiles({ assetPath, files });
    await auditSubmit(store, 'meshy', 'motion', handle.taskId, assetPath);
    return { ok: true, usedMock: false, assetPath, manifest };
  },
});

/** 契约级动作结果（hunyuan3d / tripo3d 的 downloads URL）→ animated_model 字节。 */
async function animationFilesFromDownloads(
  providerId: ProviderId,
  taskId: string,
  result: TaskResult,
  ref: MotionRef,
  exec: { signal: AbortSignal },
): Promise<AppendDerivedFileInput[]> {
  const converted = await providerResultFromTask(providerId, 'image', taskId, result, null);
  const files: AppendDerivedFileInput[] = converted.files.map((f) => ({
    role: 'animated_model',
    format: f.format,
    data: f.data,
    motionRef: ref,
  }));
  if (files.length === 0) {
    throw new ToolError('provider_empty_download', `${providerId} 套动作任务成功但无动画资产（${taskId}）`);
  }
  return files;
}

// ── gen3d_list_motions ──────────────────────────────────────────────────────

/** 本地只读：动作目录（Meshy 官方静态目录 ~680 条 / Hunyuan 48 预设 / Tripo 16 preset），零网络零配额。 */
export const gen3dListMotions = defineGen3dTool({
  name: 'gen3d_list_motions',
  description:
    '查询动作目录（本地静态表，零网络零配额，不审批）。按资产 rig 系统收窄：传 assetPath 时按其 rig 来源返回对应目录（Meshy 官方 ~680 条静态目录 / Hunyuan3D 官方 48 个 MotionType 预设 / Tripo3D 16 个 preset:* 预设），否则默认 Meshy 目录。用 query（名称 / id 子串）、category、rigType 收窄；目录可能很大，务必带收窄条件。',
  parameters: {
    assetPath: { type: 'string', description: '资产相对路径（按其 rig 来源返回对应目录；缺省 Meshy 目录）' },
    query: { type: 'string', description: '名称 / id 子串过滤' },
    category: { type: 'string', description: '动作分类过滤（Meshy：DailyActions / WalkAndRun / …；Tripo：Biped / Quadruped / …）' },
    rigType: { type: 'string', description: '骨架兼容类型过滤（宽松匹配：未知 rigType 视为匹配）' },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const query: MotionQuery = {
      query: typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined,
      category: typeof args.category === 'string' && args.category.trim() ? args.category.trim() : undefined,
      rigType: typeof args.rigType === 'string' && args.rigType.trim() ? args.rigType.trim() : undefined,
    };

    let system: 'meshy' | 'hunyuan_v1' | 'tripo3d' = 'meshy';
    const assetPath = typeof args.assetPath === 'string' ? args.assetPath.trim() : '';
    if (assetPath) {
      const sidecar = await store.readSidecar(assetPath);
      const rigProvider = sidecar?.custom.rig?.rigProvider as string | undefined;
      if (rigProvider === 'hunyuan3d' || rigProvider === 'hunyuan_rest') system = 'hunyuan_v1';
      else if (rigProvider === 'tripo3d') system = 'tripo3d';
    }

    const providerId: ProviderId = system === 'tripo3d' ? 'tripo3d' : system === 'hunyuan_v1' ? 'hunyuan3d' : 'meshy';
    const deps = toolDeps();
    const factory = deps.providerFactory ?? createProvider;
    const provider = await factory(providerId, {
      fetchImpl: deps.fetchImpl,
      pollIntervalMs: deps.pollIntervalMs,
      pollTimeoutMs: deps.pollTimeoutMs,
      sleep: deps.sleep,
    });

    let items: MotionItem[] = [];
    if (typeof provider.listMotions === 'function') {
      items = await provider.listMotions(query);
    }
    const motions = items.map((m) => ({
      system,
      id: m.id,
      label: m.label,
      category: m.category ?? null,
      rigType: m.rigType ?? null,
      isFree: m.isFree ?? false,
      previewUrl: m.previewUrl ?? null,
    }));
    return {
      ok: true,
      system,
      usedMock: false, // 本地静态目录，零网络零配额（不再用 legacy mock 样例）
      total: motions.length,
      motions,
    };
  },
});

export const animationTools = [gen3dAutoRig, gen3dApplyMotion, gen3dListMotions];
