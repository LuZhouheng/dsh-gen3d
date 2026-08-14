/**
 * Tripo3D（VAST）官方 API v2 直连实现（DSH 迁移）。
 *
 * 事实来源：docs/providers/tripo3d-api.md（2026-08-13 抓取 docs.tripo3d.ai 官方文档）。
 * 对接基线为 v2 协议（https://api.tripo3d.ai/v2/openapi）；v3 协议
 * （openapi.tripo3d.ai/v3）字段未核实，不做对接。
 *
 * 约定：
 * - 认证：`Authorization: Bearer <TRIPO3D_API_KEY>`（key 以 tsk_ 开头），统一经
 *   src/config.ts 的 readProviderKey('tripo3d') 读取，不直接读 process.env；
 * - 统一任务制：所有生成类能力共用一个入口 `POST /v2/openapi/task`，请求体 `type`
 *   区分任务类型；创建返回 `data.task_id` → `GET /task/{task_id}` 轮询（8 态状态机：
 *   queued / running 进行中，success / failed / banned / expired / cancelled / unknown
 *   为终态）→ 从 `data.output` 的 URL 下载资产；
 * - 响应统一包装 `{code: 0, data}`，失败返回 `{code, message, suggestion}` ——
 *   HTTP 状态码与 JSON code 都要判断（code 表见 tripo3d-api.md §14，含
 *   X-Tripo-Trace-ID 排障头）；
 * - 下载 URL 短期有效（官方记载 5min / FAQ 60s 不一致）：查询成功立即下载，
 *   下载遇 403 重查任务取新链接重试一次；
 * - 图片输入仅 file_token（/upload/sts 上传）/ URL / object，**不支持 base64**：
 *   本地文件须先经 uploadImage() 上传拿 token，工具层负责该转换；
 * - 任务强绑定创建时的 key（换 key 查询报 2001 task not found）；
 * - 错误统一映射到 provider_* 契约错误码（src/providers/types.ts 的 ProviderError）；
 * - 所有 HTTP 经依赖注入 fetchImpl（默认 resolveFetchImpl 的原生 fetch），
 *   单测一律 mock fetch 不打真网。
 */

import type {
  AnimationRequest,
  BalanceInfo,
  FetchLike,
  GenerationRequest,
  Gen3dProvider,
  MotionItem,
  MotionQuery,
  ProviderErrorCode,
  ProviderId,
  RigRequest,
  SubmitOptions,
  TaskDownloads,
} from './types.js'
import { ProviderError, isProviderError, resolveFetchImpl } from './types.js'
import { readProviderKey } from '../config.js'

/** 官方 API v2 基址（HTTPS 强制；v3 未核实不对接） */
export const TRIPO_BASE_URL = 'https://api.tripo3d.ai/v2/openapi'

/** 轮询默认间隔：2s（官方 Quick Start 建议 poll_interval_seconds = 2） */
export const DEFAULT_POLL_INTERVAL_MS = 2_000
/** 轮询默认总超时：10min */
export const DEFAULT_POLL_TIMEOUT_MS = 600_000

/** 文/图/多视图生成默认模型版本（H3 最新）；低模需求走 P1_MODEL_VERSION 或 smart_low_poly 参数 */
export const DEFAULT_MODEL_VERSION = 'v3.1-20260211'
/** 绑骨默认模型版本（rig v2.5 最新，2026-03-11 随 v3.1/P1 发布） */
export const DEFAULT_RIG_MODEL_VERSION = 'v2.5-20260210'
/** 贴图精修默认模型版本（texture v3.0 最新，4K 升级支持） */
export const DEFAULT_TEXTURE_MODEL_VERSION = 'v3.0-20250812'
/** 智能低模（highpoly_to_lowpoly）默认模型版本 */
export const DEFAULT_LOWPOLY_MODEL_VERSION = 'P-v2.0-20251225'
/** P1 低模产品线版本（结构化低模生成；仅支持参数子集，不支持 quad / smart_low_poly / geometry_quality 等） */
export const P1_MODEL_VERSION = 'P1-20260311'

/** 绑骨骨架类型（官方 animate_prerigcheck / animate_rig 枚举，7 类） */
export const TRIPO_RIG_TYPES = [
  'biped',
  'quadruped',
  'hexapod',
  'octopod',
  'avian',
  'serpentine',
  'aquatic',
] as const

// ── 错误类型（契约 ProviderError 的 Tripo3D 子类） ───────────────────────────

export interface TripoProviderErrorOptions {
  /** 上游 HTTP 状态码（如有） */
  status?: number
  taskId?: string
  /** 任务级失败时的原始任务状态（failed / banned / expired / cancelled / unknown） */
  taskStatus?: string
  /** 响应头 X-Tripo-Trace-ID（排障上报用） */
  traceId?: string
  /** 429 类错误的 Retry-After 头（秒） */
  retryAfterSec?: number
  /** 显式覆盖契约默认的可重试判定 */
  retryable?: boolean
  cause?: unknown
}

/** Tripo3D 直连错误：继承契约 ProviderError（isProviderError 可识别），补充任务 / 排障上下文 */
export class TripoProviderError extends ProviderError {
  readonly taskId?: string
  readonly taskStatus?: string
  readonly traceId?: string
  readonly retryAfterSec?: number

  constructor(code: ProviderErrorCode, message: string, opts: TripoProviderErrorOptions = {}) {
    super({ code, message, httpStatus: opts.status, retryable: opts.retryable, cause: opts.cause })
    this.name = 'TripoProviderError'
    if (opts.taskId !== undefined) this.taskId = opts.taskId
    if (opts.taskStatus !== undefined) this.taskStatus = opts.taskStatus
    if (opts.traceId !== undefined) this.traceId = opts.traceId
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec
  }
}

// ── 任务句柄 / 结果（Tripo3D 专属能力面，结构兼容契约 TaskHandle / TaskResult） ─

/** 本 provider 支持的全部任务类型（请求体 type 字段） */
export type TripoTaskType =
  | 'text_to_model'
  | 'image_to_model'
  | 'multiview_to_model'
  | 'texture_model'
  | 'animate_prerigcheck'
  | 'animate_rig'
  | 'animate_retarget'
  | 'highpoly_to_lowpoly'

export interface TripoTaskHandle {
  readonly provider: 'tripo3d'
  readonly taskId: string
  readonly type: TripoTaskType
  readonly createdAtMs: number
}

export interface TripoPollOptions extends SubmitOptions {
  /** 轮询间隔毫秒（默认 2000，官方建议 2s） */
  intervalMs?: number
  /** 轮询总超时毫秒（默认 600_000） */
  timeoutMs?: number
}

export type TripoFileFormat = 'glb' | 'fbx' | 'obj' | 'mtl' | 'usdz' | 'stl' | '3mf' | 'png' | 'jpg' | 'webp'

/** 已下载的资产文件；role 与官方 output 字段名对应（model / base_model / pbr_model / rendered_image …） */
export interface TripoResultFile {
  readonly role: string
  readonly format: TripoFileFormat
  readonly url: string
  readonly buffer: Uint8Array
}

/** animate_prerigcheck 输出（riggable + rig_type，官方 7 类骨架） */
export interface TripoRigInfo {
  readonly riggable: boolean
  readonly rigType?: string
}

