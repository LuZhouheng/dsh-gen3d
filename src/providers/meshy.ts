/**
 * Meshy 官方 API 直连实现（DSH 迁移）。
 *
 * 事实来源：docs/providers/meshy-api.md（2026-08-24 抓取 docs.meshy.ai 官方文档）；
 * remesh 端点另见官方 https://docs.meshy.ai/zh/api/remesh（2026-08-24）。
 * 约定：
 * - 认证：`Authorization: Bearer <MESHY_API_KEY>`，统一经 src/config.ts 的
 *   readProviderKey('meshy') 读取，不直接读 process.env；
 * - 任务制：submit（202 + `{result: taskId}`）→ pollTask 轮询（默认 5s 间隔、
 *   10min 超时，失败终态立即抛）→ 下载资产并校验 GLB magic；
 * - 错误统一映射到 provider_* 契约错误码（src/providers/types.ts 的 ProviderError）；
 * - 所有 HTTP 经依赖注入 fetchImpl（默认 resolveFetchImpl 的原生 fetch），
 *   单测一律 mock fetch 不打真网。
 *
 * 实现同时满足两层：
 * 1. src/providers/types.ts 的统一 Gen3dProvider 接口（submitGeneration /
 *    submitRig / submitAnimation / listMotions / getBalance）；
 * 2. 本分工约定的 Meshy 专属能力面：text-to-3d 两阶段（preview/refine）、
 *    image-to-3d、multi-image-to-3d（smart-topology）、rigging（basic_animations /
 *    expires_at）、animations（post_process）、balance，以及"轮询即下载并校验
 *    GLB magic、consumed_credits 进 raw"的 pollTask。
 *
 * 语义差异说明：契约中 pollTask 文档为"返回 pending 需继续轮询"，本实现按分工
 * 约定在 provider 内部完成 5s/10min 轮询：非终态持续轮询、失败终态立即抛
 * ProviderError、成功即下载校验并返回终态结果（status 恒为 'succeeded'）。
 * 按契约写的工具层调用一次即可得到终态，语义兼容。
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
import { ProviderError, resolveFetchImpl } from './types.js'
import { readProviderKey } from '../config.js'
import { MESHY_ACTION_BASE, MESHY_ACTIONS } from '../legacy/shared/meshy-actions.js'
import { clampTargetPolycount } from '../legacy/shared/catalog.js'

/** 官方 API 基址（HTTPS 强制） */
export const MESHY_BASE_URL = 'https://api.meshy.ai'

/** 轮询默认间隔：5s */
export const DEFAULT_POLL_INTERVAL_MS = 5_000
/** 轮询默认总超时：10min */
export const DEFAULT_POLL_TIMEOUT_MS = 600_000

// ── 错误类型（契约 ProviderError 的 Meshy 子类） ─────────────────────────────

export interface MeshyProviderErrorOptions {
  /** 上游 HTTP 状态码（如有） */
  status?: number
  taskId?: string
  /** 任务级失败时的原始任务状态（FAILED / CANCELED） */
  taskStatus?: string
  /** 显式覆盖契约默认的可重试判定 */
  retryable?: boolean
  cause?: unknown
}

/** Meshy 直连错误：继承契约 ProviderError（isProviderError 可识别），补充任务上下文 */
export class MeshyProviderError extends ProviderError {
  readonly taskId?: string
  readonly taskStatus?: string

  constructor(code: ProviderErrorCode, message: string, opts: MeshyProviderErrorOptions = {}) {
    super({ code, message, httpStatus: opts.status, retryable: opts.retryable, cause: opts.cause })
    this.name = 'MeshyProviderError'
    if (opts.taskId !== undefined) this.taskId = opts.taskId
    if (opts.taskStatus !== undefined) this.taskStatus = opts.taskStatus
  }
}

// ── 任务句柄 / 结果（Meshy 专属能力面，结构兼容契约 TaskHandle / TaskResult） ─

export type MeshyTaskKind =
  | 'text-to-3d-preview'
  | 'text-to-3d-refine'
  | 'image-to-3d'
  | 'multi-image-to-3d'
  | 'rig'
  | 'animate'
  | 'remesh'

export interface MeshyTaskHandle {
  readonly provider: 'meshy'
  readonly taskId: string
  readonly kind: MeshyTaskKind
  readonly createdAtMs: number
}

export type MeshyFileFormat =
  | 'glb'
  | 'fbx'
  | 'obj'
  | 'mtl'
  | 'usdz'
  | 'stl'
  | '3mf'
  | 'png'
  | 'jpg'

/** 已下载并校验的资产文件；role 与官方字段名对应（glb / fbx / thumbnail / rigged_character_glb / walking_glb …） */
export interface MeshyResultFile {
  readonly role: string
  readonly format: MeshyFileFormat
  readonly url: string
  readonly buffer: Uint8Array
}

/** rig 任务自带的 walk/run 基础动画（官方 basic_animations） */
export interface MeshyBasicAnimation {
  readonly category: 'walking' | 'running'
  /** walking_glb / walking_fbx / walking_armature_glb / running_* 等 */
  readonly files: readonly MeshyResultFile[]
}

/** 轮询选项：契约 SubmitOptions（signal）+ 轮询节奏覆盖 */
export interface MeshyPollOptions extends SubmitOptions {
  /** 轮询间隔毫秒（默认 5000） */
  intervalMs?: number
  /** 轮询总超时毫秒（默认 600_000） */
  timeoutMs?: number
}

export interface MeshyTaskResult {
  readonly provider: 'meshy'
  readonly taskId: string
  readonly kind: MeshyTaskKind
  /** 终态即成功（失败终态直接抛 ProviderError，不做轮询返回） */
  readonly status: 'succeeded'
  /** 主交付物（不含 basicAnimations 内的文件） */
  readonly files: readonly MeshyResultFile[]
  /** 契约形状的下载物清单（URL 投影，供统一工具层使用） */
  readonly downloads: TaskDownloads
  /** 原始下载 URL 全集（role -> url），含未下载的 */
  readonly modelUrls: Readonly<Record<string, string>>
  /** 本任务消耗积分（官方 consumed_credits；FAILED 退费为 0） */
  readonly consumedCredits?: number
  /** 结果资产过期时间（毫秒 epoch；官方 expires_at；text-to-3d 官方未记载，可能缺失） */
  readonly expiresAtMs?: number
  /** rig 任务自带的 walk/run 基础动画 */
  readonly basicAnimations?: readonly MeshyBasicAnimation[]
  /** 原始任务响应（含 task_error / progress / consumed_credits 等，供上层审计） */
  readonly raw: unknown
}

