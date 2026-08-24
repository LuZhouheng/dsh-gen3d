// 生成域工具 —— gen3d 文本 / 图像 / 多视图生 3D、精修、低模重拓扑、
// provider 状态、资产盘点 / 删除 / 重命名、质量评分、凭证状态。
//
// 业务事实来源：移植自一套内部 3D 生成工具链的生成域逻辑，按 DSH 契约重写；差异：
// - 无 slug：资产归属由 DSH 工作区（GEN3D_WORKSPACE_ROOT / cwd）决定；
// - 图片输入三形态：URL 直填（四家）/ base64（仅 Meshy / Hunyuan3D）/
//   本地路径（仅 Tripo3D，工具层读取字节经 provider.uploadImage 上传）；
// - provider 未配置 → 确定性 mock（usedMock: true），见 common.ts。
//
// 工具名 gen3d_*（snake_case）。

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isProviderConfigured, providerEnvKeyOf, redactKey } from '../config.js';
import { QUALITY_RUBRIC, clampTargetPolycount, makeCacheKey } from '../legacy/shared/catalog.js';
import type { AssetSlot, GenerationMode } from '../legacy/shared/manifest.js';
import { DEFAULT_WEIGHTS, weightedTotal } from '../legacy/shared/quality/heuristics.js';
import {
  emptyQualityReport,
  type QualityReport,
} from '../legacy/shared/manifest.js';
import type { MeshyTaskResult } from '../providers/meshy.js';
import type { Gen3dProvider, GenMode, ProviderId, TaskHandle, TaskResult } from '../providers/types.js';
import {
  defineGen3dTool,
  generateCacheFirst,
  getStore,
  meshyFilesToProviderFiles,
  mockProviderResult,
  providerResultFromTask,
  resolveProviderOrMock,
  resultSchema,
  sanitizeStem,
  sha256Hex,
  ToolError,
  type GenerationCtx,
  type ToolProviderResult,
} from './common.js';

// ── 常量与展示信息 ───────────────────────────────────────────────────────────

const PROVIDERS: readonly ProviderId[] = ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'];

const PROVIDER_NAMES: Record<ProviderId, string> = {
  meshy: 'Meshy',
  hunyuan3d: 'Hunyuan3D（腾讯混元）',
  tripo3d: 'Tripo3D',
  rodin: 'Rodin（Hyper3D）',
};

const PROVIDER_INFO: Record<ProviderId, { models: string[]; note: string }> = {
  meshy: {
    models: ['meshy-5', 'meshy-6', 'meshy-7', 'latest', 'meshy-t1', 'meshy-t2'],
    note: '文生两阶段（preview→refine）、图生、多视图、精修、重拓扑（remesh）、绑骨、动作、余额查询；latest 现解析为 Meshy 7；base64 图片输入支持',
  },
  hunyuan3d: {
    models: ['hy-3d-3.0', 'hy-3d-3.1'],
    note: 'TokenHub 生成（文/图/多视图）+ 腾讯云 API 3.0 后处理（自动绑骨 48 预设动作 / 智能拓扑 / 文生动作）；图片输入需公网 URL 或 base64',
  },
  tripo3d: {
    models: ['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'P1-20260311'],
    note: '文/图/多视图单任务出成品；16 个 preset 动作；本地图片上传支持；图片输入不接受 base64',
  },
  rodin: {
    models: ['Gen-1', 'Gen-1.5', 'Gen-2', 'Gen-2.5'],
    note: 'multipart 直传；图片输入需公网 URL（官方要求 Business 订阅）',
  },
};

/** providerParams 白名单（按各家官方协议字段；数组型透传参数亦在此列）。 */
const PP_ALLOW: Record<ProviderId, readonly string[]> = {
  meshy: [
    'ai_model', 'model_type', 'target_polycount', 'pose_mode', 'should_remesh', 'ultra_mode',
    'should_texture', 'image_enhancement', 'remove_lighting', 'moderation', 'target_formats',
    'auto_size', 'alpha_thumbnail', 'multi_view_thumbnails', 'enable_pbr', 'texture_resolution',
    'texture_prompt', 'texture_image_url',
    // 2026-08-24 官方现行字段：preview 减面档位（1–4，与 target_polycount 互斥）/
    // 输出拓扑（quad/triangle）/ 原点设置 / multi-image 的 1–4 张贴图引导
    // （texture_image_urls 与 texture_image_url/texture_prompt 互斥由服务端校验）
    'decimation_mode', 'topology', 'origin_at', 'texture_image_urls',
  ],
  hunyuan3d: ['model', 'generate_type', 'polygon_type', 'result_format', 'view_names'],
  tripo3d: ['model_version', 'negative_prompt', 'model_seed', 'file_token', 'original_task_id'],
  rodin: ['tier', 'quality', 'mesh_mode', 'material', 'quality_override', 'TAPose', 'use_original_alpha'],
};

// ── 参数校验与转换辅助 ───────────────────────────────────────────────────────

function asProvider(raw: unknown, fallback: ProviderId): ProviderId {
  const v = String(raw ?? '');
  if (v === '') return fallback;
  if ((PROVIDERS as readonly string[]).includes(v)) return v as ProviderId;
  throw new ToolError('invalid_args', `不支持的 provider：${v}（可选 ${PROVIDERS.join(' / ')}）`);
}

function asString(raw: unknown, key: string, code = 'invalid_args'): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ToolError(code, `${key} 必须是非空字符串`);
  }
  return raw.trim();
}

function asNumber(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** meshy remesh 目标面数钳制：100–300,000（越界钳、非整数四舍五入）。 */
function clampRemeshPolycount(value: number): number {
  if (!Number.isFinite(value)) return 30000;
  return Math.min(300000, Math.max(100, Math.round(value)));
}

function asRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function resolveSlot(raw: unknown): AssetSlot {
  return raw === 'meshes' ? 'meshes' : 'characters';
}

/** 资产基底名：显式命名优先，缺省用 prompt 首行（清洗由存储层落盘前完成）。 */
function defaultName(raw: unknown, fallback: string): string {
  const n = typeof raw === 'string' ? raw.trim() : '';
  return n.length > 0 ? n : fallback;
}

/** 按 provider 白名单过滤 providerParams（值只保留标量 / 数组；其余丢弃）。 */
function filterProviderParams(
  provider: ProviderId,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!raw) return out;
  for (const key of PP_ALLOW[provider]) {
    const v = raw[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      if (v.trim()) out[key] = v.trim();
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = v;
    } else if (typeof v === 'boolean') {
      out[key] = v;
    } else if (Array.isArray(v) && v.length > 0) {
      out[key] = v.map(String);
    }
  }
  return out;
}

