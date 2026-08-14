/**
 * Rodin / Hyper3D（影眸科技 Deemos）官方 API 直连实现（DSH 迁移）。
 *
 * 事实来源：docs/providers/rodin-api.md（2026-08-13 抓取 developer.hyper3d.ai 官方文档）。
 *
 * 约定：
 * - 认证：`Authorization: Bearer <RODIN_API_KEY>`，统一经 src/config.ts 的
 *   readProviderKey('rodin') 读取，不直接读 process.env；未配置抛
 *   provider_not_configured（mock 回退是工具层职责）；
 * - 传输：创建类端点一律 multipart/form-data（官方不支持图片 URL 输入）——
 *   provider 先经 fetchImpl 下载参考图字节，再按上传顺序 attach 为 form 文件
 *   （≤5 张，第一张固定用于材质生成）；布尔/数字转字符串 form 字段；数组按官方
 *   约定处理：addons 可重复字段，bbox_condition / image_label 传 JSON 数组字符串；
 * - 任务协议：POST /rodin（或 /bang、/rodin_texture_only）→ 顶层 uuid +
 *   jobs.subscription_key；每 5s POST /status（subscription_key）轮询，全部 job
 *   终态（Done/Failed）才完成，任一 Failed 即失败；全部 Done 后 POST /download
 *   （task_uuid=顶层 uuid）取 list[{url,name}]，逐个下载（含 preview.webp 缩略图），
 *   GLB 文件校验 magic；数据仅保留 7 天，拿到 URL 即下载；
 * - 错误映射：JSON error 字段枚举（NO_ACTIVE_SUBSCRIPTION / SUBSCRIPTION_PLAN_TOO_LOW /
 *   INSUFFICIENT_FUND / INVALID_REQUEST / PERMISSION_DENIED / USER_NOT_FOUND /
 *   GROUP_NOT_FOUND / UNKNOWN）+ HTTP 状态兜底 → provider_* 契约错误码
 *   （src/providers/types.ts 的 ProviderError）；status 过频会被官方限流
 *   （429 → provider_rate_limited，轮询间隔固定 5s 勿改小）；
 * - 能力裁剪：官方无绑骨 / 动画 / 动作目录端点，本实现**不提供**
 *   submitRig / submitAnimation / listMotions（工具层经 `'submitRig' in provider`
 *   探测）；API 仅 Business 及以上订阅可用，门槛说明见 RODIN_SUBSCRIPTION_NOTE /
 *   subscriptionNote()；negativePrompt 官方不支持，忽略；
 * - 轮询：默认间隔 5s、总超时 10min（构造器可注入）；所有 HTTP 经依赖注入
 *   fetchImpl（默认 resolveFetchImpl 的原生 fetch），单测一律 mock fetch 不打真网；
 * - 任务句柄只含公共契约 { provider, taskId } + kind，轮询所需的 subscription_key
 *   由本 provider 进程内注册表记录——句柄仅对提交它的实例有效。
 */

import { readProviderKey } from '../config.js'
import {
  ProviderError,
  resolveFetchImpl,
  type BalanceInfo,
  type FetchLike,
  type Gen3dProvider,
  type GenMode,
  type GenerationRequest,
  type ProviderId,
  type SubmitOptions,
  type TaskDownloads,
} from './types.js'

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 官方 API 基址（创建 / 轮询 / 下载 / 余额均为该前缀下的独立端点） */
export const RODIN_BASE_URL = 'https://api.hyper3d.com/api/v2'

/** 轮询默认间隔：5s（官方最小示例；过频会被限流，勿改小） */
export const DEFAULT_POLL_INTERVAL_MS = 5_000
/** 轮询默认总超时：10min */
export const DEFAULT_POLL_TIMEOUT_MS = 600_000

/** 参考图数量上限（官方：最多 5 张，第一张固定用于材质生成） */
export const RODIN_MAX_IMAGES = 5

// ── 模型档位（tier） ─────────────────────────────────────────────────────────

/**
 * 官方 tier 全集。Sketch/Regular/Detail/Smooth 属 Gen-1&1.5 系列（默认档 Regular）；
 * Gen-2 / Gen-2.5-* 为独立系列。quality/quality_override 的范围随 tier 与
 * mesh_mode 变化（见 qualityOverrideRange）。
 */
export const RODIN_TIERS = [
  'Sketch',
  'Regular',
  'Detail',
  'Smooth',
  'Gen-2',
  'Gen-2.5-Extreme-Low',
  'Gen-2.5-Low',
  'Gen-2.5-Medium',
  'Gen-2.5-High',
  'Gen-2.5-Extreme-High',
] as const

export const RODIN_DEFAULT_TIER = 'Regular'

/** tier 家族：Gen-1&1.5 / Gen-2 / Gen-2.5（决定参数适用范围与面数钳制范围） */
export type RodinTierFamily = 'gen1' | 'gen2' | 'gen2-5'

export function tierFamilyOf(tier: string): RodinTierFamily {
  if (tier === 'Gen-2') return 'gen2'
  if (tier.startsWith('Gen-2.5')) return 'gen2-5'
  return 'gen1'
}

/** 校验 tier 值；缺省返回默认档 Regular，未知值抛 provider_bad_request */
export function normalizeTier(tier: unknown): string {
  if (tier === undefined || tier === null || tier === '') return RODIN_DEFAULT_TIER
  const t = String(tier)
  if ((RODIN_TIERS as readonly string[]).includes(t)) return t
  throw new ProviderError({
    code: 'provider_bad_request',
    message: `Rodin 不支持的 tier：${t}（支持：${RODIN_TIERS.join(' / ')}）`,
    retryable: false,
  })
}

/**
 * quality_override 官方取值范围（docs §3.3 逐版本数值；mesh_mode 缺省按官方默认：
 * Gen-1&1.5 / Gen-2 为 Quad、Gen-2.5 为 Raw）：
 * - Gen-1&1.5 任意：2,000 – 200,000
 * - Gen-2 Raw：500 – 1,000,000；Quad：1,000 – 200,000
 * - Gen-2.5 Quad：1,000 – 200,000
 * - Gen-2.5 Raw + High/Extreme-High：20,000 – 2,000,000
 * - Gen-2.5 Raw + 其余档：500 – 1,000,000
 */