// ── 提交参数 ─────────────────────────────────────────────────────────────────

/** text-to-3d 阶段一：preview（只出几何网格，无贴图） */
export interface MeshyTextPreviewInput {
  /** 物体描述，必填，最长 600 字符 */
  prompt: string
  /**
   * standard（默认，高细节）/ smart-topology（meshy-t2）/ lowpoly（已废弃）。
   * 遗留注释：官方参数表中的 decimation_mode / topology / origin_at 等现行字段
   * 未在本结构逐一声明，可经 submitGeneration 的 providerOptions（snake_case）
   * 透传，由 submitGeneration 的 preview 净化统一约束（smart-topology 时
   * should_remesh/decimation_mode/ultra_mode 被官方忽略、仅接受 triangle、面数
   * 100–15,000；standard 面数钳 100–300,000）。
   */
  modelType?: 'standard' | 'lowpoly'
  /** meshy-5 / meshy-6 / meshy-7 / latest（默认 latest = Meshy 7；2026-08 官方 changelog） */
  aiModel?: string
  shouldRemesh?: boolean
  /** 目标面数（1,000–300,000，越界钳制） */
  targetPolycount?: number
  /** a-pose / t-pose / '' 不指定 */
  poseMode?: 'a-pose' | 't-pose' | ''
  moderation?: boolean
  /** glb,obj,fbx,stl,usdz,3mf（3mf 必须显式指定才生成） */
  targetFormats?: readonly string[]
  alphaThumbnail?: boolean
  autoSize?: boolean
}

/** text-to-3d 阶段二：refine（给 preview 网格上贴图） */
export interface MeshyTextRefineInput {
  /** 已成功的 preview 任务 id，必填 */
  previewTaskId: string
  enablePbr?: boolean
  /** 2k（默认）/ 4k / 8k（4k/8k 要求 meshy-6/latest） */
  textureResolution?: '2k' | '4k' | '8k'
  /** 附加贴图引导文本，最长 600 字符；与 textureImageUrl 同时给出时本字段优先 */
  texturePrompt?: string
  /** 2D 引导图：公开 URL 或 base64 Data URI（jpg/jpeg/png） */
  textureImageUrl?: string
  /** 与 preview 的模型不兼容会 400（官方失败模式） */
  aiModel?: string
  moderation?: boolean
  /** 仅 meshy-6 生效；meshy-7/latest 接受但忽略（2026-08 官方 changelog）；去掉基础色贴图上的高光阴影 */
  removeLighting?: boolean
  targetFormats?: readonly string[]
  alphaThumbnail?: boolean
  autoSize?: boolean
}

/** image-to-3d / multi-image-to-3d 共用的网格选项 */
export interface MeshyMeshOptions {
  /** standard（默认）/ smart-topology（低模，meshy-t1/t2）/ lowpoly（已废弃） */
  modelType?: 'standard' | 'smart-topology' | 'lowpoly'
  /** standard：meshy-5/6/7/latest；smart-topology：meshy-t2（默认）/ meshy-t1 */
  aiModel?: string
  /** 更高保真几何细节；仅 meshy-7/latest 的 standard 模式 */
  ultraMode?: boolean
  /** 默认 true；false 跳过贴图阶段 */
  shouldTexture?: boolean
  shouldRemesh?: boolean
  /** 目标面数：standard 100–300,000（默认 30,000）；smart-topology+meshy-t2 100–15,000（默认 4,000） */
  targetPolycount?: number
  poseMode?: 'a-pose' | 't-pose' | ''
  /** 默认 true；仅 meshy-6/7/latest */
  imageEnhancement?: boolean
  /** 默认 true；仅 meshy-6 */
  removeLighting?: boolean
  moderation?: boolean
  targetFormats?: readonly string[]
  autoSize?: boolean
  alphaThumbnail?: boolean
  /** 额外渲染前/右/后/左四视角缩略图（约 +3s 延迟） */
  multiViewThumbnails?: boolean
}

export interface MeshyImageInput extends MeshyMeshOptions {
  /** 图片公开 URL 或 base64 Data URI；与 inputTaskId 二选一（都传时官方 input_task_id 优先） */
  imageUrl?: string
  /** 已完成的图片生成任务 id（须经 API 运行、SUCCEEDED、恰好 1 张图） */
  inputTaskId?: string
}

export interface MeshyMultiImageInput extends MeshyMeshOptions {
  /** 1–4 张同物体不同角度图（URL 或 base64 Data URI）；与 inputTaskId 二选一 */
  imageUrls?: readonly string[]
  /** 已完成的图片生成任务 id（产出 1–4 张图） */
  inputTaskId?: string
}

export interface MeshyRigInput {
  /** 要绑骨的任务 id（支持带贴图的人形模型，面数 ≤300,000）；与 modelUrl 二选一 */
  inputTaskId?: string
  /** 外部 GLB：公开 URL 或 Data URI（仅 .glb；角色面部须朝 +Z 轴） */
  modelUrl?: string
  /** 角色近似身高（米，正数；官方默认 1.7） */
  heightMeters?: number
  /** UV 展开的 base color 贴图（仅 .png） */
  textureImageUrl?: string
}

export interface MeshyAnimatePostProcess {
  /** change_fps / fbx2usdz / extract_armature */
  operationType: 'change_fps' | 'fbx2usdz' | 'extract_armature'
  /** 仅 change_fps 时有效：24 / 25 / 30 / 60 */
  fps?: number
}

export interface MeshyAnimateInput {
  /** 成功完成的 rigging 任务 id，必填 */
  rigTaskId: string
  /** 动作库 id（0–696，静态目录 MESHY_ACTIONS），必填 */
  actionId: number
  postProcess?: MeshyAnimatePostProcess
}

/** 低模重拓扑 remesh（POST /openapi/v1/remesh；2026-08-24 官方页） */
export interface MeshyRemeshInput {
  /** SUCCEEDED 的 text-to-3d-preview/refine、image-to-3d、retexture 任务 id；与 modelUrl 二选一，都传时官方 input_task_id 优先 */
  inputTaskId?: string
  /** 外部模型：.glb/.gltf/.obj/.fbx/.stl，公网 URL 或 Data URI（MIME application/octet-stream） */
  modelUrl?: string
  /** 输出格式，默认 ['glb']（glb/fbx/obj/usdz/blend/stl/3mf） */
  targetFormats?: readonly string[]
  /** 输出拓扑，默认 triangle（quad / triangle） */
  topology?: 'quad' | 'triangle'
  /** 目标面数 100–300,000（默认 30,000）；与 decimationMode 同给时前者被忽略 */
  targetPolycount?: number
  /** 减面档位 1–4（1 ultra / 2 high / 3 medium / 4 low）；设置后 targetPolycount 被忽略 */
  decimationMode?: 1 | 2 | 3 | 4
}