/** 过滤后的 providerParams → 缓存键位（pp: 前缀；数组序列化为 JSON 串）。 */
function cacheBitsOf(filtered: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(filtered)) {
    out[`pp:${k}`] = Array.isArray(v) ? JSON.stringify(v) : (v as string | number | boolean);
  }
  return out;
}

/** 缓存键包装：新契约 ProviderId → legacy makeCacheKey 的 ProviderId 参数（fnv1a 键只取字符串拼接，值不受影响）。 */
function genCacheKey(
  provider: ProviderId,
  mode: GenerationMode,
  payload: Record<string, string | number | boolean>,
): string {
  return makeCacheKey(provider as unknown as 'meshy', mode, payload);
}

/** base64 图片输入（容忍 data: 前缀）→ 裸 base64。 */
function stripDataUriPrefix(raw: string): string {
  const comma = raw.indexOf(',');
  return raw.startsWith('data:') && comma !== -1 ? raw.slice(comma + 1) : raw;
}

/** base64 图片输入 → data URI（Meshy 官方 image_url 字段接受）。 */
function toDataUri(raw: string): string {
  return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
}

// ── 生成 produce（cache 未命中才执行；provider 未配置回退 mock） ──────────────

interface GenInput {
  providerId: ProviderId;
  mode: GenMode;
  prompt: string | null;
  faceCount: number;
  enablePbr: boolean;
  pp: Record<string, unknown>;
  /** image / views 的参考图输入（见各工具构造）。 */
  imageUrls?: string[];
  imageBase64?: string;
  providerOptionsExtra?: Record<string, unknown>;
}

/** Meshy 文生两阶段：preview（几何）→ refine（贴图）；enablePbr=false 保持 preview-only（沿用 legacy）。 */
async function produceMeshyText(
  provider: Gen3dProvider,
  input: GenInput,
  exec: { signal: AbortSignal },
): Promise<ToolProviderResult> {
  const providerOptions: Record<string, unknown> = { ...input.pp, target_polycount: input.faceCount };
  const previewHandle = await provider.submitGeneration(
    { mode: 'text', prompt: input.prompt ?? '', providerOptions },
    { signal: exec.signal },
  );
  const preview = (await provider.pollTask(previewHandle, { signal: exec.signal })) as MeshyTaskResult;
  if (input.enablePbr === false) {
    return {
      provider: 'meshy',
      mode: 'text',
      providerMode: 'real',
      sourceJobId: preview.taskId,
      prompt: input.prompt,
      files: meshyFilesToProviderFiles(preview),
      meshyTaskRefs: { previewTaskId: preview.taskId, resultTaskId: preview.taskId },
    };
  }
  const refineHandle = await provider.submitGeneration(
    {
      mode: 'text',
      prompt: input.prompt ?? '',
      providerOptions: { ...providerOptions, mode: 'refine', preview_task_id: preview.taskId, enable_pbr: true },
    },
    { signal: exec.signal },
  );
  const refined = (await provider.pollTask(refineHandle, { signal: exec.signal })) as MeshyTaskResult;
  return {
    provider: 'meshy',
    mode: 'text',
    providerMode: 'real',
    sourceJobId: refined.taskId,
    prompt: input.prompt,
    files: meshyFilesToProviderFiles(refined),
    meshyTaskRefs: { previewTaskId: preview.taskId, resultTaskId: refined.taskId },
  };
}

async function produceGeneration(
  input: GenInput,
  exec: { signal: AbortSignal },
): Promise<ToolProviderResult> {
  const { providerId, mode, prompt, pp } = input;
  const { provider, usedMock } = await resolveProviderOrMock(providerId);
  if (!provider) return mockProviderResult(providerId, mode, prompt);

  if (providerId === 'meshy' && mode === 'text') {
    return produceMeshyText(provider, input, exec);
  }
  const providerOptions: Record<string, unknown> = { ...pp };
  if (providerId === 'hunyuan3d') {
    // TokenHub / TC3 统一字段：enable_pbr / face_count（TC3 侧由 provider 映射为 EnablePBR / FaceCount）；
    // base64 优先于 URL（TokenHub / TC3 都按 image_base64 分支）
    if (input.enablePbr !== undefined) providerOptions.enable_pbr = input.enablePbr;
    if (input.faceCount !== undefined) providerOptions.face_count = input.faceCount;
    if (input.imageBase64) providerOptions.image_base64 = stripDataUriPrefix(input.imageBase64);
    if (input.providerOptionsExtra) Object.assign(providerOptions, input.providerOptionsExtra);
  }
  if (providerId === 'tripo3d' && input.providerOptionsExtra) {
    Object.assign(providerOptions, input.providerOptionsExtra);
  }
  const handle = await provider.submitGeneration(
    { mode, prompt: prompt ?? '', imageUrls: input.imageUrls, providerOptions },
    { signal: exec.signal },
  );
  const result = await provider.pollTask(handle, { signal: exec.signal });
  if (providerId === 'meshy') {
    // Meshy 已内部下载并校验字节：直接用 files（避免对签名 URL 二次下载）
    const typed = result as MeshyTaskResult;
    return {
      provider: 'meshy',
      mode: mode as GenerationMode,
      providerMode: 'real',
      sourceJobId: typed.taskId,
      prompt,
      files: meshyFilesToProviderFiles(typed),
    };
  }
  return providerResultFromTask(providerId, mode, handle.taskId, result, prompt);
}

// ── gen3d_provider_status ───────────────────────────────────────────────────

/** 只读：四家 provider 能力 / 配置状态（不审批、不计费）。 */
export const gen3dProviderStatus = defineGen3dTool({
  name: 'gen3d_provider_status',
  description:
    '查询四家 3D 生成供应商（Meshy / Hunyuan3D / Tripo3D / Rodin）的官方 API 配置状态、可用模型与能力说明。未配置 key 的 provider 在计费类工具中会回退确定性 mock（结果带 usedMock: true），本工具不产生任何调用。',
  parameters: {},
  output: { schema: resultSchema({}) },
  async run() {
    const providers = PROVIDERS.map((id) => {
      const configured = isProviderConfigured(id);
      return {
        providerId: id,
        providerName: PROVIDER_NAMES[id],
        configured,
        mode: configured ? 'real' : 'mock',
        models: PROVIDER_INFO[id].models,
        note: PROVIDER_INFO[id].note,
        reason: configured
          ? '官方 API key 已配置，真实调用可用'
          : '未配置 key；计费类工具将回退确定性 mock（usedMock: true，不消耗配额）',
      };
    });
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      quotaSafe: providers.every((p) => !p.configured),
      rubric: [...QUALITY_RUBRIC],
      providers,
    }
  },
});