export interface TripoTaskResult {
  readonly provider: 'tripo3d'
  readonly taskId: string
  readonly type: TripoTaskType
  /** 终态即成功（失败终态直接抛 ProviderError，不做轮询返回） */
  readonly status: 'succeeded'
  /** 已下载资产（animate_prerigcheck 无资产，files 为空） */
  readonly files: readonly TripoResultFile[]
  /** 契约形状的下载物清单（URL 投影，供统一工具层使用） */
  readonly downloads: TaskDownloads
  /** output 提取出的 URL 全集（role -> url；下载成功者以实际下载 URL 为准） */
  readonly modelUrls: Readonly<Record<string, string>>
  /** generate_multiview_image 输出的四视图 URL（固定顺序 front, left, back, right） */
  readonly multiviewUrls?: Readonly<Record<'front' | 'left' | 'back' | 'right', string>>
  /** 预检结果（仅 animate_prerigcheck 任务） */
  readonly rigInfo?: TripoRigInfo
  /** 本任务消耗积分（官方 consumed_credit；失败任务不扣费） */
  readonly consumedCredit?: number
  /** 进度 0–100（success 恒为 100） */
  readonly progress: number
  /** 原始任务响应（含 queuing_num / running_left_time / create_time 等，供上层审计） */
  readonly raw: unknown
}

// ── 提交参数 ─────────────────────────────────────────────────────────────────

/** 图片输入：file_token（/upload/sts 返回的 image_token）或直链 URL 二选一；无 base64 */
export interface TripoFileInput {
  /** file_token（与 url 互斥） */
  fileToken?: string
  /** 图片直链 URL（仅 JPEG/PNG，≤20MB；与 file_token 互斥） */
  url?: string
}

/** 文生 3D（text_to_model）：单任务出成品，无 preview/refine 两阶段 */
export interface TripoTextInput {
  /** 物体描述，必填，最长 1024 字符（不支持 emoji 与部分特殊 Unicode 字符） */
  prompt: string
  /** 反向提示，最长 255 字符 */
  negativePrompt?: string
  /** 几何生成种子（同 seed 得同模型；内部文生参考图种子用 providerOptions.image_seed） */
  seed?: number
  /** 模型版本；缺省 v3.1-20260211（H3 最新）；低模需求传 P1_MODEL_VERSION 或开 smart_low_poly */
  modelVersion?: string
  /** 官方私有参数透传（texture / pbr / face_limit / smart_low_poly / quad / geometry_quality …） */
  providerOptions?: Record<string, unknown>
}

/** 图生 3D（image_to_model） */
export interface TripoImageInput {
  /** 参考图：http(s) 直链 URL 或上传返回的 file_token；与 fileToken 互斥 */
  image?: string
  /** /upload/sts 上传返回的 image_token（与 image 互斥；本地文件须先上传） */
  fileToken?: string
  modelVersion?: string
  /** 官方私有参数透传（enable_image_autofix / texture_* / orientation / pbr / smart_low_poly …） */
  providerOptions?: Record<string, unknown>
}

/** 多视图生 3D（multiview_to_model）：固定 4 视角顺序 [front, left, back, right]，front 必填、≥2 张 */
export interface TripoMultiviewInput {
  /** 各视角参考图（URL 或 file_token），顺序即 [front, left, back, right]；可省略部分视角但 front 必填 */
  images?: readonly string[]
  /** 与 images 逐位对齐的 file_token（index 0 = front）；省略位按 images 内容解析 */
  fileTokens?: readonly string[]
  /** 直接引用 generate_multiview_image / edit_multiview_image 任务的输出，与 images 互斥 */
  originalTaskId?: string
  modelVersion?: string
  /** 官方私有参数透传（同 image_to_model） */
  providerOptions?: Record<string, unknown>
}

/** 贴图精修（texture_model）：对已有模型重生成贴图与 PBR */
export interface TripoTextureInput {
  /** 前置模型任务 id（须为 ≥v2.0 / Turbo 的生成任务输出） */
  originalModelTaskId: string
  /** texture_prompt.text：文本描述（与 image / images 三选一） */
  prompt?: string
  /** texture_prompt.image：单张参考图（URL / file_token / TripoFileInput） */
  image?: string | TripoFileInput
  /** texture_prompt.images：参考图列表（每项 URL / file_token / TripoFileInput） */
  images?: ReadonlyArray<string | TripoFileInput>
  /** texture_prompt.style_image：艺术风格参考图 */
  styleImage?: string | TripoFileInput
  /** 缺省 v3.0-20250812（最新，4K 升级支持） */
  modelVersion?: string
  /** 官方私有参数透传（texture / pbr / texture_seed / texture_alignment / texture_quality / part_names / bake …） */
  providerOptions?: Record<string, unknown>
}

/** 绑骨（animate_rig） */
export interface TripoRigInput {
  /** 原模型任务 id（须为带模型输出的任务）；Tripo3D 绑骨不接受外部模型 URL，外部模型须先 import_model */
  originalModelTaskId: string
  /** 骨架类型，默认 biped（biped / quadruped / hexapod / octopod / avian / serpentine / aquatic） */
  rigType?: string
  /** 输出格式 glb（默认）/ fbx */
  outFormat?: 'glb' | 'fbx'
  /** 缺省 v2.5-20260210（rig v2.5 最新） */
  modelVersion?: string
  /** 官方私有参数透传（spec: tripo / mixamo 等） */
  providerOptions?: Record<string, unknown>
}

/** 套动作（animate_retarget）：16 个固定 preset:* 预设，无动作目录 API */
export interface TripoRetargetInput {
  /** 已绑骨模型的任务 id（animate_rig 输出），必填 */
  originalModelTaskId: string
  /** 单个预设动作（preset:*，如 preset:walk）；与 animations 二选一 */
  animation?: string
  /** 预设动作数组，最多 5 个；与 animation 二选一 */
  animations?: readonly string[]
  /** 输出格式 glb（默认）/ fbx */
  outFormat?: 'glb' | 'fbx'
  /** 官方私有参数透传（bake_animation / export_with_geometry / animate_in_place …） */
  providerOptions?: Record<string, unknown>
}

/** 后处理智能低模（highpoly_to_lowpoly） */
export interface TripoLowpolyInput {
  /** 前置模型任务 id，必填 */
  originalModelTaskId: string
  /** 输出面数上限 500–20000（quad 时 500–10000），越界本地拒绝 */
  faceLimit?: number
  /** 四边形网格输出（开启强制 FBX） */
  quad?: boolean
  /** 仅处理指定分割部件（须先经 mesh_segmentation） */
  partNames?: readonly string[]
  /** 默认 true，烘焙材质 */
  bake?: boolean
  /** 缺省 P-v2.0-20251225 */
  modelVersion?: string
  /** 官方私有参数透传 */
  providerOptions?: Record<string, unknown>
}

/** 绑骨预检（animate_prerigcheck，免费）：输出 riggable + rig_type */
export interface TripoPreRigCheckInput {
  /** 原模型任务 id（须为有模型输出的任务） */
  originalModelTaskId: string
}

export interface TripoProviderDeps {
  /** HTTP 传输注入（默认 resolveFetchImpl 的原生 fetch）；单测一律 mock 此实现 */
  fetchImpl?: FetchLike
  /** 轮询间隔毫秒（默认 2000） */
  pollIntervalMs?: number
  /** 轮询总超时毫秒（默认 600_000） */
  pollTimeoutMs?: number
  /** 睡眠注入（默认 setTimeout；测试可注入 no-op 加速） */
  sleep?: (ms: number) => Promise<void>
}