export interface MeshyProviderDeps {
  /** HTTP 传输注入（默认 resolveFetchImpl 的原生 fetch）；单测一律 mock 此实现 */
  fetchImpl?: FetchLike
  /** 轮询间隔毫秒（默认 5000） */
  pollIntervalMs?: number
  /** 轮询总超时毫秒（默认 600_000） */
  pollTimeoutMs?: number
  /** 睡眠注入（默认 setTimeout；测试可注入 no-op 加速） */
  sleep?: (ms: number) => Promise<void>
}

// ── 端点表 ───────────────────────────────────────────────────────────────────

const SUBMIT_PATHS: Record<MeshyTaskKind, string> = {
  'text-to-3d-preview': '/openapi/v2/text-to-3d',
  'text-to-3d-refine': '/openapi/v2/text-to-3d',
  'image-to-3d': '/openapi/v1/image-to-3d',
  'multi-image-to-3d': '/openapi/v1/multi-image-to-3d',
  rig: '/openapi/v1/rigging',
  animate: '/openapi/v1/animations',
  remesh: '/openapi/v1/remesh',
}

const TASK_PATHS: Record<MeshyTaskKind, string> = {
  'text-to-3d-preview': '/openapi/v2/text-to-3d/',
  'text-to-3d-refine': '/openapi/v2/text-to-3d/',
  'image-to-3d': '/openapi/v1/image-to-3d/',
  'multi-image-to-3d': '/openapi/v1/multi-image-to-3d/',
  rig: '/openapi/v1/rigging/',
  animate: '/openapi/v1/animations/',
  remesh: '/openapi/v1/remesh/',
}

const BALANCE_PATH = '/openapi/v1/balance'

// ── Provider ─────────────────────────────────────────────────────────────────

export class MeshyProvider implements Gen3dProvider {
  readonly id: ProviderId = 'meshy'

  private readonly fetchImpl: FetchLike
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number

  constructor(deps: MeshyProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? resolveFetchImpl()
    this.sleepImpl = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  }

  /** 是否已配置 MESHY_API_KEY（上层据此决定回退确定性 mock） */
  isConfigured(): boolean {
    return readProviderKey('meshy') !== undefined
  }

  // ── 统一契约入口（Gen3dProvider） ──

  /**
   * 统一生成提交。text → preview 阶段；两阶段的 refine 经 providerOptions 透传：
   * `{ mode: 'refine', preview_task_id: '<preview task id>' }`（prompt 作 texture_prompt）。
   * providerOptions 其余字段按官方 snake_case 协议透传进请求体；仅 refine 分支会剔除
   * preview/image 专属及官方已废弃字段（REFINE_STRIP_KEYS，见 docs/providers/meshy-api.md §2.2）。
   */
  async submitGeneration(req: GenerationRequest, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    const options = req.providerOptions ?? {}
    let payload: Record<string, unknown>
    let kind: MeshyTaskKind
    if (req.mode === 'text') {
      if (options.mode === 'refine' && typeof options.preview_task_id === 'string' && options.preview_task_id) {
        kind = 'text-to-3d-refine'
        payload = buildRefinePayload({ previewTaskId: options.preview_task_id, texturePrompt: req.prompt })
      } else {
        kind = 'text-to-3d-preview'
        payload = buildPreviewPayload({ prompt: req.prompt })
      }
    } else if (req.mode === 'image') {
      kind = 'image-to-3d'
      payload = buildImagePayload({ imageUrl: req.imageUrls?.[0] })
    } else {
      kind = 'multi-image-to-3d'
      payload = buildMultiImagePayload({ imageUrls: req.imageUrls })
    }
    const rest = { ...options }
    // 契约级判别字段不属 Meshy 官方请求体（preview/refine 的 mode 由 build*Payload 写入）
    delete rest.mode
    delete rest.preview_task_id
    if (kind === 'text-to-3d-refine') {
      // refine 参数表无 preview/image 专属字段，剔除避免官方严格校验未知字段返回 400（见 REFINE_STRIP_KEYS）
      for (const key of REFINE_STRIP_KEYS) delete rest[key]
    }
    Object.assign(payload, rest)
    if (kind === 'text-to-3d-preview') {
      // preview 净化（透传后统一做）：smart-topology 强制 meshy-t2、剥离被忽略字段
      // （should_remesh/decimation_mode/ultra_mode）、仅接受 triangle；
      // 面数按官方范围钳制（smart 100–15,000 / standard 100–300,000）
      sanitizePreviewPayload(payload)
    }
    return this.submit(kind, payload, opts)
  }

  /** 统一绑骨入口；assetUrl → model_url；input_task_id 可经 providerOptions 透传 */
  async submitRig(req: RigRequest, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    const options = req.providerOptions ?? {}
    const inputTaskId = typeof options.input_task_id === 'string' ? options.input_task_id : undefined
    const payload = inputTaskId
      ? buildRigPayload({ inputTaskId })
      : buildRigPayload({ modelUrl: req.assetUrl })
    const rest = { ...options }
    delete rest.input_task_id
    Object.assign(payload, rest)
    return this.submit('rig', payload, opts)
  }

  /** 统一套动作入口；post_process 可经 providerOptions.post_process 透传（snake_case 或 camelCase 均可） */
  async submitAnimation(req: AnimationRequest, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    const options = { ...(req.providerOptions ?? {}) }
    const raw = options.post_process as
      | { operation_type?: string; operationType?: string; fps?: number }
      | undefined
    const postProcess: MeshyAnimatePostProcess | undefined = raw
      ? {
          operationType: (raw.operation_type ?? raw.operationType) as MeshyAnimatePostProcess['operationType'],
          fps: raw.fps,
        }
      : undefined
    delete options.post_process
    const payload = buildAnimatePayload({ rigTaskId: req.rigTaskId, actionId: Number(req.actionId), postProcess })
    Object.assign(payload, options)
    return this.submit('animate', payload, opts)
  }