export function qualityOverrideRange(
  tier: string,
  meshMode: 'Raw' | 'Quad' | undefined,
): { min: number; max: number } {
  const family = tierFamilyOf(tier)
  if (family === 'gen1') return { min: 2_000, max: 200_000 }
  const quad = meshMode === 'Quad' || (meshMode === undefined && family !== 'gen2-5')
  if (family === 'gen2') return quad ? { min: 1_000, max: 200_000 } : { min: 500, max: 1_000_000 }
  if (quad) return { min: 1_000, max: 200_000 }
  const hi = tier === 'Gen-2.5-High' || tier === 'Gen-2.5-Extreme-High'
  return hi ? { min: 20_000, max: 2_000_000 } : { min: 500, max: 1_000_000 }
}

/**
 * quality_override 按 tier/mesh_mode 钳制（官方上限 2M 随 tier 变，勿沿用 legacy
 * 的 300k 上限）。Sketch 档官方明示 quality_override 不生效，返回 undefined 剥离。
 */
export function clampQualityOverride(
  tier: string,
  meshMode: 'Raw' | 'Quad' | undefined,
  value: number,
): number | undefined {
  if (tier === 'Sketch') return undefined
  if (!Number.isFinite(value)) {
    throw new ProviderError({
      code: 'provider_bad_request',
      message: 'quality_override 必须是有限数值',
      retryable: false,
    })
  }
  const { min, max } = qualityOverrideRange(tier, meshMode)
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 订阅门槛说明（provider-status 类信息；与 isConfigured 相互独立） */
export const RODIN_SUBSCRIPTION_NOTE =
  'Rodin API 仅 Business 及以上订阅可用（官方定价 Business 档 $120/月含 API access）；' +
  '未订阅或订阅过期时创建任务会返回 NO_ACTIVE_SUBSCRIPTION / SUBSCRIPTION_PLAN_TOO_LOW，' +
  '本 provider 映射为 provider_insufficient_credits（消息含门槛说明）。' +
  '凭证：RODIN_API_KEY（未配置时抛 provider_not_configured，由工具层回退确定性 mock）。'

// ── 错误映射 ─────────────────────────────────────────────────────────────────

/**
 * Rodin 业务错误（JSON error 字段枚举）→ 契约错误码。
 * 与 docs §7.5 建议的差异（按分工约定）：订阅门槛类错误映射为
 * provider_insufficient_credits 而非 provider_unauthorized，并在 message 注明
 * Business 订阅门槛，便于状态界面提示"未订阅不是 key 配错"。
 */
export function mapRodinError(error: unknown, message: unknown, httpStatus?: number): ProviderError {
  const err = typeof error === 'string' ? error : ''
  const rawMsg = typeof message === 'string' && message !== '' ? message : `Rodin API 错误（error=${err || '未知'}）`
  switch (err) {
    case 'NO_ACTIVE_SUBSCRIPTION':
    case 'SUBSCRIPTION_PLAN_TOO_LOW':
      return new ProviderError({
        code: 'provider_insufficient_credits',
        message: `${rawMsg}（Rodin API 需 Business 及以上订阅，见 hyper3d.ai/pricing）`,
        httpStatus,
      })
    case 'INSUFFICIENT_FUND':
      return new ProviderError({
        code: 'provider_insufficient_credits',
        message: `${rawMsg}（账号余额不足，可先经 check_balance 预检）`,
        httpStatus,
      })
    case 'INVALID_REQUEST':
      return new ProviderError({
        code: 'provider_bad_request',
        message: `${rawMsg}（请求畸形/缺参/参数非法，按 message 修正）`,
        httpStatus,
      })
    case 'PERMISSION_DENIED':
    case 'USER_NOT_FOUND':
    case 'GROUP_NOT_FOUND':
      return new ProviderError({
        code: 'provider_unauthorized',
        message: `${rawMsg}（检查 RODIN_API_KEY 是否有效）`,
        httpStatus,
      })
    case 'UNKNOWN':
      return new ProviderError({ code: 'provider_http_error', message: `${rawMsg}（官方未知错误）`, httpStatus })
    default:
      // 无 error 字段或未知错误码：按 HTTP 状态兜底
      if (httpStatus !== undefined && httpStatus > 0) return mapRodinHttpStatus(httpStatus, rawMsg)
      return new ProviderError({ code: 'provider_http_error', message: rawMsg, httpStatus })
  }
}

/**
 * HTTP 级状态兜底（官方文档只记载 201，401/403/429/5xx 语义按通用约定处理）：
 * 401/403 → provider_unauthorized、429 → provider_rate_limited（可重试）、
 * 400/404/422 → provider_bad_request、其余（含 5xx）→ provider_http_error。
 */
export function mapRodinHttpStatus(status: number, message: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError({ code: 'provider_unauthorized', message, httpStatus: status })
  }
  if (status === 429) {
    return new ProviderError({ code: 'provider_rate_limited', message, httpStatus: status })
  }
  if (status === 400 || status === 404 || status === 422) {
    return new ProviderError({ code: 'provider_bad_request', message, httpStatus: status })
  }
  return new ProviderError({ code: 'provider_http_error', message, httpStatus: status })
}

// ── 类型 ─────────────────────────────────────────────────────────────────────

/** 任务类别：生成 / Bang 拆分 / Texture Only 重贴图（轮询与下载流程相同） */
export type RodinTaskKind = 'generate' | 'bang' | 'texture-only'

export interface RodinTaskHandle {
  readonly provider: 'rodin'
  readonly taskId: string
  readonly kind: RodinTaskKind
  readonly createdAtMs: number
}