// ── 动作目录（官方 16 个固定 preset，无目录查询 API，直接固化成本地静态表） ─────

export interface TripoMotionPreset {
  readonly id: string
  readonly label: string
  readonly category: string
  /** 兼容骨架类型（与 TRIPO_RIG_TYPES 对齐） */
  readonly rigType: string
}

/** 官方预设动作完整列表（docs/providers/tripo3d-api.md §8） */
export const TRIPO_MOTION_PRESETS: readonly TripoMotionPreset[] = [
  { id: 'preset:idle', label: 'Idle', category: 'Biped', rigType: 'biped' },
  { id: 'preset:walk', label: 'Walk', category: 'Biped', rigType: 'biped' },
  { id: 'preset:run', label: 'Run', category: 'Biped', rigType: 'biped' },
  { id: 'preset:dive', label: 'Dive', category: 'Biped', rigType: 'biped' },
  { id: 'preset:climb', label: 'Climb', category: 'Biped', rigType: 'biped' },
  { id: 'preset:jump', label: 'Jump', category: 'Biped', rigType: 'biped' },
  { id: 'preset:slash', label: 'Slash', category: 'Biped', rigType: 'biped' },
  { id: 'preset:shoot', label: 'Shoot', category: 'Biped', rigType: 'biped' },
  { id: 'preset:hurt', label: 'Hurt', category: 'Biped', rigType: 'biped' },
  { id: 'preset:fall', label: 'Fall', category: 'Biped', rigType: 'biped' },
  { id: 'preset:turn', label: 'Turn', category: 'Biped', rigType: 'biped' },
  { id: 'preset:quadruped:walk', label: 'Quadruped Walk', category: 'Quadruped', rigType: 'quadruped' },
  { id: 'preset:hexapod:walk', label: 'Hexapod Walk', category: 'Hexapod', rigType: 'hexapod' },
  { id: 'preset:octopod:walk', label: 'Octopod Walk', category: 'Octopod', rigType: 'octopod' },
  { id: 'preset:serpentine:march', label: 'Serpentine March', category: 'Serpentine', rigType: 'serpentine' },
  { id: 'preset:aquatic:march', label: 'Aquatic March', category: 'Aquatic', rigType: 'aquatic' },
]

// ── Provider ─────────────────────────────────────────────────────────────────

/** 官方任务查询响应 data 的已知字段（output 含未记载字段，勿依赖） */
interface TripoTaskData {
  task_id?: unknown
  type?: unknown
  status?: unknown
  progress?: unknown
  input?: unknown
  output?: unknown
  consumed_credit?: unknown
  queuing_num?: unknown
  running_left_time?: unknown
  create_time?: unknown
  error_code?: unknown
  error_message?: unknown
}

export class TripoProvider implements Gen3dProvider {
  readonly id: ProviderId = 'tripo3d'

  private readonly fetchImpl: FetchLike
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number

  constructor(deps: TripoProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? resolveFetchImpl()
    this.sleepImpl = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  }

  /** 是否已配置 TRIPO3D_API_KEY（上层据此决定回退确定性 mock） */
  isConfigured(): boolean {
    return readProviderKey('tripo3d') !== undefined
  }

  // ── 统一契约入口（Gen3dProvider） ──

  /**
   * 统一生成提交。mode 映射：text → text_to_model、image → image_to_model（
   * imageUrls[0] 为 URL 或 file_token，或经 providerOptions.file_token 显式传入）、
   * views → multiview_to_model（imageUrls 按 [front, left, back, right] 顺序，
   * 或经 providerOptions.original_task_id 引用多视图图像任务）。
   * model_version 缺省 v3.1-20260211，经 providerOptions.model_version 覆盖（如 P1）。
   */
  async submitGeneration(req: GenerationRequest, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = req.providerOptions ?? {}
    if (req.mode === 'text') {
      const payload = buildTextPayload({
        prompt: req.prompt,
        negativePrompt: req.negativePrompt,
        seed: req.seed,
        modelVersion: modelVersionOf(options),
      })
      return this.submitTask(
        'text_to_model',
        mergeOptions(payload, options, ['model_version', 'negative_prompt', 'model_seed']),
        opts,
      )
    }
    if (req.mode === 'image') {
      const fileToken = stringOption(options, 'file_token')
      const payload = buildImagePayload({
        file: resolveImageFile(req.imageUrls?.[0], fileToken),
        modelVersion: modelVersionOf(options),
      })
      return this.submitTask(
        'image_to_model',
        mergeOptions(payload, options, ['model_version', 'file_token']),
        opts,
      )
    }
    const originalTaskId = stringOption(options, 'original_task_id')
    const payload = buildMultiviewPayload({
      images: req.imageUrls,
      originalTaskId,
      modelVersion: modelVersionOf(options),
    })
    return this.submitTask(
      'multiview_to_model',
      mergeOptions(payload, options, ['model_version', 'original_task_id']),
      opts,
    )
  }

  /**
   * 统一绑骨入口。Tripo3D 绑骨只接受原模型任务 id（无外部模型 URL 路径）：
   * 经 providerOptions.original_model_task_id 传入，或复用 assetUrl 字段承载任务 id。
   * skeletonType → rig_type（缺省 biped）。
   */
  async submitRig(req: RigRequest, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = req.providerOptions ?? {}
    const originalTaskId =
      stringOption(options, 'original_model_task_id') ?? (req.assetUrl || undefined)
    const payload = buildRigPayload({
      originalModelTaskId: originalTaskId ?? '',
      rigType: req.skeletonType,
    })
    return this.submitTask(
      'animate_rig',
      mergeOptions(payload, options, ['model_version', 'rig_type', 'out_format', 'original_model_task_id']),
      opts,
    )
  }

  /**
   * 统一套动作入口。actionId 为预设字符串（preset:*，listMotions 的 id）；
   * animations 数组经 providerOptions.animations 透传（≤5 个，与单动作二选一）。
   */
  async submitAnimation(req: AnimationRequest, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = req.providerOptions ?? {}
    const animations = Array.isArray(options.animations)
      ? options.animations.map((a) => String(a))
      : undefined
    const payload = buildRetargetPayload({
      originalModelTaskId: req.rigTaskId,
      animation: typeof req.actionId === 'string' ? req.actionId : undefined,
      animations,
      outFormat: outFormatOf(options),
    })
    return this.submitTask(
      'animate_retarget',
      mergeOptions(payload, options, ['animations', 'animation', 'out_format']),
      opts,
    )
  }

  /** 统一动作目录：官方 16 个 preset 静态表（无目录 API）；query 按 label/category/rigType 收窄 */
  async listMotions(query?: MotionQuery): Promise<MotionItem[]> {
    const motions = this.catalog()
    const q = query?.query?.trim().toLowerCase()
    return motions.filter(
      (m) =>
        (!q || m.label.toLowerCase().includes(q) || String(m.id).toLowerCase().includes(q)) &&
        (!query?.category || m.category === query.category) &&
        (!query?.rigType || m.rigType === undefined || m.rigType === query.rigType),
    )
  }

  /** 统一余额入口：GET /user/balance → data.balance（可用积分）+ data.frozen（冻结） */
  async getBalance(): Promise<BalanceInfo> {
    const { balance, frozen } = await this.balance()
    return { balance, raw: { balance, frozen } }
  }