  /** 统一动作目录（静态，无网络；query 按 label/category/rigType 收窄，rigType 宽松匹配） */
  async listMotions(query?: MotionQuery): Promise<MotionItem[]> {
    const motions = this.catalog()
    const q = query?.query?.trim().toLowerCase()
    return motions.filter(
      (m) =>
        (!q || m.label.toLowerCase().includes(q) || String(m.id).includes(q)) &&
        (!query?.category || m.category === query.category) &&
        (!query?.rigType || m.rigType === undefined || m.rigType === query.rigType),
    )
  }

  /** 统一余额入口 */
  async getBalance(): Promise<BalanceInfo> {
    const balance = await this.balance()
    return { balance, raw: { balance } }
  }

  // ── 提交：text-to-3d 两阶段（Meshy 专属能力面） ──

  /** 阶段一：preview（几何） */
  async textTo3dPreview(input: MeshyTextPreviewInput, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    return this.submit('text-to-3d-preview', buildPreviewPayload(input), opts)
  }

  /** 阶段二：refine（贴图） */
  async textTo3dRefine(input: MeshyTextRefineInput, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    return this.submit('text-to-3d-refine', buildRefinePayload(input), opts)
  }

  // ── 提交：图生 3D / 多视图 ──

  async imageTo3d(input: MeshyImageInput, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    return this.submit('image-to-3d', buildImagePayload(input), opts)
  }

  async multiImageTo3d(input: MeshyMultiImageInput, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    return this.submit('multi-image-to-3d', buildMultiImagePayload(input), opts)
  }

  // ── 提交：自动绑骨 / 套动作 ──

  async rigging(input: MeshyRigInput, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    return this.submit('rig', buildRigPayload(input), opts)
  }

  async animations(input: MeshyAnimateInput, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    return this.submit('animate', buildAnimatePayload(input), opts)
  }

  /**
   * 低模重拓扑（Meshy 扩展方法，同契约外的 submitSmartTopology 模式；轮询统一走 pollTask）。
   * input_task_id 与 model_url 二选一，都传时官方 input_task_id 优先。
   */
  async submitRemesh(input: MeshyRemeshInput, opts?: SubmitOptions): Promise<MeshyTaskHandle> {
    return this.submit('remesh', buildRemeshPayload(input), opts)
  }

  // ── 余额（GET /openapi/v1/balance；不计队列、免费） ──