// ── gen3d_credentials_status ────────────────────────────────────────────────

/** 只读：各家凭证配置状态（掩码展示；替代 legacy get-credentials，只读不写）。 */
export const gen3dCredentialsStatus = defineGen3dTool({
  name: 'gen3d_credentials_status',
  description:
    '只读查询各家供应商官方 API 凭证的配置状态（MESHY_API_KEY / HUNYUAN3D_API_KEY(+HUNYUAN3D_SECRET_ID/HUNYUAN3D_SECRET_KEY) / TRIPO3D_API_KEY / RODIN_API_KEY）。key 只以掩码展示（前 4 后 4），绝不输出完整密钥；本工具不修改任何凭证。',
  parameters: {},
  output: { schema: resultSchema({}) },
  async run() {
    const providers = PROVIDERS.map((id) => {
      const envName = providerEnvKeyOf(id);
      const key = process.env[envName];
      const configured = isProviderConfigured(id);
      return {
        providerId: id,
        envName,
        configured,
        source: configured ? (key && key.trim() !== '' ? 'env' : 'file') : null,
        ...(configured ? { keyMasked: redactKey(key ?? '') } : {}),
      };
    });
    const hunyuanSecretIdConfigured =
      (process.env.HUNYUAN3D_SECRET_ID ?? '') !== '' || isProviderConfigured('hunyuan3d');
    return {
      ok: true,
      providers,
      note: 'Hunyuan3D 双路径：HUNYUAN3D_API_KEY（TokenHub）或 HUNYUAN3D_SECRET_ID + HUNYUAN3D_SECRET_KEY（腾讯云 API 3.0）；密钥只写 $DSH_HOME/.credentials.yaml / 环境变量，本插件不内置任何 key。',
    }
  },
});

// ── gen3d_list_assets / gen3d_delete_asset / gen3d_rename_asset ──────────────

/** 只读：工作区 3D 资产盘点（稳定资产路径 + sidecar）。 */
export const gen3dListAssets = defineGen3dTool({
  name: 'gen3d_list_assets',
  description:
    '盘点当前 DSH 工作区（GEN3D_WORKSPACE_ROOT 或 cwd）的 3D 资产（assets/3d/{characters,meshes}/）。返回稳定资产路径（assetPath）与完整 sidecar（provider / providerMode / mode / readiness / cacheKey / rig 等）。',
  parameters: {
    assetSlot: { type: 'string', enum: ['characters', 'meshes'], description: '按槽位过滤（缺省全部）' },
    provider: {
      type: 'string',
      enum: ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'],
      description: '按生成 provider 过滤（缺省全部）',
    },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const slot = args.assetSlot === 'characters' || args.assetSlot === 'meshes' ? (args.assetSlot as AssetSlot) : undefined;
    const provider = args.provider === undefined ? undefined : asProvider(args.provider, 'meshy');
    const all = await store.listAssets(slot);
    const assets = provider === undefined ? all : all.filter((a) => a.sidecar?.custom.provider === provider);
    return {
      ok: true,
      count: assets.length,
      assets: assets.map((a) => ({ assetPath: a.assetPath, slot: a.slot, sidecar: a.sidecar })),
    }
  },
});

/** 破坏性：删除资产（主文件 + sidecar + 依赖文件），并对指向它的 cacheKey 打 tombstone（不复用、不重烧配额）。 */
export const gen3dDeleteAsset = defineGen3dTool({
  name: 'gen3d_delete_asset',
  description:
    '删除一个 3D 资产（主 GLB + sidecar + 同基准名侧文件），并对指向该资产的缓存键打 tombstone，防止缓存复活已删资产。破坏性操作，请确认 assetPath 后再调用。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '资产相对工作区的路径，如 assets/3d/characters/hero.glb' },
  },
  output: { schema: resultSchema({ assetPath: { type: 'string' }, deleted: { type: 'boolean' }, tombstoned: { type: 'boolean' } }) },
  async run(args) {
    const store = getStore();
    const assetPath = asString(args.assetPath, 'assetPath', 'invalid_asset_path');
    const sidecar = await store.readSidecar(assetPath);
    const deleted = await store.deleteAsset(assetPath);
    return {
      ok: true,
      assetPath,
      deleted,
      tombstoned: deleted && sidecar?.custom.cacheKey !== undefined,
    }
  },
});

/** 显示名重命名（userLabel），不动磁盘路径、不重烧配额。 */
export const gen3dRenameAsset = defineGen3dTool({
  name: 'gen3d_rename_asset',
  description:
    '设置资产的显示名（userLabel，写入 sidecar custom.userLabel）。只改显示名，磁盘路径与缓存键不变；传 null 清除显示名。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '资产相对路径' },
    label: {
      oneOf: [
        { type: 'string', description: '新的显示名（空字符串视为清除）' },
        { type: 'null', description: '清除显示名' },
      ],
      required: true,
      description: '显示名或 null',
    },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const assetPath = asString(args.assetPath, 'assetPath', 'invalid_asset_path');
    const label = typeof args.label === 'string' && args.label.trim() !== '' ? args.label.trim() : null;
    const manifest = await store.updateSidecar(assetPath, (s) => ({
      ...s,
      custom: { ...s.custom, ...(label !== null ? { userLabel: label } : { userLabel: null }) },
    }));
    return { ok: true, assetPath, userLabel: label, manifest }
  },
});

// ── gen3d_text_to_3d ────────────────────────────────────────────────────────