  // ── 提交：文/图/多视图生 3D ──

  async textTo3d(input: TripoTextInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = input.providerOptions ?? {}
    const payload = buildTextPayload({
      prompt: input.prompt,
      negativePrompt: input.negativePrompt,
      seed: input.seed,
      modelVersion: input.modelVersion ?? modelVersionOf(options),
    })
    return this.submitTask(
      'text_to_model',
      mergeOptions(payload, options, ['model_version', 'negative_prompt', 'model_seed']),
      opts,
    )
  }

  async imageTo3d(input: TripoImageInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = input.providerOptions ?? {}
    const payload = buildImagePayload({
      file: resolveImageFile(input.image, input.fileToken),
      modelVersion: input.modelVersion ?? modelVersionOf(options),
    })
    return this.submitTask(
      'image_to_model',
      mergeOptions(payload, options, ['model_version', 'file_token']),
      opts,
    )
  }

  async multiviewTo3d(input: TripoMultiviewInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = input.providerOptions ?? {}
    const payload = buildMultiviewPayload({
      images: input.images,
      fileTokens: input.fileTokens,
      originalTaskId: input.originalTaskId ?? stringOption(options, 'original_task_id'),
      modelVersion: input.modelVersion ?? modelVersionOf(options),
    })
    return this.submitTask(
      'multiview_to_model',
      mergeOptions(payload, options, ['model_version', 'original_task_id']),
      opts,
    )
  }

  // ── 提交：贴图精修 / 绑骨三段 / 智能低模 ──

  /** 贴图精修（texture_model）：对已有模型重生成贴图与 PBR（10 积分） */
  async textureModel(input: TripoTextureInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = input.providerOptions ?? {}
    const payload = buildTexturePayload({
      ...input,
      modelVersion: input.modelVersion ?? modelVersionOf(options),
    })
    return this.submitTask(
      'texture_model',
      mergeOptions(payload, options, ['model_version', 'texture_prompt']),
      opts,
    )
  }

  /** 绑骨预检（animate_prerigcheck，免费）：返回 riggable + rig_type */
  async preRigCheck(input: TripoPreRigCheckInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    return this.submitTask('animate_prerigcheck', buildPreRigCheckPayload(input), opts)
  }

  /** 绑骨（animate_rig，25 积分） */
  async rigging(input: TripoRigInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = input.providerOptions ?? {}
    const payload = buildRigPayload({
      originalModelTaskId: input.originalModelTaskId,
      rigType: input.rigType,
      outFormat: input.outFormat ?? outFormatOf(options),
      modelVersion: input.modelVersion ?? modelVersionOf(options),
    })
    return this.submitTask(
      'animate_rig',
      mergeOptions(payload, options, ['model_version', 'rig_type', 'out_format']),
      opts,
    )
  }

  /** 套动作（animate_retarget，10 积分/动画） */
  async retarget(input: TripoRetargetInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = input.providerOptions ?? {}
    const payload = buildRetargetPayload({
      originalModelTaskId: input.originalModelTaskId,
      animation: input.animation,
      animations: input.animations,
      outFormat: input.outFormat ?? outFormatOf(options),
    })
    return this.submitTask(
      'animate_retarget',
      mergeOptions(payload, options, ['animation', 'animations', 'out_format']),
      opts,
    )
  }

  /** 后处理智能低模（highpoly_to_lowpoly，30 积分） */
  async highpolyToLowpoly(input: TripoLowpolyInput, opts?: SubmitOptions): Promise<TripoTaskHandle> {
    const options = input.providerOptions ?? {}
    const payload = buildLowpolyPayload({
      ...input,
      modelVersion: input.modelVersion ?? modelVersionOf(options),
    })
    return this.submitTask(
      'highpoly_to_lowpoly',
      mergeOptions(payload, options, [
        'model_version',
        'face_limit',
        'quad',
        'part_names',
        'bake',
      ]),
      opts,
    )
  }

  // ── 图片上传（POST /upload/sts 直传；本地文件必须先走这里拿 file_token） ──