/** 已下载的下载列表条目（name 来自官方 download 响应的 name 字段） */
export interface RodinResultFile {
  readonly name: string
  readonly url: string
  readonly buffer: Uint8Array
}

export interface RodinTaskResult {
  readonly provider: 'rodin'
  readonly taskId: string
  readonly kind: RodinTaskKind
  /** 终态即成功（失败终态直接抛 ProviderError，不做轮询返回） */
  readonly status: 'succeeded'
  /** 下载列表全部条目的字节（含 preview.webp 等图片） */
  readonly files: readonly RodinResultFile[]
  /** 契约形状的下载物清单（URL 投影；glb/fbx/preview.webp/其余图片贴图） */
  readonly downloads: TaskDownloads
  /** 官方 download 响应原文（审计用；不含密钥） */
  readonly raw: unknown
}

/**
 * POST /rodin 提交参数（字段名即官方 form 字段名；providerOptions 透传同名键）。
 * 参考图必须给 URL：官方不支持 URL 输入，provider 先下载字节再 multipart 直传。
 */
export interface RodinSubmitInput {
  mode: GenMode
  /** 文生 3D 必填；图生 3D 可选（缺省由模型看图生成） */
  prompt?: string
  /** 参考图 URL：图生 1 张、多视图 2–5 张（≤5，保序，第一张用于材质生成） */
  imageUrls?: readonly string[]
  /** 随机种子 0–65535 */
  seed?: number
  /** 模型档位（见 RODIN_TIERS）；默认 Regular */
  tier?: string
  /** 面数档位 high/medium/low/extra-low（具体面数随 tier 与 mesh_mode 变） */
  quality?: string
  /** 自定义面数；按 tier/mesh_mode 钳制（Sketch 档官方不生效，剥离） */
  quality_override?: number
  /** 人形模型强制生成 T/A pose（绑骨就绪姿态） */
  TAPose?: boolean
  /** Raw 三角面 / Quad 四边面 */
  mesh_mode?: string
  /** 仅 HighPack（4K 贴图 + Quad 高模）；Gen-1&1.5+Raw 官方强制为空，剥离 */
  addons?: readonly string[]
  /** PBR（默认）/ Shaded / All / None（Gen-2.5 无 None） */
  material?: string
  /** glb（默认）/ usdz / fbx / obj / stl */
  geometry_file_format?: string
  /** 仅 Gen-1&1.5 多图：concat（默认，单物体多视角）/ fuse（多物体特征融合） */
  condition_mode?: string
  /** 使用图片原始透明通道（仅图生/多视图） */
  use_original_alpha?: boolean
  /** BoundingBox ControlNet：[宽(Y), 高(Z), 长(X)] 3 个整数 */
  bbox_condition?: readonly number[]
  /** 仅 Gen-1&1.5，且 mesh_mode=Raw 时生效：生成后简化 */
  mesh_simplify?: boolean
  /** 仅 Gen-1&1.5，且 mesh_mode=Quad 时生效：平滑 */
  mesh_smooth?: boolean
  /** true 时下载列表额外提供高质量渲染图 */
  preview_render?: boolean
  /** 仅 Gen-2/2.5：后处理精修增强贴图 */
  hd_texture?: boolean
  /** 仅 Gen-2.5：预处理去除贴图光照信息 */
  texture_delight?: boolean
  /** 仅 Gen-2.5：legacy / extreme-low / low / medium / high */
  texture_mode?: string
  /** 仅 Gen-2.5-Extreme-High：微细节尺度 */
  is_micro?: boolean
  /** 仅 Gen-2.5：faithful（默认）/ creative（仅 Medium/High/Extreme-High 可用）；显式传值勿依赖默认 */
  geometry_instruct_mode?: string
  /** 仅 Gen-2.5：逐张输入图朝向标签（F/FL/FR/L/R/B/BL/BR/U/D/?），顺序与上传一致 */
  image_label?: readonly string[]
}

/** POST /bang 提交参数（0.5 credit/次；asset_id 与 model 文件二选一） */
export interface RodinBangInput {
  /** 拆 Rodin Gen-2 任务：传生成任务返回的任务 uuid（model/image/prompt 必须留空） */
  assetId?: string
  /** 拆自定义模型：模型文件字节（obj/glb/stl/fbx/usd/usda/usdz/usdc） */
  modelBytes?: Uint8Array
  modelName?: string
  /** 自定义模型的贴图参考图（≤1 张） */
  imageBytes?: Uint8Array
  imageName?: string
  /** 自定义模型模式的贴图描述（可选） */
  prompt?: string
  /** 拆分强度 2–12，默认 5 */
  strength?: number
  /** 必填：glb（默认）/ obj / fbx / stl / usdz */
  geometryFileFormat?: string
  /** PBR（默认）/ Shaded / None / All */
  material?: string
  /** Basic（默认，2K）/ High（4K） */
  resolution?: string
}

/** POST /rodin_texture_only 提交参数（0.5 credit/次；给已有模型重贴图） */
export interface RodinTextureOnlyInput {
  /** 贴图参考图（必填，1 张） */
  imageBytes: Uint8Array
  imageName?: string
  /** 3D 模型文件（必填，≤10MB） */
  modelBytes: Uint8Array
  modelName?: string
  /** 贴图描述（可选） */
  prompt?: string
  /** 随机种子 0–65535 */
  seed?: number
  /** 纹理生成参考尺度 */
  referenceScale?: number
  /** glb（默认）/ usdz / fbx / obj / stl */
  geometryFileFormat?: string
  /** PBR（默认）/ Shaded */
  material?: string
  /** Basic（默认，2K）/ High（4K） */
  resolution?: string
}

/** 轮询选项：契约 SubmitOptions（signal）+ 轮询节奏覆盖 */
export interface RodinPollOptions extends SubmitOptions {
  /** 轮询间隔毫秒（默认 5000；官方明示过频会被限流，勿改小） */
  intervalMs?: number
  /** 轮询总超时毫秒（默认 600_000） */
  timeoutMs?: number
}