  async balance(opts?: SubmitOptions): Promise<number> {
    const key = this.requireKey()
    const resp = await this.request(`${MESHY_BASE_URL}${BALANCE_PATH}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: opts?.signal,
    })
    if (!resp.ok) throw await this.mapHttpError(resp)
    const body = await parseJsonResponse(resp, 'balance 响应')
    const balance = (body as { balance?: unknown }).balance
    if (typeof balance !== 'number' || !Number.isFinite(balance)) {
      throw new MeshyProviderError('provider_http_error', 'balance 响应缺少数字 balance 字段', {
        retryable: false,
      })
    }
    return balance
  }

  // ── 轮询（默认 5s 间隔 / 10min 超时；失败终态立即抛；成功即下载并校验 GLB magic） ──

  async pollTask(handle: MeshyTaskHandle, opts?: MeshyPollOptions): Promise<MeshyTaskResult> {
    const intervalMs = opts?.intervalMs ?? this.pollIntervalMs
    const timeoutMs = opts?.timeoutMs ?? this.pollTimeoutMs
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const task = await this.pollOnce(handle)
      const status = task.status
      if (status === 'SUCCEEDED') return this.buildResult(handle, task)
      if (status === 'FAILED') throw taskFailedError(handle.taskId, task)
      if (status === 'CANCELED') {
        throw new MeshyProviderError(
          'provider_http_error',
          `Meshy 任务已取消（CANCELED）：${handle.taskId}`,
          { taskId: handle.taskId, taskStatus: 'CANCELED', retryable: false },
        )
      }
      if (typeof status !== 'string') {
        throw new MeshyProviderError('provider_http_error', `轮询响应缺少 status：${handle.taskId}`, {
          taskId: handle.taskId,
          retryable: false,
        })
      }
      if (Date.now() >= deadline) {
        throw new MeshyProviderError(
          'provider_timeout',
          `Meshy 任务轮询超时（${timeoutMs}ms）：${handle.taskId}`,
          { taskId: handle.taskId, retryable: true },
        )
      }
      await this.sleep(intervalMs, opts?.signal)
    }
  }

  // ── 私有实现 ──

  private requireKey(): string {
    const key = readProviderKey('meshy')
    if (!key) {
      throw new MeshyProviderError(
        'provider_not_configured',
        '未配置 MESHY_API_KEY（上层应回退确定性 mock，provider 层不做 mock）',
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

  private async submit(
    kind: MeshyTaskKind,
    payload: Record<string, unknown>,
    opts?: SubmitOptions,
  ): Promise<MeshyTaskHandle> {
    const key = this.requireKey()
    const resp = await this.request(`${MESHY_BASE_URL}${SUBMIT_PATHS[kind]}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: opts?.signal,
    })
    if (!resp.ok) throw await this.mapHttpError(resp)
    const body = await parseJsonResponse(resp, 'submit 响应')
    const result = (body as { result?: unknown }).result
    if (typeof result !== 'string' || result.length === 0) {
      throw new MeshyProviderError('provider_http_error', `submit 响应缺少 result（${SUBMIT_PATHS[kind]}）`, {
        retryable: false,
      })
    }
    return { provider: 'meshy', taskId: result, kind, createdAtMs: Date.now() }
  }

  private async pollOnce(handle: MeshyTaskHandle): Promise<Record<string, unknown>> {
    const key = this.requireKey()
    const url = `${MESHY_BASE_URL}${TASK_PATHS[handle.kind]}${handle.taskId}`
    const resp = await this.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
    })
    if (!resp.ok) throw await this.mapHttpError(resp, { taskId: handle.taskId })
    const body = await parseJsonResponse(resp, '轮询响应')
    if (typeof body !== 'object' || body === null) {
      throw new MeshyProviderError('provider_http_error', `轮询响应不是 JSON 对象：${handle.taskId}`, {
        taskId: handle.taskId,
        retryable: false,
      })
    }
    return body as Record<string, unknown>
  }

  private async buildResult(
    handle: MeshyTaskHandle,
    task: Record<string, unknown>,
  ): Promise<MeshyTaskResult> {
    const { main, basic } = extractResultUrls(task, handle.kind)
    const files = await this.downloadFiles(Object.entries(main))
    const basicAnimations: MeshyBasicAnimation[] = []
    for (const category of ['walking', 'running'] as const) {
      const categoryUrls = basic[category]
      if (categoryUrls === undefined || Object.keys(categoryUrls).length === 0) continue
      const categoryFiles = await this.downloadFiles(Object.entries(categoryUrls))
      basicAnimations.push({ category, files: categoryFiles })
    }
    if (files.length === 0 && basicAnimations.length === 0) {
      throw new MeshyProviderError(
        'provider_empty_download',
        `任务成功但无任何资产可下载（${handle.kind} ${handle.taskId}）`,
        { taskId: handle.taskId, retryable: false },
      )
    }
    const consumed = task.consumed_credits
    const expires = task.expires_at
    return {
      provider: 'meshy',
      taskId: handle.taskId,
      kind: handle.kind,
      status: 'succeeded',
      files,
      downloads: buildTaskDownloads(handle.kind, main),
      modelUrls: main,
      consumedCredits: typeof consumed === 'number' ? consumed : undefined,
      expiresAtMs: typeof expires === 'number' && expires > 0 ? expires : undefined,
      basicAnimations: basicAnimations.length > 0 ? basicAnimations : undefined,
      raw: task,
    }
  }

  private async downloadFiles(entries: readonly [role: string, url: string][]): Promise<MeshyResultFile[]> {
    return Promise.all(
      entries.map(async ([role, url]) => {
        const buffer = await this.downloadFile(url)
        const format = inferFormat(role, url)
        if (format === 'glb' && !isGlbBytes(buffer)) {
          throw new MeshyProviderError(
            'provider_empty_download',
            `资产内容不是合法 GLB（magic 校验失败）：role=${role}`,
            { retryable: false },
          )
        }
        return { role, format, url, buffer }
      }),
    )
  }

  /** 下载签名 URL 资产。签名 URL 无需认证头；HTTP 失败按 provider_http_error，空内容按 provider_empty_download */
  private async downloadFile(url: string): Promise<Uint8Array> {
    const resp = await this.request(url, { method: 'GET' })
    if (!resp.ok) {
      throw new MeshyProviderError(
        'provider_http_error',
        `资产下载失败 HTTP ${resp.status}（签名 URL 可能已过期）：${url}`,
        { status: resp.status, retryable: false },
      )
    }
    const buffer = new Uint8Array(await resp.arrayBuffer())
    if (buffer.byteLength === 0) {
      throw new MeshyProviderError('provider_empty_download', `资产下载内容为空：${url}`, {
        retryable: false,
      })
    }
    return buffer
  }

  private async mapHttpError(
    resp: Response,
    context: { taskId?: string } = {},
  ): Promise<MeshyProviderError> {
    const message = await readErrorMessage(resp)
    const { code, retryable } = errorCodeForStatus(resp.status, message)
    return new MeshyProviderError(code, `Meshy API HTTP ${resp.status}：${message}`, {
      status: resp.status,
      retryable,
      taskId: context.taskId,
    })
  }

  private mapNetworkError(err: unknown): MeshyProviderError {
    if (err instanceof Error && err.name === 'AbortError') {
      // 调用方取消：原样上抛，让上层区分"取消"与"失败"
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    return new MeshyProviderError('provider_http_error', `网络请求失败：${message}`, {
      retryable: true,
      cause: err,
    })
  }

  /** 静态动作目录（内部；listMotions 的契约形状映射） */
  private catalog(): MotionItem[] {
    const out: MotionItem[] = []
    for (const row of MESHY_ACTIONS) {
      const [id, name, category, , previewGifRel] = row
      if (id === undefined || name === undefined || category === undefined) continue
      out.push({
        id,
        label: name,
        category,
        rigType: undefined,
        isFree: false,
        previewUrl: previewGifRel ? `${MESHY_ACTION_BASE}${previewGifRel}` : undefined,
      })
    }
    return out
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

function buildPreviewPayload(input: MeshyTextPreviewInput): Record<string, unknown> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new MeshyProviderError('provider_bad_request', 'text-to-3d preview：prompt 必填', {
      retryable: false,
    })
  }
  if (prompt.length > 600) {
    throw new MeshyProviderError(
      'provider_bad_request',
      `text-to-3d preview：prompt 最长 600 字符（当前 ${prompt.length}）`,
      { retryable: false },
    )
  }
  const p: Record<string, unknown> = { mode: 'preview', prompt }
  if (input.modelType) p.model_type = input.modelType
  if (input.aiModel) p.ai_model = input.aiModel
  if (input.shouldRemesh !== undefined) p.should_remesh = input.shouldRemesh
  const poly = clampPolycount(input.targetPolycount, false)
  if (poly !== undefined) p.target_polycount = poly
  if (input.poseMode !== undefined) p.pose_mode = input.poseMode
  if (input.moderation !== undefined) p.moderation = input.moderation
  if (input.targetFormats !== undefined && input.targetFormats.length > 0) {
    p.target_formats = [...input.targetFormats]
  }
  if (input.alphaThumbnail !== undefined) p.alpha_thumbnail = input.alphaThumbnail
  if (input.autoSize !== undefined) p.auto_size = input.autoSize
  sanitizePreviewPayload(p)
  return p
}

/**
 * refine 请求体黑名单：preview / image 专属字段 + 官方已废弃字段。
 * 官方 refine 参数表（docs/providers/meshy-api.md §2.2）仅有 mode / preview_task_id /
 * enable_pbr / texture_resolution / texture_prompt / texture_image_url / ai_model /
 * moderation / remove_lighting / target_formats / alpha_thumbnail / auto_size；
 * hd_texture 虽在表中但已标记 ⚠ 已废弃（等价 texture_resolution: "4k"），一并剔除。
 * 以下字段不属 refine 参数（preview/image 专属或官方已废弃），若官方严格校验未知字段，
 * 混入请求体会 400。剔除用黑名单而非白名单：未来官方新增 refine 字段无需改代码即透传。
 */
const REFINE_STRIP_KEYS: readonly string[] = [
  'target_polycount',
  'model_type',
  'pose_mode',
  'should_remesh',
  'ultra_mode',
  'should_texture',
  'image_enhancement',
  'multi_view_thumbnails',
  'symmetry_mode',
  'is_a_t_pose',
  'art_style',
  'hd_texture',
]