  /**
   * 直传图片（multipart/form-data，字段 file；仅 webp/jpeg/png，≤20MB，不消耗生成积分）。
   * 返回 image_token，作为生成任务的 file_token 使用。
   */
  async uploadImage(
    data: Blob | ArrayBuffer | Uint8Array,
    filename = 'image.png',
    opts?: SubmitOptions,
  ): Promise<string> {
    const key = this.requireKey()
    const form = new FormData()
    form.append('file', toBlob(data), filename)
    // 不手写 Content-Type：由 fetch 自动带 multipart boundary
    const resp = await this.request(`${TRIPO_BASE_URL}/upload/sts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: opts?.signal,
    })
    if (!resp.ok) throw await this.mapHttpError(resp)
    const data2 = await this.parseData(resp, 'upload 响应')
    const token = data2.image_token
    if (typeof token !== 'string' || token === '') {
      throw new TripoProviderError('provider_http_error', 'upload 响应缺少 data.image_token', {
        retryable: false,
      })
    }
    return token
  }

  // ── 余额（GET /user/balance；不计队列、免费） ──

  async balance(opts?: SubmitOptions): Promise<{ balance: number; frozen: number }> {
    const key = this.requireKey()
    const resp = await this.request(`${TRIPO_BASE_URL}/user/balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: opts?.signal,
    })
    if (!resp.ok) throw await this.mapHttpError(resp)
    const data = await this.parseData(resp, 'balance 响应')
    const balance = data.balance
    if (typeof balance !== 'number' || !Number.isFinite(balance)) {
      throw new TripoProviderError('provider_http_error', 'balance 响应缺少数字 balance 字段', {
        retryable: false,
      })
    }
    const frozen = data.frozen
    return {
      balance,
      frozen: typeof frozen === 'number' && Number.isFinite(frozen) ? frozen : 0,
    }
  }

  // ── 轮询（默认 2s 间隔 / 10min 超时；失败终态立即抛；成功即下载，403 重查重试一次） ──

  async pollTask(handle: TripoTaskHandle, opts?: TripoPollOptions): Promise<TripoTaskResult> {
    const intervalMs = opts?.intervalMs ?? this.pollIntervalMs
    const timeoutMs = opts?.timeoutMs ?? this.pollTimeoutMs
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const task = await this.pollOnce(handle)
      const status = task.status
      if (status === 'success') return this.buildResult(handle, task)
      if (status === 'failed') throw taskFailedError(handle, task)
      if (status === 'banned') {
        throw new TripoProviderError(
          'provider_bad_request',
          `Tripo3D 任务违反内容政策（banned）：${handle.taskId}`,
          { taskId: handle.taskId, taskStatus: 'banned', retryable: false },
        )
      }
      if (status === 'expired') {
        throw new TripoProviderError(
          'provider_http_error',
          `Tripo3D 任务结果已过期（expired），请重新提交：${handle.taskId}`,
          { taskId: handle.taskId, taskStatus: 'expired', retryable: false },
        )
      }
      if (status === 'cancelled') {
        throw new TripoProviderError(
          'provider_http_error',
          `Tripo3D 任务已取消（cancelled）：${handle.taskId}`,
          { taskId: handle.taskId, taskStatus: 'cancelled', retryable: false },
        )
      }
      if (status === 'unknown') {
        // 系统级异常：官方要求带 task_id 联系支持
        throw new TripoProviderError(
          'provider_http_error',
          `Tripo3D 任务系统级异常（unknown），需带 task_id 联系支持：${handle.taskId}`,
          { taskId: handle.taskId, taskStatus: 'unknown', retryable: true },
        )
      }
      if (status !== 'queued' && status !== 'running') {
        throw new TripoProviderError(
          'provider_http_error',
          `轮询响应缺少可识别状态：${String(status)}（${handle.taskId}）`,
          { taskId: handle.taskId, retryable: false },
        )
      }
      if (Date.now() >= deadline) {
        throw new TripoProviderError(
          'provider_timeout',
          `Tripo3D 任务轮询超时（${timeoutMs}ms）：${handle.taskId}`,
          { taskId: handle.taskId, retryable: true },
        )
      }
      await this.sleep(intervalMs, opts?.signal)
    }
  }

  // ── 私有实现 ──

  private requireKey(): string {
    const key = readProviderKey('tripo3d')
    if (!key) {
      throw new TripoProviderError(
        'provider_not_configured',
        '未配置 TRIPO3D_API_KEY（上层应回退确定性 mock，provider 层不做 mock）',
        { retryable: false },
      )
    }
    return key
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init)
    } catch (err) {
      throw this.mapNetworkError(err)
    }
  }

  /** 统一提交入口：所有任务类型都 POST /task，请求体带 type 字段 */
  private async submitTask(
    type: TripoTaskType,
    payload: Record<string, unknown>,
    opts?: SubmitOptions,
  ): Promise<TripoTaskHandle> {
    const key = this.requireKey()
    const resp = await this.request(`${TRIPO_BASE_URL}/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ type, ...payload }),
      signal: opts?.signal,
    })
    if (!resp.ok) throw await this.mapHttpError(resp)
    const data = await this.parseData(resp, 'submit 响应')
    const taskId = data.task_id
    if (typeof taskId !== 'string' || taskId === '') {
      throw new TripoProviderError(
        'provider_http_error',
        `submit 响应缺少 data.task_id（type=${type}）`,
        { retryable: false },
      )
    }
    return { provider: 'tripo3d', taskId, type, createdAtMs: Date.now() }
  }

  private async pollOnce(handle: TripoTaskHandle): Promise<TripoTaskData> {
    const key = this.requireKey()
    const resp = await this.request(`${TRIPO_BASE_URL}/task/${handle.taskId}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!resp.ok) throw await this.mapHttpError(resp, { taskId: handle.taskId })
    return (await this.parseData(resp, `轮询响应（${handle.taskId}）`)) as TripoTaskData
  }

  /** 解析统一包装 `{code, data}`；code ≠ 0 视为业务失败并映射错误码 */
  private async parseData(resp: Response, what: string): Promise<Record<string, unknown>> {
    const body = await parseJsonResponse(resp, what)
    const obj = asRecord(body)
    const code = obj.code
    if (code !== 0) {
      // HTTP 200 但业务失败（官方统一包装 {code, message, suggestion}）
      const apiCode = typeof code === 'number' ? code : undefined
      const message = typeof obj.message === 'string' ? obj.message : undefined
      const suggestion = typeof obj.suggestion === 'string' ? obj.suggestion : undefined
      throw this.buildError(apiCode, resp.status, message, suggestion, resp)
    }
    return asRecord(obj.data)
  }

  private async mapHttpError(
    resp: Response,
    context: { taskId?: string } = {},
  ): Promise<TripoProviderError> {
    let code: number | undefined
    let message: string | undefined
    let suggestion: string | undefined
    try {
      const body = asRecord(await resp.json())
      if (typeof body.code === 'number') code = body.code
      if (typeof body.message === 'string' && body.message) message = body.message
      if (typeof body.suggestion === 'string' && body.suggestion) suggestion = body.suggestion
    } catch {
      // 非 JSON 响应体
    }
    return this.buildError(code, resp.status, message, suggestion, resp, context.taskId)
  }

  /** HTTP 状态 + JSON code 双判定的错误映射（code 优先，见 tripo3d-api.md §14） */
  private buildError(
    code: number | undefined,
    status: number,
    message: string | undefined,
    suggestion: string | undefined,
    resp: Response,
    taskId?: string,
  ): TripoProviderError {
    const mapped = code !== undefined ? mapApiError(status, code) : mapStatusError(status)
    const traceId = resp.headers.get('x-tripo-trace-id') ?? undefined
    const retryAfterSec = parseRetryAfter(resp.headers.get('retry-after'))
    const detail = [message, suggestion].filter((v): v is string => Boolean(v)).join('；')
    const codePart = code !== undefined ? ` code=${code}` : ''
    const tracePart = traceId ? `（trace ${traceId}）` : ''
    const text = detail ? `：${detail}` : ''
    return new TripoProviderError(
      mapped.code,
      `Tripo3D API HTTP ${status}${codePart}${text}${tracePart}`,
      {
        status,
        retryable: mapped.retryable,
        taskId,
        traceId,
        retryAfterSec,
      },
    )
  }

  private mapNetworkError(err: unknown): TripoProviderError {
    if (err instanceof Error && err.name === 'AbortError') {
      // 调用方取消：原样上抛，让上层区分"取消"与"失败"
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    return new TripoProviderError('provider_http_error', `网络请求失败：${message}`, {
      retryable: true,
      cause: err,
    })
  }

  private async buildResult(handle: TripoTaskHandle, task: TripoTaskData): Promise<TripoTaskResult> {
    const output = asRecord(task.output)
    const urls = extractOutputUrls(output)
    const progress = typeof task.progress === 'number' ? task.progress : 100

    // 预检任务只输出 riggable / rig_type，无资产可下载
    if (handle.type === 'animate_prerigcheck') {
      const rigInfo: TripoRigInfo = {
        riggable: output.riggable === true,
        rigType: typeof output.rig_type === 'string' ? output.rig_type : undefined,
      }
      return {
        provider: 'tripo3d',
        taskId: handle.taskId,
        type: handle.type,
        status: 'succeeded',
        files: [],
        downloads: {},
        modelUrls: urls,
        rigInfo,
        progress,
        raw: task,
      }
    }

    const files = await this.downloadFiles(handle, urls)
    if (files.length === 0) {
      throw new TripoProviderError(
        'provider_empty_download',
        `任务成功但无任何资产可下载（${handle.type} ${handle.taskId}）`,
        { taskId: handle.taskId, retryable: false },
      )
    }
    const consumed = task.consumed_credit
    return {
      provider: 'tripo3d',
      taskId: handle.taskId,
      type: handle.type,
      status: 'succeeded',
      files,
      downloads: buildTaskDownloads(files, urls),
      modelUrls: mergeUrlRecords(files, urls),
      multiviewUrls: extractMultiviewUrls(output),
      consumedCredit: typeof consumed === 'number' ? consumed : undefined,
      progress,
      raw: task,
    }
  }

  /**
   * 下载全部资产。查询成功立即下载；下载遇 403（签名 URL 过期，官方 5min/60s
   * 记载不一致）→ 重查任务取新链接，对失败项重试一次。
   */
  private async downloadFiles(
    handle: TripoTaskHandle,
    urls: Record<string, string>,
  ): Promise<TripoResultFile[]> {
    let refreshed: Record<string, string> | undefined
    const files: TripoResultFile[] = []
    for (const [role, url] of Object.entries(urls)) {
      try {
        files.push(await this.downloadOne(role, url))
      } catch (err) {
        if (!isProviderError(err) || err.httpStatus !== 403) throw err
        if (refreshed === undefined) refreshed = await this.refreshOutputUrls(handle)
        const freshUrl = refreshed[role]
        if (typeof freshUrl !== 'string' || freshUrl === '') {
          throw new TripoProviderError(
            'provider_http_error',
            `资产下载 403 且重查任务未获得新链接：role=${role}`,
            { taskId: handle.taskId, retryable: false, cause: err },
          )
        }
        if (freshUrl === url) {
          throw new TripoProviderError(
            'provider_http_error',
            `资产下载 403 且重查后链接未更新：role=${role}`,
            { taskId: handle.taskId, retryable: false, cause: err },
          )
        }
        files.push(await this.downloadOne(role, freshUrl))
      }
    }
    return files
  }

  /** 403 时重查任务取新下载链接（一次性查询，供多个失败项复用） */
  private async refreshOutputUrls(handle: TripoTaskHandle): Promise<Record<string, string>> {
    const task = await this.pollOnce(handle)
    if (task.status !== 'success') {
      throw new TripoProviderError(
        'provider_http_error',
        `重查任务取新链接时状态异常：${String(task.status)}（${handle.taskId}）`,
        { taskId: handle.taskId, retryable: false },
      )
    }
    return extractOutputUrls(asRecord(task.output))
  }

  /** 下载单个签名 URL 资产；HTTP 失败按 provider_http_error，空内容 / GLB magic 失败按 provider_empty_download */
  private async downloadOne(role: string, url: string): Promise<TripoResultFile> {
    const resp = await this.request(url, { method: 'GET' })
    if (!resp.ok) {
      throw new TripoProviderError(
        'provider_http_error',
        `资产下载失败 HTTP ${resp.status}（签名 URL 可能已过期）：${url}`,
        { status: resp.status, retryable: false },
      )
    }
    const buffer = new Uint8Array(await resp.arrayBuffer())
    if (buffer.byteLength === 0) {
      throw new TripoProviderError('provider_empty_download', `资产下载内容为空：${url}`, {
        retryable: false,
      })
    }
    const format = inferFormat(role, url)
    if (format === 'glb' && !isGlbBytes(buffer)) {
      throw new TripoProviderError(
        'provider_empty_download',
        `资产内容不是合法 GLB（magic 校验失败）：role=${role}`,
        { retryable: false },
      )
    }
    return { role, format, url, buffer }
  }

  /** 静态动作目录（内部；listMotions 的契约形状映射） */
  private catalog(): MotionItem[] {
    return TRIPO_MOTION_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      category: p.category,
      rigType: p.rigType,
      isFree: false,
    }))
  }

  /** 可中止睡眠：sleepImpl 完成或 signal 中止时 settle */
  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        fn()
      }
      const onAbort = () => finish(() => reject(abortReason(signal)))
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.sleepImpl(ms).then(
        () => finish(resolve),
        (err: unknown) => finish(() => reject(err)),
      )
    })
  }
}