export interface RodinProviderDeps {
  /** HTTP 传输注入（默认 resolveFetchImpl 的原生 fetch）；单测一律 mock 此实现 */
  fetchImpl?: FetchLike
  /** 轮询间隔毫秒（默认 5000） */
  pollIntervalMs?: number
  /** 轮询总超时毫秒（默认 600_000） */
  pollTimeoutMs?: number
  /** 睡眠注入（默认 setTimeout；测试可注入 no-op 加速） */
  sleep?: (ms: number) => Promise<void>
}

// ── Provider ─────────────────────────────────────────────────────────────────

export class RodinProvider implements Gen3dProvider {
  readonly id: ProviderId = 'rodin'

  private readonly fetchImpl: FetchLike
  private readonly sleepImpl: (ms: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly pollTimeoutMs: number
  /** 公共契约 TaskHandle 只含 { provider, taskId }，轮询所需的 subscription_key 由本表记录（进程内有效） */
  private readonly taskMeta = new Map<string, { subscriptionKey: string; kind: RodinTaskKind }>()

  constructor(deps: RodinProviderDeps = {}) {
    this.fetchImpl = deps.fetchImpl ?? resolveFetchImpl()
    this.sleepImpl = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  }

  /** 是否已配置 RODIN_API_KEY（上层据此决定回退确定性 mock） */
  isConfigured(): boolean {
    return readProviderKey('rodin') !== undefined
  }

  /** 订阅门槛说明（provider-status 类信息；与 isConfigured 相互独立） */
  subscriptionNote(): string {
    return RODIN_SUBSCRIPTION_NOTE
  }

  /**
   * 统一生成提交（公共契约入口）。providerOptions 按官方字段名透传
   * （tier / quality / quality_override / TAPose / mesh_mode / addons / material /
   * geometry_file_format / condition_mode / bbox_condition 等，见 RodinSubmitInput）；
   * 未知键忽略不发送。text → 文生（无图）；image → 图生（1 张）；views → 多视图（2–5 张）。
   */
  async submitGeneration(req: GenerationRequest, opts?: SubmitOptions): Promise<RodinTaskHandle> {
    const options = req.providerOptions ?? {}
    const input: RodinSubmitInput = {
      mode: req.mode,
      prompt: req.prompt,
      imageUrls: req.imageUrls,
      seed: req.seed,
      ...pickRodinOptions(options),
    }
    return this.submitRodin(input, opts)
  }

  /** POST /rodin：文生 / 图生 / 多视图（唯一生成入口，multipart 图片字节直传） */
  async submitRodin(input: RodinSubmitInput, opts?: SubmitOptions): Promise<RodinTaskHandle> {
    this.requireKey()
    const tier = normalizeTier(input.tier)
    const family = tierFamilyOf(tier)
    const meshMode = normalizeMeshMode(input.mesh_mode)
    const images = input.imageUrls ?? []
    for (const url of images) {
      if (typeof url !== 'string' || url.trim() === '') {
        throw badRequest('参考图 URL 不能为空')
      }
    }
    if (input.mode === 'text') {
      if (!input.prompt || input.prompt.trim() === '') {
        throw badRequest('文生 3D：prompt 必填')
      }
      if (images.length > 0) {
        throw badRequest('文生 3D：不应携带参考图（官方文生模式要求不上传任何 images）')
      }
    } else if (input.mode === 'image') {
      if (images.length !== 1) {
        throw badRequest(`图生 3D：需恰好 1 张参考图（当前 ${images.length}）`)
      }
    } else {
      if (images.length < 2 || images.length > RODIN_MAX_IMAGES) {
        throw badRequest(`多视图生 3D：需 2–${RODIN_MAX_IMAGES} 张参考图（当前 ${images.length}）`)
      }
    }

    const form = new FormData()
    // 图片字节直传：官方不支持 URL 输入，先经 fetchImpl 下载再 attach（保序，第一张用于材质）
    const refs = await Promise.all(images.map((url, i) => this.fetchImageBytes(url, i, opts?.signal)))
    for (const ref of refs) {
      form.append('images', new Blob([ref.bytes]), ref.name)
    }
    if (input.prompt && input.prompt.trim() !== '') {
      form.append('prompt', input.prompt.trim())
    }
    appendRodinForm(form, input, tier, family, meshMode, images.length)

    const body = await this.submitForm('/rodin', form, opts)
    return this.recordHandle(body, 'generate')
  }

  /** POST /bang：模型拆分（0.5 credit/次；asset_id 拆 Rodin 任务，或 model 文件拆自定义模型） */
  async bang(input: RodinBangInput, opts?: SubmitOptions): Promise<RodinTaskHandle> {
    this.requireKey()
    const hasAsset = typeof input.assetId === 'string' && input.assetId.trim() !== ''
    const hasModel = input.modelBytes !== undefined && input.modelBytes.byteLength > 0
    if (hasAsset === hasModel) {
      throw badRequest('bang：asset_id 与 model 文件必须二选一（互斥）')
    }
    const format = input.geometryFileFormat ?? 'glb'
    if (!(RODIN_BANG_FORMATS as readonly string[]).includes(format)) {
      throw badRequest(`bang：geometry_file_format 仅支持 ${RODIN_BANG_FORMATS.join('/')}（当前 ${format}）`)
    }
    const material = input.material ?? 'PBR'
    if (!(RODIN_MATERIALS as readonly string[]).includes(material)) {
      throw badRequest(`bang：material 仅支持 ${RODIN_MATERIALS.join('/')}（当前 ${material}）`)
    }
    const resolution = input.resolution ?? 'Basic'
    if (resolution !== 'Basic' && resolution !== 'High') {
      throw badRequest(`bang：resolution 仅支持 Basic/High（当前 ${resolution}）`)
    }
    const strength = input.strength ?? 5
    if (!Number.isFinite(strength) || strength < 2 || strength > 12) {
      throw badRequest(`bang：strength 需为 2–12（当前 ${strength}）`)
    }

    const form = new FormData()
    if (hasAsset) {
      form.append('asset_id', input.assetId!.trim())
    } else {
      form.append('model', new Blob([input.modelBytes!]), input.modelName ?? 'model.glb')
      if (input.imageBytes !== undefined && input.imageBytes.byteLength > 0) {
        form.append('image', new Blob([input.imageBytes]), input.imageName ?? 'ref.png')
      }
      if (input.prompt && input.prompt.trim() !== '') {
        form.append('prompt', input.prompt.trim())
      }
    }
    form.append('strength', String(strength))
    form.append('geometry_file_format', format)
    form.append('material', material)
    form.append('resolution', resolution)

    const body = await this.submitForm('/bang', form, opts)
    return this.recordHandle(body, 'bang')
  }

  /** POST /rodin_texture_only：给已有模型重新生成贴图（0.5 credit/次；image + model 必填） */
  async textureOnly(input: RodinTextureOnlyInput, opts?: SubmitOptions): Promise<RodinTaskHandle> {
    this.requireKey()
    if (input.imageBytes === undefined || input.imageBytes.byteLength === 0) {
      throw badRequest('texture_only：image 贴图参考图必填（1 张）')
    }
    if (input.modelBytes === undefined || input.modelBytes.byteLength === 0) {
      throw badRequest('texture_only：model 文件必填')
    }
    if (input.modelBytes.byteLength > 10 * 1024 * 1024) {
      throw badRequest(
        `texture_only：model 文件需 ≤10MB（当前 ${(input.modelBytes.byteLength / 1024 / 1024).toFixed(1)}MB）`,
      )
    }
    if (input.seed !== undefined && (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 65_535)) {
      throw badRequest(`texture_only：seed 需为 0–65535 整数（当前 ${input.seed}）`)
    }
    const format = input.geometryFileFormat ?? 'glb'
    if (!(RODIN_FORMATS as readonly string[]).includes(format)) {
      throw badRequest(`texture_only：geometry_file_format 仅支持 ${RODIN_FORMATS.join('/')}（当前 ${format}）`)
    }
    const material = input.material ?? 'PBR'
    if (material !== 'PBR' && material !== 'Shaded') {
      throw badRequest(`texture_only：material 仅支持 PBR/Shaded（当前 ${material}）`)
    }
    const resolution = input.resolution ?? 'Basic'
    if (resolution !== 'Basic' && resolution !== 'High') {
      throw badRequest(`texture_only：resolution 仅支持 Basic/High（当前 ${resolution}）`)
    }

    const form = new FormData()
    form.append('image', new Blob([input.imageBytes]), input.imageName ?? 'ref.png')
    form.append('model', new Blob([input.modelBytes]), input.modelName ?? 'model.glb')
    if (input.prompt && input.prompt.trim() !== '') {
      form.append('prompt', input.prompt.trim())
    }
    if (input.seed !== undefined) form.append('seed', String(input.seed))
    if (input.referenceScale !== undefined) {
      if (!Number.isFinite(input.referenceScale)) {
        throw badRequest('texture_only：reference_scale 需为有限数值')
      }
      form.append('reference_scale', String(input.referenceScale))
    }
    form.append('geometry_file_format', format)
    form.append('material', material)
    form.append('resolution', resolution)

    const body = await this.submitForm('/rodin_texture_only', form, opts)
    return this.recordHandle(body, 'texture-only')
  }

  /**
   * 轮询至终态：全部 job Done → 下载并返回终态结果；任一 job Failed 立即抛
   * provider_http_error（官方不提供任务级错误码字段，回显原始状态）；轮询被限流
   * （429）抛 provider_rate_limited；超时（默认 10min）抛 provider_timeout。
   */
  async pollTask(handle: RodinTaskHandle, opts?: RodinPollOptions): Promise<RodinTaskResult> {
    if (handle.provider !== this.id) {
      throw badRequest(`任务不属于 ${this.id}：${String(handle.provider)}`)
    }
    this.requireKey()
    const meta = this.taskMeta.get(handle.taskId)
    if (!meta) {
      throw new ProviderError({
        code: 'provider_http_error',
        message: `任务 ${handle.taskId} 不在本 provider 进程内任务表（句柄仅对提交它的实例有效）`,
        retryable: false,
      })
    }
    const intervalMs = opts?.intervalMs ?? this.pollIntervalMs
    const timeoutMs = opts?.timeoutMs ?? this.pollTimeoutMs
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const jobs = await this.pollOnce(handle, meta, opts?.signal)
      if (jobs.length > 0 && jobs.every((j) => j.status === 'Done' || j.status === 'Failed')) {
        const failed = jobs.find((j) => j.status === 'Failed')
        if (failed) {
          throw new ProviderError({
            code: 'provider_http_error',
            message: `Rodin 任务失败（${handle.taskId}）：job ${failed.uuid} status=Failed（官方不提供任务级错误码，请联系支持）`,
            retryable: false,
          })
        }
        return this.buildResult(handle, meta, opts)
      }
      if (Date.now() >= deadline) {
        throw new ProviderError({
          code: 'provider_timeout',
          message: `Rodin 任务轮询超时（${timeoutMs}ms）：${handle.taskId}`,
          retryable: true,
        })
      }
      await this.sleep(intervalMs, opts?.signal)
    }
  }