function buildRefinePayload(input: MeshyTextRefineInput): Record<string, unknown> {
  const previewTaskId = input.previewTaskId.trim()
  if (!previewTaskId) {
    throw new MeshyProviderError('provider_bad_request', 'text-to-3d refine：preview_task_id 必填', {
      retryable: false,
    })
  }
  const p: Record<string, unknown> = { mode: 'refine', preview_task_id: previewTaskId }
  if (input.enablePbr !== undefined) p.enable_pbr = input.enablePbr
  if (input.textureResolution) p.texture_resolution = input.textureResolution
  if (input.texturePrompt) p.texture_prompt = input.texturePrompt
  if (input.textureImageUrl) p.texture_image_url = input.textureImageUrl
  if (input.aiModel) p.ai_model = input.aiModel
  if (input.moderation !== undefined) p.moderation = input.moderation
  if (input.removeLighting !== undefined) p.remove_lighting = input.removeLighting
  if (input.targetFormats !== undefined && input.targetFormats.length > 0) {
    p.target_formats = [...input.targetFormats]
  }
  if (input.alphaThumbnail !== undefined) p.alpha_thumbnail = input.alphaThumbnail
  if (input.autoSize !== undefined) p.auto_size = input.autoSize
  return p
}

function buildImagePayload(input: MeshyImageInput): Record<string, unknown> {
  const hasTask = typeof input.inputTaskId === 'string' && input.inputTaskId.trim() !== ''
  const hasImage = typeof input.imageUrl === 'string' && input.imageUrl.trim() !== ''
  if (!hasTask && !hasImage) {
    throw new MeshyProviderError('provider_bad_request', 'image-to-3d：image_url 或 input_task_id 必填其一', {
      retryable: false,
    })
  }
  const p: Record<string, unknown> = {}
  // 官方：都传时 input_task_id 优先——只传优先项，避免歧义
  if (hasTask) p.input_task_id = input.inputTaskId
  else p.image_url = input.imageUrl
  applyMeshOptions(p, input)
  return p
}

function buildMultiImagePayload(input: MeshyMultiImageInput): Record<string, unknown> {
  const hasTask = typeof input.inputTaskId === 'string' && input.inputTaskId.trim() !== ''
  const urls = input.imageUrls ?? []
  if (!hasTask && (urls.length < 1 || urls.length > 4)) {
    throw new MeshyProviderError('provider_bad_request', 'multi-image-to-3d：image_urls 需 1–4 张', {
      retryable: false,
    })
  }
  const p: Record<string, unknown> = {}
  if (hasTask) p.input_task_id = input.inputTaskId
  else p.image_urls = [...urls]
  applyMeshOptions(p, input)
  return p
}

function applyMeshOptions(p: Record<string, unknown>, input: MeshyMeshOptions): void {
  if (input.modelType) p.model_type = input.modelType
  if (input.aiModel) p.ai_model = input.aiModel
  if (input.ultraMode !== undefined) p.ultra_mode = input.ultraMode
  if (input.shouldTexture !== undefined) p.should_texture = input.shouldTexture
  if (input.shouldRemesh !== undefined) p.should_remesh = input.shouldRemesh
  const smartTopology = input.modelType === 'smart-topology'
  const poly = clampPolycount(input.targetPolycount, smartTopology)
  if (poly !== undefined) p.target_polycount = poly
  if (input.poseMode !== undefined) p.pose_mode = input.poseMode
  if (input.imageEnhancement !== undefined) p.image_enhancement = input.imageEnhancement
  if (input.removeLighting !== undefined) p.remove_lighting = input.removeLighting
  if (input.moderation !== undefined) p.moderation = input.moderation
  if (input.targetFormats !== undefined && input.targetFormats.length > 0) {
    p.target_formats = [...input.targetFormats]
  }
  if (input.autoSize !== undefined) p.auto_size = input.autoSize
  if (input.alphaThumbnail !== undefined) p.alpha_thumbnail = input.alphaThumbnail
  if (input.multiViewThumbnails !== undefined) p.multi_view_thumbnails = input.multiViewThumbnails
  sanitizeSmartTopology(p)
}

/**
 * smart-topology 净化：标准模型 id 强制 meshy-t2；should_remesh / decimation_mode /
 * ultra_mode 官方忽略（剥离）；topology 仅接受 triangle（其余删除，服务端默认 triangle）。
 */
function sanitizeSmartTopology(p: Record<string, unknown>): void {
  if (p.model_type !== 'smart-topology') return
  const ai = p.ai_model
  if (ai === undefined || ai === 'meshy-5' || ai === 'meshy-6' || ai === 'meshy-7' || ai === 'latest') {
    p.ai_model = 'meshy-t2'
  }
  delete p.should_remesh
  delete p.decimation_mode
  delete p.ultra_mode
  if (p.topology !== undefined && p.topology !== 'triangle') delete p.topology
}

/**
 * preview 请求体净化（submitGeneration 透传后 / buildPreviewPayload 末尾调用）：
 * 面数按官方范围钳制（smart-topology 100–15,000、其余 100–300,000），
 * 再叠加 smart-topology 约束剥离。透传值可能是字符串数字（providerParams 白名单
 * 仅做 trim），先归一化再钳。
 */
function sanitizePreviewPayload(p: Record<string, unknown>): void {
  if (p.target_polycount !== undefined) {
    const n = toFiniteNumber(p.target_polycount)
    const smart = p.model_type === 'smart-topology'
    p.target_polycount = clampOfficialPolycount(n, smart)
  }
  sanitizeSmartTopology(p)
}

/** 非有限数字 / 字符串数字 → 有限 number；其余 undefined */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** 官方预览面数钳制：smart-topology 100–15,000（默认 4,000）；其余 100–300,000（默认 30,000） */
function clampOfficialPolycount(value: number | undefined, smartTopology: boolean): number | undefined {
  if (value === undefined) return undefined
  if (smartTopology) {
    return Number.isFinite(value) ? Math.min(15_000, Math.max(100, Math.round(value))) : 4_000
  }
  return Number.isFinite(value) ? Math.min(300_000, Math.max(100, Math.round(value))) : 30_000
}

function buildRigPayload(input: MeshyRigInput): Record<string, unknown> {
  const hasTask = typeof input.inputTaskId === 'string' && input.inputTaskId.trim() !== ''
  const hasUrl = typeof input.modelUrl === 'string' && input.modelUrl.trim() !== ''
  if (!hasTask && !hasUrl) {
    throw new MeshyProviderError('provider_bad_request', 'auto-rigging：input_task_id 或 model_url 必填其一', {
      retryable: false,
    })
  }
  const p: Record<string, unknown> = {}
  if (hasTask) p.input_task_id = input.inputTaskId
  else p.model_url = input.modelUrl
  if (input.heightMeters !== undefined) {
    if (!Number.isFinite(input.heightMeters) || input.heightMeters <= 0) {
      throw new MeshyProviderError('provider_bad_request', 'auto-rigging：height_meters 需为正数', {
        retryable: false,
      })
    }
    p.height_meters = input.heightMeters
  }
  if (input.textureImageUrl) p.texture_image_url = input.textureImageUrl
  return p
}