// ── 提交参数 → 官方请求体 ─────────────────────────────────────────────────────

function buildTextPayload(input: TripoTextInput): Record<string, unknown> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw badRequest('text_to_model：prompt 必填')
  }
  if (prompt.length > 1024) {
    throw badRequest(`text_to_model：prompt 最长 1024 字符（当前 ${prompt.length}）`)
  }
  const p: Record<string, unknown> = { prompt, model_version: input.modelVersion ?? DEFAULT_MODEL_VERSION }
  if (input.negativePrompt !== undefined) {
    const negative = input.negativePrompt.trim()
    if (negative.length > 255) {
      throw badRequest(`text_to_model：negative_prompt 最长 255 字符（当前 ${negative.length}）`)
    }
    p.negative_prompt = negative
  }
  if (input.seed !== undefined) p.model_seed = input.seed
  return p
}

function buildImagePayload(input: {
  file: TripoFileInput
  modelVersion?: string
}): Record<string, unknown> {
  return {
    file: buildTripoFile(input.file),
    model_version: input.modelVersion ?? DEFAULT_MODEL_VERSION,
  }
}

function buildMultiviewPayload(input: {
  images?: readonly string[]
  fileTokens?: readonly string[]
  originalTaskId?: string
  modelVersion?: string
}): Record<string, unknown> {
  const p: Record<string, unknown> = { model_version: input.modelVersion ?? DEFAULT_MODEL_VERSION }
  if (input.originalTaskId) {
    p.original_task_id = input.originalTaskId
    return p
  }
  const images = input.images ?? []
  if (images.length < 2 || images.length > 4) {
    throw badRequest(
      `multiview_to_model：需 2–4 张按 [front, left, back, right] 顺序的参考图（当前 ${images.length} 张，front 必填）`,
    )
  }
  const tokens = input.fileTokens ?? []
  p.files = images.map((image, index) => buildTripoFile(resolveImageFile(image, tokens[index])))
  return p
}

function buildTexturePayload(input: TripoTextureInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    original_model_task_id: requireTaskId(input.originalModelTaskId, 'texture_model'),
    texture_prompt: buildTexturePrompt(input),
    model_version: input.modelVersion ?? DEFAULT_TEXTURE_MODEL_VERSION,
  }
  return p
}

/** texture_prompt：text / image / images 三选一，均可附加 style_image */
function buildTexturePrompt(input: TripoTextureInput): Record<string, unknown> {
  const hasText = typeof input.prompt === 'string' && input.prompt.trim() !== ''
  const hasImage = input.image !== undefined
  const hasImages = input.images !== undefined && input.images.length > 0
  const chosen = [hasText, hasImage, hasImages].filter(Boolean).length
  if (chosen !== 1) {
    throw badRequest('texture_model：texture_prompt 需 text / image / images 三选一')
  }
  const out: Record<string, unknown> = {}
  if (hasText) out.text = (input.prompt as string).trim()
  if (hasImage) out.image = buildTripoFile(normalizeFileInput(input.image as string | TripoFileInput))
  if (hasImages) {
    out.images = (input.images as ReadonlyArray<string | TripoFileInput>).map((f) =>
      buildTripoFile(normalizeFileInput(f)),
    )
  }
  if (input.styleImage !== undefined) {
    out.style_image = buildTripoFile(normalizeFileInput(input.styleImage))
  }
  return out
}

function buildPreRigCheckPayload(input: TripoPreRigCheckInput): Record<string, unknown> {
  return { original_model_task_id: requireTaskId(input.originalModelTaskId, 'animate_prerigcheck') }
}

function buildRigPayload(input: TripoRigInput): Record<string, unknown> {
  const taskId = requireTaskId(input.originalModelTaskId, 'animate_rig')
  if (/^https?:\/\//i.test(taskId)) {
    throw badRequest(
      'animate_rig：Tripo3D 绑骨只接受原模型任务 id（原始模型须先经 Tripo3D 生成或 import_model 导入），不支持外部模型 URL',
    )
  }
  const rigType = input.rigType ?? 'biped'
  if (!(TRIPO_RIG_TYPES as readonly string[]).includes(rigType)) {
    throw badRequest(`animate_rig：rig_type 需为 ${TRIPO_RIG_TYPES.join(' / ')}（当前 ${rigType}）`)
  }
  const p: Record<string, unknown> = {
    original_model_task_id: taskId,
    rig_type: rigType,
    model_version: input.modelVersion ?? DEFAULT_RIG_MODEL_VERSION,
  }
  if (input.outFormat !== undefined) {
    if (input.outFormat !== 'glb' && input.outFormat !== 'fbx') {
      throw badRequest('animate_rig：out_format 仅支持 glb / fbx')
    }
    p.out_format = input.outFormat
  }
  return p
}