  /** GET /check_balance：剩余积分（免费调用；无消费明细端点） */
  async getBalance(opts?: SubmitOptions): Promise<BalanceInfo> {
    const key = this.requireKey()
    const resp = await this.request(`${RODIN_BASE_URL}/check_balance`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal: opts?.signal,
    })
    const body = await this.parseApiResponse(resp, '余额响应')
    const balance = body.balance
    if (typeof balance !== 'number' || !Number.isFinite(balance)) {
      throw new ProviderError({
        code: 'provider_http_error',
        message: 'check_balance 响应缺少数字 balance 字段',
        retryable: false,
      })
    }
    return { balance, raw: body }
  }

  // ── 私有实现 ──

  private requireKey(): string {
    const key = readProviderKey('rodin')
    if (!key) {
      throw new ProviderError({
        code: 'provider_not_configured',
        message: '未配置 RODIN_API_KEY（上层应回退确定性 mock，provider 层不做 mock）',
        retryable: false,
      })
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

  private mapNetworkError(err: unknown): ProviderError {
    if (err instanceof Error && err.name === 'AbortError') {
      // 调用方取消：原样上抛，让上层区分"取消"与"失败"
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    return new ProviderError({ code: 'provider_http_error', message: `网络请求失败：${message}`, retryable: true })
  }

  /** 参考图下载（官方不支持 URL 输入，需先取字节再 multipart 直传） */
  private async fetchImageBytes(
    url: string,
    index: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const resp = await this.request(url, { method: 'GET', signal })
    if (!resp.ok) {
      throw new ProviderError({
        code: 'provider_http_error',
        message: `参考图下载失败 HTTP ${resp.status}（检查 URL 是否可公开访问）：${url}`,
        httpStatus: resp.status,
        retryable: resp.status >= 500,
      })
    }
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength === 0) {
      throw badRequest(`参考图内容为空：${url}`)
    }
    return { bytes, name: filenameFromUrl(url, `image-${index + 1}.png`) }
  }

  /** multipart 提交（边界由 fetch 自动生成，不手动设置 Content-Type） */
  private async submitForm(
    path: string,
    form: FormData,
    opts?: SubmitOptions,
  ): Promise<Record<string, unknown>> {
    const key = this.requireKey()
    const resp = await this.request(`${RODIN_BASE_URL}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: opts?.signal,
    })
    return this.parseApiResponse(resp, `${path} 响应`)
  }

  /** 解析响应并做错误映射：error 字段枚举优先，其次 HTTP 状态兜底 */
  private async parseApiResponse(resp: Response, what: string): Promise<Record<string, unknown>> {
    let body: unknown
    try {
      body = await resp.json()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      if (!resp.ok) throw mapRodinHttpStatus(resp.status, `${what}非合法 JSON（${detail}）`)
      throw new ProviderError({
        code: 'provider_http_error',
        message: `${what}不是合法 JSON（${detail}）`,
        httpStatus: resp.status,
        retryable: false,
      })
    }
    if (typeof body !== 'object' || body === null) {
      if (!resp.ok) throw mapRodinHttpStatus(resp.status, `${what}响应不是 JSON 对象`)
      throw new ProviderError({
        code: 'provider_http_error',
        message: `${what}响应不是 JSON 对象`,
        httpStatus: resp.status,
        retryable: false,
      })
    }
    const record = body as Record<string, unknown>
    // 业务错误放 JSON error 字段（成功形态：error=null；download 成功为 error="OK"）
    const err = record.error
    if (typeof err === 'string' && err !== '' && err !== 'OK') {
      throw mapRodinError(err, record.message, resp.status)
    }
    if (!resp.ok) {
      const msg = typeof record.message === 'string' && record.message !== '' ? record.message : `HTTP ${resp.status}`
      throw mapRodinHttpStatus(resp.status, msg)
    }
    return record
  }

  private recordHandle(body: Record<string, unknown>, kind: RodinTaskKind): RodinTaskHandle {
    const uuid = body.uuid
    const subscriptionKey = asRecord(body.jobs).subscription_key
    if (typeof uuid !== 'string' || uuid === '' || typeof subscriptionKey !== 'string' || subscriptionKey === '') {
      throw new ProviderError({
        code: 'provider_http_error',
        message: '提交响应缺少 uuid 或 jobs.subscription_key',
        retryable: false,
      })
    }
    this.taskMeta.set(uuid, { subscriptionKey, kind })
    return { provider: 'rodin', taskId: uuid, kind, createdAtMs: Date.now() }
  }

  private async pollOnce(
    handle: RodinTaskHandle,
    meta: { subscriptionKey: string },
    signal?: AbortSignal,
  ): Promise<Array<{ uuid: string; status: string }>> {
    const key = this.requireKey()
    const resp = await this.request(`${RODIN_BASE_URL}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ subscription_key: meta.subscriptionKey }),
      signal,
    })
    const body = await this.parseApiResponse(resp, '状态轮询响应')
    const jobs = body.jobs
    if (!Array.isArray(jobs)) {
      throw new ProviderError({
        code: 'provider_http_error',
        message: 'status 响应缺少 jobs 数组',
        retryable: false,
      })
    }
    const out: Array<{ uuid: string; status: string }> = []
    for (const job of jobs) {
      const rec = asRecord(job)
      const uuid = rec.uuid
      const status = rec.status
      if (typeof uuid !== 'string' || uuid === '' || typeof status !== 'string' || status === '') {
        throw new ProviderError({
          code: 'provider_http_error',
          message: 'status 响应 job 缺 uuid/status',
          retryable: false,
        })
      }
      out.push({ uuid, status })
    }
    return out
  }

  /** 全部 job Done 后：POST /download 取 URL 列表并逐个下载（含 preview.webp 缩略图） */
  private async buildResult(
    handle: RodinTaskHandle,
    meta: { kind: RodinTaskKind },
    opts?: SubmitOptions,
  ): Promise<RodinTaskResult> {
    const key = this.requireKey()
    const resp = await this.request(`${RODIN_BASE_URL}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ task_uuid: handle.taskId }),
      signal: opts?.signal,
    })
    const body = await this.parseApiResponse(resp, '下载响应')
    const list = body.list
    if (!Array.isArray(list)) {
      throw new ProviderError({
        code: 'provider_empty_download',
        message: `任务完成但下载列表缺失（${handle.taskId}）`,
        retryable: false,
      })
    }
    const entries: Array<{ url: string; name: string }> = []
    for (const item of list) {
      const rec = asRecord(item)
      const url = rec.url
      const name = rec.name
      if (typeof url === 'string' && url !== '' && typeof name === 'string' && name !== '') {
        entries.push({ url, name })
      }
    }
    if (entries.length === 0) {
      throw new ProviderError({
        code: 'provider_empty_download',
        message: `任务完成但下载列表为空（${handle.taskId}）`,
        retryable: false,
      })
    }
    const files = await Promise.all(
      entries.map(async (entry): Promise<RodinResultFile> => {
        const buffer = await this.downloadFile(entry.url)
        if (entry.name.toLowerCase().endsWith('.glb') && !isGlbBytes(buffer)) {
          throw new ProviderError({
            code: 'provider_empty_download',
            message: `资产内容不是合法 GLB（magic 校验失败）：name=${entry.name}`,
            retryable: false,
          })
        }
        return { name: entry.name, url: entry.url, buffer }
      }),
    )
    return {
      provider: 'rodin',
      taskId: handle.taskId,
      kind: meta.kind,
      status: 'succeeded',
      files,
      downloads: taskDownloadsOf(files),
      raw: body,
    }
  }

  /** 下载签名 URL 资产。签名 URL 无需认证头；HTTP 失败按 provider_http_error，空内容按 provider_empty_download */
  private async downloadFile(url: string): Promise<Uint8Array> {
    const resp = await this.request(url, { method: 'GET' })
    if (!resp.ok) {
      throw new ProviderError({
        code: 'provider_http_error',
        message: `资产下载失败 HTTP ${resp.status}（签名 URL 可能已过期）：${url}`,
        httpStatus: resp.status,
        retryable: false,
      })
    }
    const buffer = new Uint8Array(await resp.arrayBuffer())
    if (buffer.byteLength === 0) {
      throw new ProviderError({ code: 'provider_empty_download', message: `资产下载内容为空：${url}`, retryable: false })
    }
    return buffer
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

// ── 参数构建与校验 ───────────────────────────────────────────────────────────

/** providerOptions 白名单（官方字段名，与 RodinSubmitInput 一致；其余键忽略） */
const RODIN_OPTION_KEYS = [
  'tier',
  'quality',
  'quality_override',
  'TAPose',
  'mesh_mode',
  'addons',
  'material',
  'geometry_file_format',
  'condition_mode',
  'use_original_alpha',
  'bbox_condition',
  'mesh_simplify',
  'mesh_smooth',
  'preview_render',
  'hd_texture',
  'texture_delight',
  'texture_mode',
  'is_micro',
  'geometry_instruct_mode',
  'image_label',
] as const

function pickRodinOptions(options: Record<string, unknown>): Partial<RodinSubmitInput> {
  const picked: Record<string, unknown> = {}
  for (const key of RODIN_OPTION_KEYS) {
    const value = options[key]
    if (value !== undefined && value !== null && value !== '') picked[key] = value
  }
  return picked as Partial<RodinSubmitInput>
}

const RODIN_FORMATS = ['glb', 'usdz', 'fbx', 'obj', 'stl'] as const
const RODIN_BANG_FORMATS = ['glb', 'obj', 'fbx', 'stl', 'usdz'] as const
const RODIN_MATERIALS = ['PBR', 'Shaded', 'All', 'None'] as const
const RODIN_QUALITIES = ['high', 'medium', 'low', 'extra-low'] as const
const RODIN_TEXTURE_MODES = ['legacy', 'extreme-low', 'low', 'medium', 'high'] as const
const RODIN_INSTRUCT_MODES = ['faithful', 'creative'] as const
const RODIN_IMAGE_LABELS = ['F', 'FL', 'FR', 'L', 'R', 'B', 'BL', 'BR', 'U', 'D', '?'] as const

function normalizeMeshMode(value: unknown): 'Raw' | 'Quad' | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const v = String(value)
  if (v === 'Raw' || v === 'Quad') return v
  throw badRequest(`mesh_mode 仅支持 Raw/Quad（当前 ${v}）`)
}

/**
 * 官方参数校验并按 tier 家族裁剪（文档 §10.5 提示文档内部存在默认值不一致，
 * 本实现一律显式传值、不依赖官方默认）。不适用当前 tier 的字段剥离（官方会忽略）。
 */
function appendRodinForm(
  form: FormData,
  input: RodinSubmitInput,
  tier: string,
  family: RodinTierFamily,
  meshMode: 'Raw' | 'Quad' | undefined,
  imagesCount: number,
): void {
  form.append('tier', tier)

  if (input.quality !== undefined) {
    if (!RODIN_QUALITIES.includes(input.quality as (typeof RODIN_QUALITIES)[number])) {
      throw badRequest(`quality 仅支持 ${RODIN_QUALITIES.join('/')}（当前 ${input.quality}）`)
    }
    // Sketch 档官方固定 medium：quality 与 quality_override 均不生效，剥离
    if (tier !== 'Sketch') form.append('quality', input.quality)
  }

  if (input.quality_override !== undefined) {
    const clamped = clampQualityOverride(tier, meshMode, input.quality_override)
    if (clamped !== undefined) form.append('quality_override', String(clamped))
  }

  if (input.TAPose !== undefined) form.append('TAPose', input.TAPose ? 'true' : 'false')

  if (meshMode !== undefined) form.append('mesh_mode', meshMode)

  if (input.addons !== undefined && input.addons.length > 0) {
    for (const addon of input.addons) {
      if (addon !== 'HighPack') throw badRequest(`addons 仅支持 HighPack（收到 ${addon}）`)
      // Gen-1&1.5 + Raw：官方强制 addons=[​]，剥离
      if (family !== 'gen1' || meshMode !== 'Raw') form.append('addons', addon)
    }
  }

  if (input.material !== undefined) {
    if (!RODIN_MATERIALS.includes(input.material as (typeof RODIN_MATERIALS)[number])) {
      throw badRequest(`material 仅支持 ${RODIN_MATERIALS.join('/')}（当前 ${input.material}）`)
    }
    // Gen-2.5 官方文档仅列 PBR/Shaded/All（无 None）
    if (!(family === 'gen2-5' && input.material === 'None')) form.append('material', input.material)
  }

  if (input.geometry_file_format !== undefined) {
    if (!RODIN_FORMATS.includes(input.geometry_file_format as (typeof RODIN_FORMATS)[number])) {
      throw badRequest(`geometry_file_format 仅支持 ${RODIN_FORMATS.join('/')}（当前 ${input.geometry_file_format}）`)
    }
    form.append('geometry_file_format', input.geometry_file_format)
  }

  // condition_mode 仅 Gen-1&1.5（Gen-2/2.5 多视图自动处理，剥离）
  if (input.condition_mode !== undefined) {
    if (input.condition_mode !== 'concat' && input.condition_mode !== 'fuse') {
      throw badRequest(`condition_mode 仅支持 concat/fuse（当前 ${input.condition_mode}）`)
    }
    if (family === 'gen1') form.append('condition_mode', input.condition_mode)
  }

  if (input.use_original_alpha !== undefined) {
    form.append('use_original_alpha', input.use_original_alpha ? 'true' : 'false')
  }

  if (input.seed !== undefined) {
    if (!Number.isInteger(input.seed) || input.seed < 0 || input.seed > 65_535) {
      throw badRequest(`seed 需为 0–65535 整数（当前 ${input.seed}）`)
    }
    form.append('seed', String(input.seed))
  }

  if (input.bbox_condition !== undefined) {
    const b = input.bbox_condition
    if (b.length !== 3 || b.some((v) => !Number.isInteger(v))) {
      throw badRequest('bbox_condition 需为 [宽(Y), 高(Z), 长(X)] 3 个整数')
    }
    form.append('bbox_condition', JSON.stringify(b))
  }

  // mesh_simplify / mesh_smooth 仅 Gen-1&1.5 且限 mesh_mode
  if (input.mesh_simplify !== undefined && family === 'gen1' && meshMode === 'Raw') {
    form.append('mesh_simplify', input.mesh_simplify ? 'true' : 'false')
  }
  if (input.mesh_smooth !== undefined && family === 'gen1' && meshMode === 'Quad') {
    form.append('mesh_smooth', input.mesh_smooth ? 'true' : 'false')
  }

  if (input.preview_render !== undefined) {
    form.append('preview_render', input.preview_render ? 'true' : 'false')
  }

  // hd_texture 仅 Gen-2/2.5
  if (input.hd_texture !== undefined && family !== 'gen1') {
    form.append('hd_texture', input.hd_texture ? 'true' : 'false')
  }

  // 以下字段仅 Gen-2.5
  if (input.texture_delight !== undefined && family === 'gen2-5') {
    form.append('texture_delight', input.texture_delight ? 'true' : 'false')
  }
  if (input.texture_mode !== undefined && family === 'gen2-5') {
    if (!RODIN_TEXTURE_MODES.includes(input.texture_mode as (typeof RODIN_TEXTURE_MODES)[number])) {
      throw badRequest(`texture_mode 仅支持 ${RODIN_TEXTURE_MODES.join('/')}（当前 ${input.texture_mode}）`)
    }
    form.append('texture_mode', input.texture_mode)
  }
  if (input.is_micro !== undefined && family === 'gen2-5') {
    form.append('is_micro', input.is_micro ? 'true' : 'false')
  }
  if (input.geometry_instruct_mode !== undefined && family === 'gen2-5') {
    if (!RODIN_INSTRUCT_MODES.includes(input.geometry_instruct_mode as (typeof RODIN_INSTRUCT_MODES)[number])) {
      throw badRequest(
        `geometry_instruct_mode 仅支持 ${RODIN_INSTRUCT_MODES.join('/')}（当前 ${input.geometry_instruct_mode}）`,
      )
    }
    form.append('geometry_instruct_mode', input.geometry_instruct_mode)
  }
  if (input.image_label !== undefined && family === 'gen2-5') {
    if (
      input.image_label.length !== imagesCount ||
      input.image_label.some((l) => !RODIN_IMAGE_LABELS.includes(l as (typeof RODIN_IMAGE_LABELS)[number]))
    ) {
      throw badRequest(
        `image_label 需与参考图数量一致（${imagesCount}）且取值 ∈ ${RODIN_IMAGE_LABELS.join('/')}`,
      )
    }
    form.append('image_label', JSON.stringify(input.image_label))
  }
}

function badRequest(message: string): ProviderError {
  return new ProviderError({ code: 'provider_bad_request', message, retryable: false })
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 从 URL 推断上传文件名（strip query/hash；无扩展名时回退） */
function filenameFromUrl(url: string, fallback: string): string {
  const path = (url.split('?')[0] ?? url).split('#')[0] ?? url
  const base = path.slice(path.lastIndexOf('/') + 1)
  if (base !== '' && base.includes('.')) return base
  return fallback
}

// ── 下载物清单投影 ───────────────────────────────────────────────────────────

/**
 * 按官方 name 字段归类下载列表：model.glb → glb、*.fbx → fbx、
 * preview.webp → previewImage、其余图片 → textureUrls；obj/usdz/stl/mtl 等
 * 模型文件仅在 files 中保留原始下载（契约 TaskDownloads 无对应槽位）。
 */
function taskDownloadsOf(files: readonly RodinResultFile[]): TaskDownloads {
  const downloads: TaskDownloads = {}
  const textures: string[] = []
  for (const file of files) {
    const name = file.name.toLowerCase()
    if (name.endsWith('.glb')) downloads.glb ??= file.url
    else if (name.endsWith('.fbx')) downloads.fbx ??= file.url
    else if (name === 'preview.webp') downloads.previewImage ??= file.url
    else if (/\.(webp|png|jpe?g)$/.test(name)) textures.push(file.url)
  }
  if (textures.length > 0) downloads.textureUrls = textures
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

function abortReason(signal?: AbortSignal): unknown {
  if (signal !== undefined && signal.reason !== undefined) return signal.reason
  return new DOMException('The operation was aborted.', 'AbortError')
}