/** 计费：文生 3D（Meshy 两阶段 / Hunyuan / Tripo / Rodin）；未配置 key 回退 mock。 */
export const gen3dTextTo3d = defineGen3dTool({
  name: 'gen3d_text_to_3d',
  description:
    '文生 3D：按提示词生成带贴图的 3D 模型并落盘为工作区资产。Meshy 走两阶段（几何 preview → 贴图 refine；enablePbr=false 保持仅几何）；Hunyuan3D 走 TokenHub（hy-3d-3.0/3.1）；Tripo3D / Rodin 单任务出成品。计费工具：消耗 provider 配额，审批确认后执行；provider 未配置时回退确定性 mock（usedMock: true，不消耗配额）。',
  parameters: {
    prompt: { type: 'string', required: true, description: '物体描述（中文 / 英文均可，最长 600 字符）' },
    provider: {
      type: 'string',
      enum: ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'],
      default: 'meshy',
      description: '生成供应商（默认 meshy）',
    },
    assetSlot: { type: 'string', enum: ['characters', 'meshes'], default: 'characters', description: '落盘槽位（角色 / 网格）' },
    assetName: { type: 'string', description: '资产名（不含扩展名；缺省取 prompt 首行）' },
    targetPolycount: {
      type: 'integer',
      default: 30000,
      description: '目标面数（1,000–300,000，越界钳制；仅 Meshy / Hunyuan 生效）',
    },
    enablePbr: { type: 'boolean', default: true, description: 'Meshy：是否追加 PBR 贴图（false 时仅几何 preview）' },
    providerParams: { type: 'object', additionalProperties: true, description: '供应商私有参数透传（按各家官方字段，白名单过滤；Meshy：ai_model 缺省 latest=Meshy 7 代、低模风格化用 model_type=smart-topology+ai_model=meshy-t2、更精细表面用 ultra_mode=true+5 积分；Hunyuan 如 model/generate_type）' },
  },
  billing: { credits: 30, note: 'Meshy 两阶段：preview 20（meshy-6/7；meshy-5/meshy-t2 为 5）+ refine 10（8k 纹理 15）；ultra_mode 另 +5；各 provider 实际消耗以官方计费为准' },
  output: { schema: resultSchema({}) },
  async run(args, exec) {
    const providerId = asProvider(args.provider, 'meshy');
    const prompt = asString(args.prompt, 'prompt', 'invalid_prompt');
    const slot = resolveSlot(args.assetSlot);
    const faceCount = clampTargetPolycount(asNumber(args.targetPolycount, 30000));
    const enablePbr = args.enablePbr === undefined ? true : Boolean(args.enablePbr);
    const pp = filterProviderParams(providerId, asRecord(args.providerParams));
    const cacheKey = genCacheKey(providerId, 'text', {
      assetSlot: slot,
      prompt,
      faceCount,
      enablePbr,
      ...(providerId === 'meshy' ? { shouldTexture: true } : {}),
      ...cacheBitsOf(pp),
    });
    const ctx: GenerationCtx = {
      provider: providerId,
      mode: 'text',
      cacheKey,
      slot,
      assetName: defaultName(args.assetName, prompt),
      prompt,
      faceCount,
    };
    return generateCacheFirst(ctx, () =>
      produceGeneration({ providerId, mode: 'text', prompt, faceCount, enablePbr, pp }, exec),
    );
  },
});

// ── gen3d_image_to_3d ───────────────────────────────────────────────────────