function buildRetargetPayload(input: TripoRetargetInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    original_model_task_id: requireTaskId(input.originalModelTaskId, 'animate_retarget'),
  }
  const animations = input.animations ?? []
  const hasSingle = typeof input.animation === 'string' && input.animation.trim() !== ''
  if (hasSingle && animations.length > 0) {
    throw badRequest('animate_retarget：animation 与 animations 二选一')
  }
  if (hasSingle) {
    p.animation = validatePreset(input.animation as string)
  } else if (animations.length > 0) {
    if (animations.length > 5) {
      throw badRequest('animate_retarget：animations 最多 5 个')
    }
    p.animations = animations.map(validatePreset)
  } else {
    throw badRequest('animate_retarget：animation 或 animations 必填其一')
  }
  if (input.outFormat !== undefined) {
    if (input.outFormat !== 'glb' && input.outFormat !== 'fbx') {
      throw badRequest('animate_retarget：out_format 仅支持 glb / fbx')
    }
    p.out_format = input.outFormat
  }
  return p
}

function buildLowpolyPayload(input: TripoLowpolyInput): Record<string, unknown> {
  const p: Record<string, unknown> = {
    original_model_task_id: requireTaskId(input.originalModelTaskId, 'highpoly_to_lowpoly'),
    model_version: input.modelVersion ?? DEFAULT_LOWPOLY_MODEL_VERSION,
  }
  if (input.faceLimit !== undefined) {
    if (!Number.isInteger(input.faceLimit) || input.faceLimit < 500 || input.faceLimit > 20_000) {
      throw badRequest('highpoly_to_lowpoly：face_limit 需为 500–20000 的整数（quad 时 500–10000）')
    }
    p.face_limit = input.faceLimit
  }
  if (input.quad !== undefined) p.quad = input.quad
  if (input.partNames !== undefined && input.partNames.length > 0) p.part_names = [...input.partNames]
  if (input.bake !== undefined) p.bake = input.bake
  return p
}

/** 动作预设校验：官方 16 个 preset:*（未来可能新增，仅校验格式） */
function validatePreset(value: string): string {
  const v = value.trim()
  if (!/^preset:[A-Za-z0-9_:]+$/.test(v)) {
    throw badRequest(`animate_retarget：动作须为 preset:* 预设（如 preset:walk），收到 ${v}`)
  }
  return v
}

/** 图片输入解析：URL 或 file_token；base64 / 本地路径直接拒绝（官方无 base64 输入） */
function resolveImageFile(value: string | undefined, fileToken: string | undefined): TripoFileInput {
  if (fileToken !== undefined && fileToken !== '') return { fileToken }
  if (value !== undefined && value !== '') {
    if (/^https?:\/\//i.test(value)) return { url: value }
    if (UUID_RE.test(value)) return { fileToken: value }
    throw badRequest(
      '图片输入仅支持 http(s) 直链 URL 或 /upload/sts 上传返回的 file_token（不支持 base64 / 本地路径；本地文件请先经 uploadImage 上传）',
    )
  }
  throw badRequest('图片任务缺少图片输入（url 或 file_token）')
}

/** 统一 file 对象：`{type: 'image', file_token | url}`（官方三选一中的两者；object 为 STS 上传路径未在本 provider 实现） */
function buildTripoFile(file: TripoFileInput): Record<string, unknown> {
  const hasToken = file.fileToken !== undefined && file.fileToken !== ''
  const hasUrl = file.url !== undefined && file.url !== ''
  if (hasToken && hasUrl) {
    throw badRequest('file 的 file_token 与 url 互斥，只能二选一')
  }
  if (hasToken) return { type: 'image', file_token: file.fileToken }
  if (hasUrl) return { type: 'image', url: file.url }
  throw badRequest('file 需 file_token 或 url 二选一')
}

function normalizeFileInput(value: string | TripoFileInput): TripoFileInput {
  return typeof value === 'string' ? resolveImageFile(value, undefined) : value
}

function requireTaskId(value: string | undefined, what: string): string {
  const v = (value ?? '').trim()
  if (!v) throw badRequest(`${what}：original_model_task_id 必填`)
  return v
}

/** providerOptions 合并：payload 后写 options，但已由 builder 校验的字段（ownedKeys）不透传覆盖 */
function mergeOptions(
  payload: Record<string, unknown>,
  options: Record<string, unknown> | undefined,
  ownedKeys: readonly string[],
): Record<string, unknown> {
  const rest = { ...(options ?? {}) }
  for (const key of ownedKeys) delete rest[key]
  return { ...payload, ...rest }
}

function modelVersionOf(options: Record<string, unknown>): string | undefined {
  const v = options.model_version
  return typeof v === 'string' && v !== '' ? v : undefined
}

function outFormatOf(options: Record<string, unknown>): 'glb' | 'fbx' | undefined {
  const v = options.out_format
  if (v === 'glb' || v === 'fbx') return v
  return undefined
}

function stringOption(options: Record<string, unknown>, key: string): string | undefined {
  const v = options[key]
  return typeof v === 'string' && v !== '' ? v : undefined
}

function badRequest(message: string): TripoProviderError {
  return new TripoProviderError('provider_bad_request', message, { retryable: false })
}

// ── 错误映射 ─────────────────────────────────────────────────────────────────

/** 官方错误码表（docs/providers/tripo3d-api.md §14）：HTTP 状态 + code 双判定，code 优先 */
const CODE_TABLE: Readonly<Record<number, { code: ProviderErrorCode; retryable: boolean }>> = {
  // 500 系
  1000: { code: 'provider_http_error', retryable: true }, // 服务端未知错误
  1001: { code: 'provider_http_error', retryable: true }, // 服务端致命错误
  // 401 / 403 认证授权
  1002: { code: 'provider_unauthorized', retryable: false }, // 认证失败（key 无效；勿用 tcli_ Client ID）
  1005: { code: 'provider_unauthorized', retryable: false }, // 无权限访问该资源
  2010: { code: 'provider_insufficient_credits', retryable: false }, // 积分不足
  // 429 限速
  1007: { code: 'provider_rate_limited', retryable: true }, // 请求过于频繁
  2000: { code: 'provider_queue_full', retryable: true }, // 超过生成并发上限（看 Retry-After，指数退避）
  // 400 / 404 参数与任务问题
  1003: { code: 'provider_bad_request', retryable: false },
  1004: { code: 'provider_bad_request', retryable: false },
  2001: { code: 'provider_bad_request', retryable: false }, // 任务不存在（换 key 查询也会命中）
  2002: { code: 'provider_bad_request', retryable: false },
  2003: { code: 'provider_bad_request', retryable: false },
  2004: { code: 'provider_bad_request', retryable: false },
  2005: { code: 'provider_bad_request', retryable: false },
  2006: { code: 'provider_bad_request', retryable: false },
  2007: { code: 'provider_bad_request', retryable: false },
  2008: { code: 'provider_bad_request', retryable: false }, // 输入违反内容政策
  2009: { code: 'provider_bad_request', retryable: false }, // prompt 含非法字符
  2011: { code: 'provider_bad_request', retryable: false },
  2012: { code: 'provider_bad_request', retryable: false },
  2013: { code: 'provider_bad_request', retryable: false },
  2014: { code: 'provider_http_error', retryable: false }, // 审核出错（联系支持）
  2015: { code: 'provider_bad_request', retryable: false }, // 版本已废弃
  2016: { code: 'provider_bad_request', retryable: false },
  2017: { code: 'provider_bad_request', retryable: false },
  2018: { code: 'provider_bad_request', retryable: false },
  2019: { code: 'provider_bad_request', retryable: false }, // 文件未找到
}

function mapApiError(status: number, code: number): { code: ProviderErrorCode; retryable: boolean } {
  const hit = CODE_TABLE[code]
  if (hit !== undefined) return hit
  return mapStatusError(status)
}

/** HTTP 状态兜底映射（响应体非 JSON 或 code 缺失时） */
function mapStatusError(status: number): { code: ProviderErrorCode; retryable: boolean } {
  switch (status) {
    case 400:
      return { code: 'provider_bad_request', retryable: false }
    case 401:
    case 403:
      return { code: 'provider_unauthorized', retryable: false }
    case 404:
      return { code: 'provider_bad_request', retryable: false }
    case 429:
      return { code: 'provider_rate_limited', retryable: true }
    default:
      return { code: 'provider_http_error', retryable: status >= 500 }
  }
}

/** 任务级失败（data.error_code）映射：无 HTTP 状态，只查 code 表 */
function taskErrorMapping(errorCode: number): { code: ProviderErrorCode; retryable: boolean } {
  const hit = CODE_TABLE[errorCode]
  return hit ?? { code: 'provider_http_error', retryable: false }
}

/** 任务 failed 终态：抛错并携带 error_code / error_message */
function taskFailedError(handle: TripoTaskHandle, task: TripoTaskData): TripoProviderError {
  const errorCode = typeof task.error_code === 'number' ? task.error_code : undefined
  const message = typeof task.error_message === 'string' ? task.error_message : undefined
  const mapped =
    errorCode !== undefined
      ? taskErrorMapping(errorCode)
      : { code: 'provider_http_error' as ProviderErrorCode, retryable: false }
  const detail = errorCode !== undefined ? `error_code=${errorCode}` : '无 error_code'
  const text = message ? `，${message}` : ''
  return new TripoProviderError(
    mapped.code,
    `Tripo3D 任务失败（${handle.taskId}，${detail}${text}）`,
    { taskId: handle.taskId, taskStatus: 'failed', retryable: mapped.retryable },
  )
}

/** Retry-After 头：秒数（或 0）→ 数值；HTTP 日期等非常规值忽略 */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined
}