function buildAnimatePayload(input: MeshyAnimateInput): Record<string, unknown> {
  const rigTaskId = input.rigTaskId.trim()
  if (!rigTaskId) {
    throw new MeshyProviderError('provider_bad_request', 'animations：rig_task_id 必填', {
      retryable: false,
    })
  }
  if (!Number.isInteger(input.actionId) || input.actionId < 0) {
    throw new MeshyProviderError('provider_bad_request', 'animations：action_id 需为非负整数（动作目录 0–696）', {
      retryable: false,
    })
  }
  const p: Record<string, unknown> = { rig_task_id: rigTaskId, action_id: input.actionId }
  if (input.postProcess !== undefined) {
    const pp: Record<string, unknown> = { operation_type: input.postProcess.operationType }
    if (input.postProcess.operationType === 'change_fps') {
      const fps = input.postProcess.fps
      if (fps === undefined || (fps !== 24 && fps !== 25 && fps !== 30 && fps !== 60)) {
        throw new MeshyProviderError(
          'provider_bad_request',
          'animations：change_fps 需 fps ∈ {24, 25, 30, 60}',
          { retryable: false },
        )
      }
      pp.fps = fps
    } else if (input.postProcess.fps !== undefined) {
      throw new MeshyProviderError('provider_bad_request', 'animations：fps 仅 change_fps 时有效', {
        retryable: false,
      })
    }
    p.post_process = pp
  }
  return p
}

function buildRemeshPayload(input: MeshyRemeshInput): Record<string, unknown> {
  const hasTask = typeof input.inputTaskId === 'string' && input.inputTaskId.trim() !== ''
  const hasUrl = typeof input.modelUrl === 'string' && input.modelUrl.trim() !== ''
  if (!hasTask && !hasUrl) {
    throw new MeshyProviderError('provider_bad_request', 'remesh：input_task_id 或 model_url 必填其一', {
      retryable: false,
    })
  }
  const p: Record<string, unknown> = {}
  // 官方：都传时 input_task_id 优先——只传优先项，避免歧义
  if (hasTask) p.input_task_id = input.inputTaskId
  else p.model_url = input.modelUrl
  if (input.targetFormats !== undefined && input.targetFormats.length > 0) {
    p.target_formats = [...input.targetFormats]
  }
  if (input.topology !== undefined) {
    if (input.topology !== 'quad' && input.topology !== 'triangle') {
      throw new MeshyProviderError('provider_bad_request', 'remesh：topology 仅支持 quad/triangle', {
        retryable: false,
      })
    }
    p.topology = input.topology
  }
  const poly = clampRemeshPolycount(input.targetPolycount)
  const dec = input.decimationMode
  if (dec !== undefined && (dec !== 1 && dec !== 2 && dec !== 3 && dec !== 4)) {
    throw new MeshyProviderError('provider_bad_request', 'remesh：decimation_mode 仅支持 1–4', {
      retryable: false,
    })
  }
  // 官方：decimation_mode 与 target_polycount 互斥，设置后 target_polycount 被忽略
  if (dec !== undefined) {
    p.decimation_mode = dec
    if (poly !== undefined) delete p.target_polycount
  } else if (poly !== undefined) {
    p.target_polycount = poly
  }
  return p
}

/** remesh 目标面数钳制：100–300,000（官方默认 30,000；越界钳、非整数四舍五入） */
function clampRemeshPolycount(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return 30_000
  return Math.min(300_000, Math.max(100, Math.round(value)))
}

/** 面数钳制：smart-topology（meshy-t2）按官方 100–15,000；其余沿用 legacy clampTargetPolycount（1,000–300,000） */
function clampPolycount(value: number | undefined, smartTopology: boolean): number | undefined {
  if (value === undefined) return undefined
  if (!smartTopology) return clampTargetPolycount(value)
  return Number.isFinite(value) ? Math.min(15_000, Math.max(100, Math.round(value))) : 4_000
}

// ── 错误映射 ─────────────────────────────────────────────────────────────────

/**
 * 请求级错误映射（官方 Errors 页：{message} 响应体）。
 * 注意：契约 DEFAULT_RETRYABLE 中 provider_queue_full 默认可重试，但官方
 * Rate Limits 页明确"队列满应等待而非立刻重试"，本实现按分工约定显式覆盖为
 * retryable: false。
 */
function errorCodeForStatus(status: number, message: string): { code: ProviderErrorCode; retryable: boolean } {
  switch (status) {
    case 400:
    case 404:
      return { code: 'provider_bad_request', retryable: false }
    case 401:
      return { code: 'provider_unauthorized', retryable: false }
    case 402:
      return { code: 'provider_insufficient_credits', retryable: false }
    case 403:
      return { code: 'provider_http_error', retryable: false }
    case 429:
      // 并发队列超限：不重试，提示等待（官方 Rate Limits 页两种命中消息）
      if (/NoMoreConcurrentTasks/i.test(message)) {
        return { code: 'provider_queue_full', retryable: false }
      }
      // 请求频率超限：退避后重试
      return { code: 'provider_rate_limited', retryable: true }
    default:
      return { code: 'provider_http_error', retryable: status >= 500 }
  }
}

/** 任务级错误映射（task_error.type → 契约错误码；官方 Errors 页） */
function taskErrorToCode(type: string): ProviderErrorCode {
  switch (type) {
    case 'invalid_input':
      return 'provider_bad_request'
    case 'timeout':
      return 'provider_timeout'
    case 'service_unavailable':
    case 'server_error':
      return 'provider_http_error'
    default:
      return 'provider_http_error'
  }
}

function taskErrorToRetryable(type: string): boolean {
  return type === 'timeout' || type === 'service_unavailable' || type === 'server_error'
}

/** 任务 FAILED：抛错并携带 task_error 的 type/message/code/doc_url */
function taskFailedError(taskId: string, task: Record<string, unknown>): MeshyProviderError {
  const taskError = asRecord(task.task_error)
  const type = typeof taskError.type === 'string' ? taskError.type : 'unknown'
  const message = typeof taskError.message === 'string' ? taskError.message : '未知任务错误'
  const code = typeof taskError.code === 'string' ? taskError.code : undefined
  const docUrl = typeof taskError.doc_url === 'string' ? taskError.doc_url : undefined
  let detail = `${type}: ${message}`
  if (code) detail += ` [${code}]`
  if (docUrl) detail += ` (${docUrl})`
  return new MeshyProviderError(taskErrorToCode(type), `Meshy 任务失败（${taskId}）：${detail}`, {
    taskId,
    taskStatus: 'FAILED',
    retryable: taskErrorToRetryable(type),
  })
}