/** 计费：图生 3D。图片输入三形态：URL 直填（四家）/ base64（仅 Meshy / Hunyuan3D）/ 本地路径（仅 Tripo3D）。 */
export const gen3dImageTo3d = defineGen3dTool({
  name: 'gen3d_image_to_3d',
  description:
    '图生 3D：以一张参考图生成 3D 模型并落盘。图片输入三选一：imageUrl（公网直链，四家都支持；Rodin / Tripo3D 必填此形态）、imageBase64（仅 Meshy / Hunyuan3D 支持）、imageFilePath（本地图片路径，仅 Tripo3D 支持，工具层读取字节并上传）。Hunyuan3D 与 Rodin 需要公网可达 URL（本地图请先转 base64 走 Meshy/Hunyuan 或传 URL）。计费工具，审批确认后执行；未配置 key 回退 mock。',
  parameters: {
    imageUrl: { type: 'string', description: '参考图公网直链（http/https）' },
    imageBase64: { type: 'string', description: '参考图 base64（可带 data: 前缀；仅 Meshy / Hunyuan3D）' },
    imageFilePath: { type: 'string', description: '本地图片绝对路径（仅 Tripo3D；其余 provider 报 not_supported）' },
    provider: {
      type: 'string',
      enum: ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'],
      default: 'meshy',
      description: '生成供应商（默认 meshy）',
    },
    assetSlot: { type: 'string', enum: ['characters', 'meshes'], default: 'characters', description: '落盘槽位' },
    assetName: { type: 'string', description: '资产名（缺省 image-<provider>）' },
    targetPolycount: { type: 'integer', default: 30000, description: '目标面数（仅 Meshy / Hunyuan 生效）' },
    enablePbr: { type: 'boolean', default: true, description: '是否启用 PBR 贴图' },
    providerParams: { type: 'object', additionalProperties: true, description: '供应商私有参数透传（白名单过滤）' },
  },
  billing: { credits: 30, note: 'Meshy 图生（meshy-6/7）：有纹理 30 / 无纹理 20 / 8K 纹理 35，ultra_mode 另 +5；meshy-t1/t2 为 30/20、5/15/20 档；各 provider 实际消耗以官方计费为准' },
  output: { schema: resultSchema({}) },
  async run(args, exec) {
    const providerId = asProvider(args.provider, 'meshy');
    const slot = resolveSlot(args.assetSlot);
    const faceCount = clampTargetPolycount(asNumber(args.targetPolycount, 30000));
    const enablePbr = args.enablePbr === undefined ? true : Boolean(args.enablePbr);
    const pp = filterProviderParams(providerId, asRecord(args.providerParams));

    const imageUrl = typeof args.imageUrl === 'string' ? args.imageUrl.trim() : '';
    const imageBase64 = typeof args.imageBase64 === 'string' ? args.imageBase64.trim() : '';
    const imageFilePath = typeof args.imageFilePath === 'string' ? args.imageFilePath.trim() : '';
    if (!imageUrl && !imageBase64 && !imageFilePath) {
      throw new ToolError('invalid_image_url', 'imageUrl / imageBase64 / imageFilePath 必须提供其一');
    }
    if (imageBase64 && providerId !== 'meshy' && providerId !== 'hunyuan3d') {
      throw new ToolError('not_supported', `${PROVIDER_NAMES[providerId]} 不支持 base64 图片输入（官方仅 URL/上传）；请传 imageUrl`);
    }
    if (imageFilePath && providerId !== 'tripo3d') {
      throw new ToolError('not_supported', `${PROVIDER_NAMES[providerId]} 不支持本地路径上传（仅 Tripo3D）；请传公网 imageUrl`);
    }

    // 缓存键用稳定输入指纹：URL 原样；base64 / 本地文件用内容 sha256（避免把大串写进键）
    let inputFingerprint: string;
    let fileBytes: Uint8Array | undefined;
    if (imageFilePath) {
      try {
        fileBytes = new Uint8Array(await readFile(imageFilePath));
      } catch (err) {
        throw new ToolError('invalid_image_url', `读取本地图片失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (fileBytes.byteLength === 0) throw new ToolError('invalid_image_url', '本地图片为空');
      inputFingerprint = `file:${sha256Hex(fileBytes)}`;
    } else if (imageBase64) {
      inputFingerprint = `b64:${sha256Hex(new TextEncoder().encode(stripDataUriPrefix(imageBase64)))}`;
    } else {
      inputFingerprint = imageUrl;
    }

    const cacheKey = genCacheKey(providerId, 'image', {
      assetSlot: slot,
      [providerId === 'tripo3d' && imageFilePath ? 'filePath' : 'imageInput']: inputFingerprint,
      faceCount,
      enablePbr,
      ...(providerId === 'meshy' ? { shouldTexture: true } : {}),
      ...cacheBitsOf(pp),
    });
    const ctx: GenerationCtx = {
      provider: providerId,
      mode: 'image',
      cacheKey,
      slot,
      assetName: defaultName(args.assetName, `image-${providerId}`),
      prompt: null,
      faceCount,
    };

    // providerOptionsExtra：三形态各自的 provider 侧输入（cache 未命中才构造）
    return generateCacheFirst(ctx, async () => {
      const { provider, usedMock } = await resolveProviderOrMock(providerId);
      if (!provider) return mockProviderResult(providerId, 'image', null);
      const providerOptionsExtra: Record<string, unknown> = {};
      if (providerId === 'tripo3d' && imageFilePath && fileBytes) {
        const upload = provider as Gen3dProvider & { uploadImage?: (data: Uint8Array, filename?: string, opts?: { signal?: AbortSignal }) => Promise<string> };
        if (typeof upload.uploadImage !== 'function') {
          throw new ToolError('provider_capability_missing', 'Tripo3D provider 未实现 uploadImage（并行任务进行中）');
        }
        const fileName = imageFilePath.split('/').pop() ?? 'image.png';
        providerOptionsExtra.file_token = await upload.uploadImage(fileBytes, fileName, { signal: exec.signal });
      }
      return produceGeneration(
        {
          providerId,
          mode: 'image',
          prompt: null,
          faceCount,
          enablePbr,
          pp,
          imageUrls: imageBase64 ? [toDataUri(imageBase64)] : imageUrl ? [imageUrl] : undefined,
          imageBase64: imageBase64 || undefined,
          providerOptionsExtra,
        },
        exec,
      );
    });
  },
});

// ── gen3d_views_to_3d ───────────────────────────────────────────────────────

/** 计费：多视图生 3D（front 必填；Meshy 按 [前,后,左,右] 顺序、Tripo3D 按 [前,左,后,右]、Hunyuan 按视角名映射）。 */
export const gen3dViewsTo3d = defineGen3dTool({
  name: 'gen3d_views_to_3d',
  description:
    '多视图生 3D：用同一物体多个角度的参考图生成 3D 模型（至少 front）。视图键沿用 legacy：front_image_url / back_image_url / left_image_url / right_image_url，均为公网直链。Meshy 按 [前,后,左,右] 顺序提交；Tripo3D 按官方 [前,左,后,右] 顺序；Hunyuan3D 按视角名映射（hy-3d-3.0 三视图 / 3.1 八视图）。计费工具，审批确认后执行；未配置 key 回退 mock。',
  parameters: {
    views: {
      type: 'object',
      additionalProperties: false,
      properties: {
        front_image_url: { type: 'string', required: true, description: '正面参考图 URL（必填）' },
        back_image_url: { type: 'string', description: '背面参考图 URL' },
        left_image_url: { type: 'string', description: '左面参考图 URL' },
        right_image_url: { type: 'string', description: '右面参考图 URL' },
      },
      description: '多视角参考图（键为 *_image_url；front 必填）',
    },
    provider: {
      type: 'string',
      enum: ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'],
      default: 'meshy',
      description: '生成供应商（默认 meshy）',
    },
    assetSlot: { type: 'string', enum: ['characters', 'meshes'], default: 'characters', description: '落盘槽位' },
    assetName: { type: 'string', description: '资产名（缺省 views-<provider>）' },
    targetPolycount: { type: 'integer', default: 30000, description: '目标面数（仅 Meshy / Hunyuan 生效）' },
    enablePbr: { type: 'boolean', default: true, description: '是否启用 PBR 贴图' },
    providerParams: { type: 'object', additionalProperties: true, description: '供应商私有参数透传（白名单过滤）' },
  },
  billing: { credits: 30, note: 'Meshy 多视图（meshy-6/7）：有纹理 30 / 无纹理 20 / 8K 纹理 35；meshy-5 为 15/5；各 provider 实际消耗以官方计费为准' },
  output: { schema: resultSchema({}) },
  async run(args, exec) {
    const providerId = asProvider(args.provider, 'meshy');
    const slot = resolveSlot(args.assetSlot);
    const faceCount = clampTargetPolycount(asNumber(args.targetPolycount, 30000));
    const enablePbr = args.enablePbr === undefined ? true : Boolean(args.enablePbr);
    const pp = filterProviderParams(providerId, asRecord(args.providerParams));

    const rawViews = asRecord(args.views);
    if (!rawViews) throw new ToolError('invalid_views', 'views 对象必填');
    const order = ['front_image_url', 'back_image_url', 'left_image_url', 'right_image_url'] as const;
    const views: Record<string, string> = {};
    for (const key of order) {
      const v = rawViews[key];
      if (typeof v === 'string' && v.trim()) views[key] = v.trim();
    }
    if (!views.front_image_url) throw new ToolError('invalid_views', 'views.front_image_url 必填');

    const cacheKey = genCacheKey(providerId, 'views', {
      assetSlot: slot,
      ...views,
      faceCount,
      enablePbr,
      ...(providerId === 'meshy' ? { shouldTexture: true } : {}),
      ...cacheBitsOf(pp),
    });
    const ctx: GenerationCtx = {
      provider: providerId,
      mode: 'views',
      cacheKey,
      slot,
      assetName: defaultName(args.assetName, `views-${providerId}`),
      prompt: null,
      faceCount,
    };

    const imageUrls = (): string[] | undefined => {
      const keys = providerId === 'tripo3d'
        ? (['front_image_url', 'left_image_url', 'back_image_url', 'right_image_url'] as const)
        : order;
      const urls = keys.map((k) => views[k]).filter((u): u is string => Boolean(u));
      return urls.length > 0 ? urls : undefined;
    };

    return generateCacheFirst(ctx, async () => {
      const { provider, usedMock } = await resolveProviderOrMock(providerId);
      if (!provider) return mockProviderResult(providerId, 'views', null);
      const providerOptions: Record<string, unknown> = { ...pp };
      if (providerId === 'hunyuan3d') {
        // 视角名与图一一对应（官方 3.0 三视图 / 3.1 八视图）
        providerOptions.view_names = order.filter((k) => views[k]).map((k) => k.replace(/_image_url$/, ''));
      }
      return produceGeneration(
        { providerId, mode: 'views', prompt: null, faceCount, enablePbr, pp: providerOptions, imageUrls: imageUrls() },
        exec,
      );
    });
  },
});

// ── gen3d_refine_mesh ───────────────────────────────────────────────────────

/** 计费：Meshy 两阶段精修（给既有 preview 任务上贴图；仅 Meshy）。 */
export const gen3dRefineMesh = defineGen3dTool({
  name: 'gen3d_refine_mesh',
  description:
    'Meshy 两阶段第二步：对之前 gen3d_text_to_3d（meshy）产出或手动提交的 preview 任务上贴图精修，产出新的 refine 资产（sourceJobId = refine 任务 id）。仅 Meshy 支持；previewTaskId 取源资产 sidecar 的 custom.meshyTaskRefs.previewTaskId。计费工具，审批确认后执行；未配置 key 回退 mock。',
  parameters: {
    previewTaskId: { type: 'string', required: true, description: 'Meshy preview 任务 id（两阶段的几何阶段）' },
    texturePrompt: { type: 'string', description: '贴图引导文本（最长 600 字符；缺省沿用原 prompt）' },
    enablePbr: { type: 'boolean', default: true, description: '是否启用 PBR 贴图' },
    assetSlot: { type: 'string', enum: ['characters', 'meshes'], default: 'characters', description: '落盘槽位' },
    assetName: { type: 'string', description: '资产名（缺省 refine-<previewTaskId>）' },
    providerParams: { type: 'object', additionalProperties: true, description: 'Meshy refine 私有参数透传（texture_resolution / texture_image_url / remove_lighting 等）' },
  },
  billing: { credits: 10, note: 'Meshy refine：10 积分（texture_resolution 2k/4k）/ 15 积分（8k）；以官方计费为准' },
  output: { schema: resultSchema({}) },
  async run(args, exec) {
    const previewTaskId = asString(args.previewTaskId, 'previewTaskId', 'invalid_preview_task');
    const slot = resolveSlot(args.assetSlot);
    const enablePbr = args.enablePbr === undefined ? true : Boolean(args.enablePbr);
    const texturePrompt = typeof args.texturePrompt === 'string' ? args.texturePrompt.trim() : '';
    const pp = filterProviderParams('meshy', asRecord(args.providerParams));
    const cacheKey = makeCacheKey('meshy', 'refine', {
      assetSlot: slot,
      previewTaskId,
      enablePbr,
      texturePrompt,
      ...cacheBitsOf(pp),
    });
    const ctx: GenerationCtx = {
      provider: 'meshy',
      mode: 'refine',
      cacheKey,
      slot,
      assetName: defaultName(args.assetName, `refine-${previewTaskId}`),
      prompt: texturePrompt || null,
    };
    return generateCacheFirst(ctx, async () => {
      const { provider, usedMock } = await resolveProviderOrMock('meshy');
      if (!provider) return mockProviderResult('meshy', 'refine', `refine:${previewTaskId}`);
      const handle = await provider.submitGeneration(
        {
          mode: 'text',
          prompt: texturePrompt,
          providerOptions: { ...pp, mode: 'refine', preview_task_id: previewTaskId, enable_pbr: enablePbr },
        },
        { signal: exec.signal },
      );
      const result = (await provider.pollTask(handle, { signal: exec.signal })) as MeshyTaskResult;
      return {
        provider: 'meshy',
        mode: 'refine',
        providerMode: 'real',
        sourceJobId: result.taskId,
        prompt: texturePrompt || null,
        files: meshyFilesToProviderFiles(result),
        meshyTaskRefs: { previewTaskId, resultTaskId: result.taskId },
      };
    });
  },
});

// ── gen3d_retopo_lowpoly ────────────────────────────────────────────────────

/**
 * 计费：低模重拓扑（meshy remesh / hunyuan3d 智能拓扑 / tripo3d 智能低模）。
 * meshy：Meshy 资产可直接用 sidecar 任务 id（meshyTaskRefs.resultTaskId），
 * 本地任意 GLB 经 Data URI（application/octet-stream）上传，无需公网 URL；
 * hunyuan3d 需 sourceUrl（公网可达的源 GLB URL）；tripo3d 需原始任务 id。
 */
export const gen3dRetopoLowpoly = defineGen3dTool({
  name: 'gen3d_retopo_lowpoly',
  description:
    '低模重拓扑：从高模源产出规整低面数新资产（源资产保留，新资产 sourceInputAssetPaths 记录来源）。provider=meshy 走官方 remesh API：Meshy 资产可直接用侧车任务 id（sidecar 的 meshyTaskRefs.resultTaskId），任意本地 GLB（含非 Meshy 资产）经 Data URI 上传，无需公网 URL，5 积分/次；provider=hunyuan3d（默认）走腾讯云 API 3.0 智能拓扑 Submit3DSmartTopologyJob，需要 sourceUrl（公网可达的源 GLB URL）；provider=tripo3d 走 Tripo 智能低模（需 originalTaskId：Tripo 侧带模型输出的任务 id）。mock 路径不需要 URL。计费工具，审批确认后执行；未配置 key 回退 mock。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '源高模资产相对路径' },
    sourceUrl: { type: 'string', description: '源 GLB 的公网 URL（provider=hunyuan3d 必需；meshy/tripo3d 不需要）' },
    originalTaskId: { type: 'string', description: 'provider=meshy：Meshy 已完成任务 id（优先于 sidecar 引用；text-to-3d preview/refine、image-to-3d、retexture）；provider=tripo3d：Tripo 侧带模型输出的任务 id' },
    provider: { type: 'string', enum: ['meshy', 'hunyuan3d', 'tripo3d'], default: 'hunyuan3d', description: '重拓扑供应商' },
    polygonType: { type: 'string', enum: ['triangle', 'quadrilateral'], default: 'quadrilateral', description: '输出面型（meshy 路由映射 topology：quadrilateral→quad、triangle→triangle）' },
    detailLevel: { type: 'string', enum: ['high', 'medium', 'low'], default: 'high', description: '细节档（hunyuan3d FaceLevel；meshy 路由映射 decimation_mode：high→2、medium→3、low→4；未传 targetPolycount 时生效）' },
    targetPolycount: { type: 'integer', description: 'meshy 路由：目标面数（100–300,000；与 detailLevel 互斥，给定时优先生效）' },
    assetSlot: { type: 'string', enum: ['characters', 'meshes'], description: '新资产槽位（缺省沿用源资产）' },
    assetName: { type: 'string', description: '新资产名（缺省 <源名>-lowpoly）' },
  },
  billing: { credits: 5, note: 'Meshy remesh 官方 5 积分/次；hunyuan3d / tripo3d 实际消耗以各家官方计费为准' },
  output: { schema: resultSchema({}) },
  async run(args, exec) {
    const store = getStore();
    const assetPath = asString(args.assetPath, 'assetPath', 'invalid_asset_path');
    const source = await store.readSidecar(assetPath);
    if (source === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
    const providerId = asProvider(args.provider, 'hunyuan3d');
    const slot = args.assetSlot === 'characters' || args.assetSlot === 'meshes'
      ? (args.assetSlot as AssetSlot)
      : source.custom.assetSlot;
    const polygonType = args.polygonType === 'triangle' ? 'triangle' : 'quadrilateral';
    const detailLevel = args.detailLevel === 'low' || args.detailLevel === 'medium' ? args.detailLevel : 'high';
    // meshy 路由：targetPolycount 与 detailLevel 互斥，给定时优先生效（官方 100–300,000 钳制）
    const meshPolycount =
      providerId !== 'meshy' || args.targetPolycount === undefined || args.targetPolycount === null
        ? undefined
        : clampRemeshPolycount(asNumber(args.targetPolycount, 30000));
    const meshDecimation: 1 | 2 | 3 | 4 | undefined =
      meshPolycount === undefined
        ? (detailLevel === 'low' ? 4 : detailLevel === 'medium' ? 3 : 2)
        : undefined;
    const sourceHash = source.contentHash.replace(/^sha256:/, '') || assetPath;
    const cacheKey = genCacheKey(providerId, 'image', {
      op: 'lowpoly',
      assetSlot: slot,
      inputHash: sourceHash,
      polygonType,
      detailLevel,
      ...(providerId === 'meshy'
        ? {
            remeshPolycount: meshPolycount ?? 'by-detail',
            remeshTopology: polygonType,
            remeshDecimation: meshDecimation ?? 'by-detail',
          }
        : {}),
    });
    const baseName = sanitizeStem(
      assetPath.split('/').pop()?.replace(/\.glb$/i, '') ?? 'asset',
      'asset',
    );
    const ctx: GenerationCtx = {
      provider: providerId,
      mode: 'image',
      cacheKey,
      slot,
      assetName: defaultName(args.assetName, `${baseName}-lowpoly`),
      prompt: source.custom.prompt,
      sourceInputAssetPaths: [assetPath],
    };
    return generateCacheFirst(ctx, async () => {
      const { provider, usedMock } = await resolveProviderOrMock(providerId);
      if (!provider) return mockProviderResult(providerId, 'image', `lowpoly:${assetPath}`);
      if (providerId === 'meshy') {
        const remesh = provider as Gen3dProvider & {
          submitRemesh?: (
            req: {
              inputTaskId?: string;
              modelUrl?: string;
              targetFormats?: readonly string[];
              topology?: 'quad' | 'triangle';
              targetPolycount?: number;
              decimationMode?: 1 | 2 | 3 | 4;
            },
            opts?: { signal?: AbortSignal },
          ) => Promise<TaskHandle>;
        };
        if (typeof remesh.submitRemesh !== 'function') {
          throw new ToolError('provider_capability_missing', 'Meshy provider 未实现 submitRemesh（并行任务进行中）');
        }
        // 输入优先级：originalTaskId > sidecar meshyTaskRefs.resultTaskId > 读本地 GLB 转 Data URI
        const explicitTaskId = typeof args.originalTaskId === 'string' ? args.originalTaskId.trim() : '';
        const sidecarTaskId = source.custom.meshyTaskRefs?.resultTaskId ?? null;
        let remeshInput: { inputTaskId: string } | { modelUrl: string };
        if (explicitTaskId !== '') {
          remeshInput = { inputTaskId: explicitTaskId };
        } else if (sidecarTaskId !== null) {
          remeshInput = { inputTaskId: sidecarTaskId };
        } else {
          const fileName = assetPath.split('/').pop() ?? '';
          let bytes: Uint8Array;
          try {
            bytes = new Uint8Array(await readFile(join(store.assetDir(slot), fileName)));
          } catch (err) {
            throw new ToolError('asset_not_found', `读取源 GLB 失败：${err instanceof Error ? err.message : String(err)}`);
          }
          if (bytes.byteLength === 0) throw new ToolError('asset_not_found', '源 GLB 为空');
          remeshInput = { modelUrl: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` };
        }
        const handle = await remesh.submitRemesh(
          {
            ...remeshInput,
            targetFormats: ['glb'],
            topology: polygonType === 'quadrilateral' ? 'quad' : 'triangle',
            ...(meshPolycount !== undefined
              ? { targetPolycount: meshPolycount }
              : { decimationMode: meshDecimation ?? 2 }),
          },
          { signal: exec.signal },
        );
        const result = (await provider.pollTask(handle, { signal: exec.signal })) as MeshyTaskResult;
        return {
          provider: 'meshy',
          mode: 'image',
          providerMode: 'real',
          sourceJobId: result.taskId,
          prompt: source.custom.prompt,
          files: meshyFilesToProviderFiles(result),
          meshyTaskRefs: { previewTaskId: null, resultTaskId: result.taskId },
        };
      }
      if (providerId === 'hunyuan3d') {
        const sourceUrl = asString(args.sourceUrl, 'sourceUrl', 'missing_source_url');
        const smartTopology = provider as Gen3dProvider & {
          submitSmartTopology?: (req: { fileUrl: string; fileType: 'GLB'; polygonType?: string; faceLevel?: string }, opts?: { signal?: AbortSignal }) => Promise<TaskHandle>;
        };
        if (typeof smartTopology.submitSmartTopology !== 'function') {
          throw new ToolError('provider_capability_missing', 'Hunyuan3D provider 未实现 submitSmartTopology（并行任务进行中）');
        }
        const handle = await smartTopology.submitSmartTopology(
          { fileUrl: sourceUrl, fileType: 'GLB', polygonType, faceLevel: detailLevel },
          { signal: exec.signal },
        );
        const result = await provider.pollTask(handle, { signal: exec.signal });
        return providerResultFromTask(providerId, 'image', handle.taskId, result, source.custom.prompt);
      }
      // tripo3d：智能低模需 Tripo 侧任务 id（外部模型须先 import_model）
      const originalTaskId = asString(args.originalTaskId ?? args.sourceUrl, 'originalTaskId', 'missing_source_url');
      const lowPoly = provider as Gen3dProvider & {
        lowPoly?: (req: { originalModelTaskId: string; quad?: boolean }, opts?: { signal?: AbortSignal }) => Promise<TaskHandle>;
      };
      if (typeof lowPoly.lowPoly !== 'function') {
        throw new ToolError('provider_capability_missing', 'Tripo3D provider 未实现 lowPoly（并行任务进行中）');
      }
      const handle = await lowPoly.lowPoly(
        { originalModelTaskId: originalTaskId, quad: polygonType === 'quadrilateral' },
        { signal: exec.signal },
      );
      const result = await provider.pollTask(handle, { signal: exec.signal });
      return providerResultFromTask(providerId, 'image', handle.taskId, result, source.custom.prompt);
    });
  },
});