async function parseJsonResponse(resp: Response, what: string): Promise<unknown> {
  try {
    return await resp.json()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new TripoProviderError('provider_http_error', `${what}不是合法 JSON（${detail}）`, {
      status: resp.status,
      retryable: false,
    })
  }
}

function abortReason(signal?: AbortSignal): unknown {
  if (signal !== undefined && signal.reason !== undefined) return signal.reason
  return new DOMException('The operation was aborted.', 'AbortError')
}

// ── 任务响应 → 下载 URL 提取 ─────────────────────────────────────────────────

/** output 的已知 URL 字段（官方文档 §6；可能含未记载字段，勿依赖） */
const OUTPUT_URL_FIELDS = ['model', 'base_model', 'pbr_model', 'generated_image', 'rendered_image'] as const

function extractOutputUrls(output: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of OUTPUT_URL_FIELDS) {
    const url = output[field]
    if (typeof url === 'string' && url) out[field] = url
  }
  return out
}

/** generate_multiview_image 输出：固定顺序 front, left, back, right */
function extractMultiviewUrls(
  output: Record<string, unknown>,
): Readonly<Record<'front' | 'left' | 'back' | 'right', string>> | undefined {
  const mv = asRecord(output.generate_multiview_image)
  const out: Partial<Record<'front' | 'left' | 'back' | 'right', string>> = {}
  for (const [view, field] of [
    ['front', 'front_view_url'],
    ['left', 'left_view_url'],
    ['back', 'back_view_url'],
    ['right', 'right_view_url'],
  ] as const) {
    const url = mv[field]
    if (typeof url === 'string' && url) out[view] = url
  }
  if (Object.keys(out).length === 0) return undefined
  return out as Readonly<Record<'front' | 'left' | 'back' | 'right', string>>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// ── 契约形状的下载物清单投影 ─────────────────────────────────────────────────

/**
 * downloads 投影：以实际下载（含 403 重试后的新链接）为准——
 * model 优先，其次 pbr_model / base_model 作为 glb；rendered_image 作预览图。
 * Tripo3D 贴图烘焙进模型，output 无独立贴图 URL，textureUrls 恒缺省。
 */
function buildTaskDownloads(
  files: readonly TripoResultFile[],
  urls: Record<string, string>,
): TaskDownloads {
  const byRole = new Map(files.map((f) => [f.role, f.url]))
  const glb = byRole.get('model') ?? byRole.get('pbr_model') ?? byRole.get('base_model')
  const downloads: TaskDownloads = {}
  if (glb) downloads.glb = glb
  const preview = byRole.get('rendered_image')
  if (preview) downloads.previewImage = preview
  // 兜底：未下载的 role 以任务输出 URL 为准（例如仅输出 base_model 时）
  if (!downloads.glb) {
    const fallback = urls.model ?? urls.pbr_model ?? urls.base_model
    if (fallback) downloads.glb = fallback
  }
  if (!downloads.previewImage && urls.rendered_image) downloads.previewImage = urls.rendered_image
  return downloads
}

/** modelUrls：已下载者用实际下载 URL（403 重试后的新链接），其余用任务输出 URL */
function mergeUrlRecords(
  files: readonly TripoResultFile[],
  urls: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) out[f.role] = f.url
  for (const [role, url] of Object.entries(urls)) {
    if (out[role] === undefined) out[role] = url
  }
  return out
}

// ── 资产校验 ─────────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46] // "glTF"

/** GLB magic 校验：前 4 字节必须是 "glTF"（glTF 2.0 Binary） */
function isGlbBytes(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === GLB_MAGIC[0] &&
    buffer[1] === GLB_MAGIC[1] &&
    buffer[2] === GLB_MAGIC[2] &&
    buffer[3] === GLB_MAGIC[3]
  )
}

const FORMAT_EXTS = ['glb', 'fbx', 'obj', 'mtl', 'usdz', 'stl', '3mf', 'png', 'jpg', 'webp'] as const

/** 格式推断：优先 URL 扩展名；签名 URL 常无扩展名时按 role 回退（model* → glb，其余 → png） */
function inferFormat(role: string, url: string): TripoFileFormat {
  const path = url.split('?')[0] ?? url
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  if (ext === 'jpeg') return 'jpg'
  if ((FORMAT_EXTS as readonly string[]).includes(ext)) return ext as TripoFileFormat
  if (role.includes('model')) return 'glb'
  return 'png'
}

/** Blob / ArrayBuffer / Uint8Array → Blob（Uint8Array 只取精确字节区间） */
function toBlob(data: Blob | ArrayBuffer | Uint8Array): Blob {
  if (data instanceof Blob) return data
  if (data instanceof ArrayBuffer) return new Blob([data])
  return new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer])
}