async function readErrorMessage(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { message?: unknown }
    if (typeof body?.message === 'string' && body.message) return body.message
  } catch {
    // 非 JSON 响应体
  }
  return resp.statusText && resp.statusText !== '' ? resp.statusText : `HTTP ${resp.status}`
}

async function parseJsonResponse(resp: Response, what: string): Promise<unknown> {
  try {
    return await resp.json()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new MeshyProviderError('provider_http_error', `${what}不是合法 JSON（${detail}）`, {
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

function extractResultUrls(
  task: Record<string, unknown>,
  kind: MeshyTaskKind,
): {
  main: Record<string, string>
  basic: Partial<Record<'walking' | 'running', Record<string, string>>>
} {
  if (kind === 'rig') return extractRigUrls(task)
  if (kind === 'animate') {
    return { main: extractAnimateUrls(task), basic: {} }
  }
  return { main: extractMeshUrls(task), basic: {} }
}

/** text/image/multi-image 任务对象：model_urls + thumbnail_url(s) + texture_urls */
function extractMeshUrls(task: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [role, url] of Object.entries(asRecord(task.model_urls))) {
    if (typeof url === 'string' && url) out[role] = url
  }
  for (const [field, role] of [
    ['thumbnail_url', 'thumbnail'],
    ['alpha_thumbnail_url', 'alpha_thumbnail'],
  ] as const) {
    const url = task[field]
    if (typeof url === 'string' && url) out[role] = url
  }
  for (const [name, url] of Object.entries(asRecord(task.thumbnail_urls))) {
    if (typeof url === 'string' && url) out[name] = url
  }
  const textureUrls = task.texture_urls
  if (Array.isArray(textureUrls)) {
    for (const entry of textureUrls) {
      for (const [name, url] of Object.entries(asRecord(entry))) {
        if (typeof url === 'string' && url) out[name] = url
      }
    }
  }
  return out
}

/** rig 任务对象：result.rigged_character_* + result.basic_animations 的 walking_* / running_* 前缀字段 */
function extractRigUrls(task: Record<string, unknown>): {
  main: Record<string, string>
  basic: Partial<Record<'walking' | 'running', Record<string, string>>>
} {
  const result = asRecord(task.result)
  const main: Record<string, string> = {}
  for (const [field, role] of [
    ['rigged_character_glb_url', 'rigged_character_glb'],
    ['rigged_character_fbx_url', 'rigged_character_fbx'],
  ] as const) {
    const url = result[field]
    if (typeof url === 'string' && url) main[role] = url
  }
  const basic: Partial<Record<'walking' | 'running', Record<string, string>>> = {}
  const ba = asRecord(result.basic_animations)
  for (const category of ['walking', 'running'] as const) {
    const urls: Record<string, string> = {}
    for (const [key, url] of Object.entries(ba)) {
      // walking_glb_url → walking_glb（role = 官方字段名去掉 _url 后缀）
      if (key.startsWith(`${category}_`) && typeof url === 'string' && url) {
        urls[key.replace(/_url$/, '')] = url
      }
    }
    if (Object.keys(urls).length > 0) basic[category] = urls
  }
  return { main, basic }
}

/** animate 任务对象：result.animation_* + result.processed_* */
function extractAnimateUrls(task: Record<string, unknown>): Record<string, string> {
  const result = asRecord(task.result)
  const out: Record<string, string> = {}
  for (const [field, role] of [
    ['animation_glb_url', 'animation_glb'],
    ['animation_fbx_url', 'animation_fbx'],
    ['processed_usdz_url', 'processed_usdz'],
    ['processed_armature_fbx_url', 'processed_armature_fbx'],
    ['processed_animation_fps_fbx_url', 'processed_animation_fps_fbx'],
  ] as const) {
    const url = result[field]
    if (typeof url === 'string' && url) out[role] = url
  }
  return out
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// ── 契约形状的下载物清单投影 ─────────────────────────────────────────────────

/** 各任务类别的主模型 / FBX role（用于 downloads 投影） */
const GLB_ROLE: Record<MeshyTaskKind, string> = {
  'text-to-3d-preview': 'glb',
  'text-to-3d-refine': 'glb',
  'image-to-3d': 'glb',
  'multi-image-to-3d': 'glb',
  rig: 'rigged_character_glb',
  animate: 'animation_glb',
  remesh: 'glb',
}

const FBX_ROLE: Record<MeshyTaskKind, string> = {
  'text-to-3d-preview': 'fbx',
  'text-to-3d-refine': 'fbx',
  'image-to-3d': 'fbx',
  'multi-image-to-3d': 'fbx',
  rig: 'rigged_character_fbx',
  animate: 'animation_fbx',
  remesh: 'fbx',
}

const TEXTURE_ROLES = ['base_color', 'metallic', 'normal', 'roughness', 'emission'] as const

function buildTaskDownloads(kind: MeshyTaskKind, main: Record<string, string>): TaskDownloads {
  const glb = main[GLB_ROLE[kind]]
  const fbx = main[FBX_ROLE[kind]]
  const textureUrls = TEXTURE_ROLES.map((r) => main[r]).filter((u): u is string => typeof u === 'string')
  const downloads: TaskDownloads = {}
  if (glb) downloads.glb = glb
  if (fbx) downloads.fbx = fbx
  if (textureUrls.length > 0) downloads.textureUrls = textureUrls
  if (main.thumbnail) downloads.previewImage = main.thumbnail
  return downloads
}

// ── 资产校验 ─────────────────────────────────────────────────────────────────

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

const FORMAT_EXTS = ['glb', 'fbx', 'obj', 'mtl', 'usdz', 'stl', '3mf', 'png', 'jpg'] as const

/** 格式推断：优先 URL 扩展名；签名 URL 常无扩展名时回退 role 后缀 */
function inferFormat(role: string, url: string): MeshyFileFormat {
  const path = url.split('?')[0] ?? url
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  if (ext === 'jpeg') return 'jpg'
  if ((FORMAT_EXTS as readonly string[]).includes(ext)) return ext as MeshyFileFormat
  if (role.includes('glb')) return 'glb'
  if (role.includes('fbx')) return 'fbx'
  if (role.includes('usdz')) return 'usdz'
  return 'png'
}