// ── gen3d_score_quality ─────────────────────────────────────────────────────

/** 只读本地：五维启发式质量评分（geometry/topology/texture/pbr/prompt_fidelity），不调 provider。 */
export const gen3dScoreQuality = defineGen3dTool({
  name: 'gen3d_score_quality',
  description:
    '对资产做五维质量评分并写入 sidecar custom.quality（不调用任何 provider，不消耗配额）。评分来源：objective（几何/拓扑/贴图/PBR 客观分 0–100，source=auto）、aiPass（AI 主观评审，标记 usedMock: true）、manual（人工分 + notes）。总分按五维等权加权。',
  parameters: {
    assetPath: { type: 'string', required: true, description: '资产相对路径' },
    objective: {
      type: 'object',
      additionalProperties: false,
      properties: {
        geometry: { type: 'number', description: '几何分 0–100（越界钳制）' },
        topology: { type: 'number', description: '拓扑分 0–100' },
        texture: { type: 'number', description: '贴图分 0–100' },
        pbr: { type: 'number', description: 'PBR 分 0–100' },
      },
      description: '客观分（source=auto）',
    },
    aiPass: { type: 'boolean', description: '标记本次为 AI 主观评审（结果带 usedMock: true）' },
    manual: {
      type: 'object',
      additionalProperties: true,
      properties: {
        geometry: { type: 'number' },
        topology: { type: 'number' },
        texture: { type: 'number' },
        pbr: { type: 'number' },
        prompt_fidelity: { type: 'number' },
        notes: { type: 'string' },
      },
      description: '人工分（source=manual）+ notes',
    },
  },
  output: { schema: resultSchema({}) },
  async run(args) {
    const store = getStore();
    const assetPath = asString(args.assetPath, 'assetPath', 'invalid_asset_path');
    const existing = await store.readSidecar(assetPath);
    if (existing === null) throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);

    const report: QualityReport = emptyQualityReport();
    const clamp = (v: unknown): number | null => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      return Math.min(100, Math.max(0, Math.round(v)));
    };
    let hasObjective = false;
    const objective = asRecord(args.objective);
    if (objective) {
      for (const key of ['geometry', 'topology', 'texture', 'pbr'] as const) {
        if (key in objective) {
          report[key] = { value: clamp(objective[key]), source: 'auto' };
          hasObjective = true;
        }
      }
    }
    let usedMock = false;
    if (args.aiPass === true) usedMock = true;
    let hasManual = false;
    const manual = asRecord(args.manual);
    if (manual) {
      for (const key of ['geometry', 'topology', 'texture', 'pbr', 'prompt_fidelity'] as const) {
        if (key in manual) {
          report[key] = { value: clamp(manual[key]), source: 'manual' };
          hasManual = true;
        }
      }
      if (typeof manual.notes === 'string') report.notes = manual.notes;
      if (hasManual) report.rater = 'local';
    }
    report.method = hasManual && hasObjective ? 'mixed' : hasManual ? 'manual' : 'auto';
    report.total = weightedTotal([
      { value: report.geometry.value, weight: DEFAULT_WEIGHTS.geometry },
      { value: report.topology.value, weight: DEFAULT_WEIGHTS.topology },
      { value: report.texture.value, weight: DEFAULT_WEIGHTS.texture },
      { value: report.pbr.value, weight: DEFAULT_WEIGHTS.pbr },
      { value: report.prompt_fidelity.value, weight: DEFAULT_WEIGHTS.prompt_fidelity },
    ]);
    report.scoredAt = new Date().toISOString();

    const manifest = await store.updateSidecar(assetPath, (s) => ({
      ...s,
      custom: { ...s.custom, quality: report },
    }));
    return { ok: true, usedMock, total: report.total, manifest }
  },
});

// ── 汇总导出 ────────────────────────────────────────────────────────────────

export const generationTools = [
  gen3dProviderStatus,
  gen3dCredentialsStatus,
  gen3dListAssets,
  gen3dDeleteAsset,
  gen3dTextTo3d,
  gen3dImageTo3d,
  gen3dViewsTo3d,
  gen3dRefineMesh,
  gen3dRetopoLowpoly,
  gen3dRenameAsset,
  gen3dScoreQuality,
];
