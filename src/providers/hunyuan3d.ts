/**
 * Hunyuan3D（腾讯混元生 3D）官方 API 直连实现
 *
 * 协议事实依据：docs/providers/hunyuan3d-api.md（腾讯云官方文档调研，2026-08-13 快照）。
 * 公共契约：src/providers/types.ts（基础设施分工正式版）。
 *
 * 两条官方路径（本文档两者都实现，TokenHub 优先）：
 *
 * 1) 路径 A —— TokenHub 大模型服务平台（生成类，官方主推）
 *    - submit:  POST https://tokenhub.tencentmaas.com/v1/api/3d/submit
 *    - query:   POST https://tokenhub.tencentmaas.com/v1/api/3d/query
 *    - 鉴权：   Authorization: Bearer <HUNYUAN3D_API_KEY>（经 src/config.ts readProviderKey 读取）
 *    - 覆盖：文生 3D / 图生 3D / 多视图生 3D（hy-3d-3.0 / hy-3d-3.1，3.1 支持八视图）
 *    - 参数风格：与腾讯云 API 3.0 同名参数，统一小写下划线（prompt / image_url /
 *      multi_view_images / generate_type / enable_pbr / face_count / polygon_type / result_format）
 *    - 状态机：queued → in_progress → completed；失败形态为 OpenAI 风格 error 字段
 *
 * 2) 路径 B —— 腾讯云 API 3.0（TC3-HMAC-SHA256 签名，生成可选 + 后处理唯一路径）
 *    - endpoint: https://ai3d.tencentcloudapi.com，接口版本 2025-05-13
 *    - 凭证：   HUNYUAN3D_SECRET_ID / HUNYUAN3D_SECRET_KEY（经 src/config.ts
 *      readHunyuanSecretId / readHunyuanSecretKey 读取）
 *    - 覆盖：生成 SubmitHunyuanTo3DProJob / QueryHunyuanTo3DProJob；
 *      自动绑骨 SubmitAutoRiggingJob / DescribeAutoRiggingJob（48 个预设动作 MotionType）；
 *      文生动作 SubmitHunyuanTo3DMotionJob / DescribeHunyuanTo3DMotionJob；
 *      低模重拓扑 Submit3DSmartTopologyJob / Describe3DSmartTopologyJob
 *    - 状态机：WAIT → RUN → FAIL / DONE；ResultFile3Ds: Type / Url / PreviewImageUrl
 *
 * 分工说明：TokenHub 公开文档仅覆盖生成类，绑骨 / 文生动作 / 智能拓扑等后处理接口
 * 只有腾讯云 API 3.0 路径，故本文件实现了手写 TC3-HMAC-SHA256 签名（不依赖官方 SDK）。
 * 公共契约 Gen3dProvider 接口无「文生动作 / 智能拓扑」方法，本 provider 在接口之外
 * 提供扩展方法 submitMotionJob / submitSmartTopology（轮询统一走 pollTask）。
 *
 * 错误映射（公共契约 provider_* 系列，见 src/providers/types.ts）：
 *   未配置凭证            → provider_not_configured
 *   TokenHub 401/403、TC3 AuthFailure.* → provider_unauthorized
 *   TokenHub 429、TC3 LimitExceeded.*   → provider_rate_limited
 *   计费 / 配额（TC3 ResourceInsufficient / ResourceUnavailable.*）→ provider_insufficient_credits
 *   参数错误（400 / TC3 InvalidParameter.*）→ provider_bad_request
 *   5xx / 网络错误 / 未知 → provider_http_error
 *   轮询超时（默认 10min）→ provider_timeout
 *
 * 轮询：默认间隔 5s、总超时 10min（构造器可注入）；FAIL 终态立即抛错，不继续轮询。
 * 所有 HTTP 经依赖注入 fetchImpl（默认原生 fetch），单测一律 mock fetch。
 * 任务句柄只含 { provider, taskId }（公共契约），轮询路径（tokenhub / tc3）与
 * 任务类别由本 provider 进程内注册表记录 —— 句柄仅在本 provider 实例内有效。
 */

import { createHash, createHmac } from 'node:crypto'
import { readHunyuanSecretId, readHunyuanSecretKey, readProviderKey } from '../config.js'
import {
  ProviderError,
  resolveFetchImpl,
  type FetchLike,
  type Gen3dProvider,
  type GenerationRequest,
  type MotionItem,
  type MotionQuery,
  type ProviderErrorCode,
  type ProviderId,
  type RigRequest,
  type SubmitOptions,
  type TaskDownloads,
  type TaskHandle,
  type TaskResult,
} from './types.js'

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const HUNYUAN3D_PROVIDER_ID: ProviderId = 'hunyuan3d'

/** TokenHub 提交 / 查询端点 */
export const TOKENHUB_SUBMIT_URL = 'https://tokenhub.tencentmaas.com/v1/api/3d/submit'
export const TOKENHUB_QUERY_URL = 'https://tokenhub.tencentmaas.com/v1/api/3d/query'
export const TOKENHUB_DEFAULT_MODEL = 'hy-3d-3.0'

/** 腾讯云 API 3.0（TC3）参数 */
export const TC3_ENDPOINT = 'https://ai3d.tencentcloudapi.com'
export const TC3_SERVICE = 'ai3d'
export const TC3_VERSION = '2025-05-13'
export const TC3_REGION = 'ap-guangzhou'

/** 轮询默认参数：5s 间隔，10min 总超时（约 120 次查询） */
export const DEFAULT_POLL_INTERVAL_MS = 5_000
export const DEFAULT_POLL_TIMEOUT_MS = 10 * 60_000

export type HunyuanModel = 'hy-3d-3.0' | 'hy-3d-3.1'

/** 多视图视角名：3.0 三视图；3.1 另支持 top/bottom/left_front/right_front（官方文档列出的视角全集） */
export const HUNYUAN_MULTI_VIEW_NAMES_3_0 = ['left', 'right', 'back'] as const
export const HUNYUAN_MULTI_VIEW_NAMES_3_1 = [
  ...HUNYUAN_MULTI_VIEW_NAMES_3_0,
  'top',
  'bottom',
  'left_front',
  'right_front',
] as const

/** 缺省视角分配序列（imageUrls 按序取视角名；超长需经 providerOptions.viewNames 显式提供） */
export const HUNYUAN_MULTI_VIEW_DEFAULT_NAMES: readonly string[] = HUNYUAN_MULTI_VIEW_NAMES_3_1

/** 绑骨接口内置的 48 个预设动作（MotionType 1–48），官方文档 §3.2 完整枚举 */
export const HUNYUAN_MOTION_TYPES: readonly MotionTypeEntry[] = [
  { id: 1, name: '回旋踢' },
  { id: 2, name: '左勾拳' },
  { id: 3, name: '蓄力攻击' },
  { id: 4, name: '蓄力出拳' },
  { id: 5, name: '二连击打' },
  { id: 6, name: '二连击打-2' },
  { id: 7, name: '后撤' },
  { id: 8, name: '受击' },
  { id: 9, name: '受击-2' },
  { id: 10, name: '受击-3' },
  { id: 11, name: '受击倒地-1' },
  { id: 12, name: '受击倒地-2' },
  { id: 13, name: '落地' },
  { id: 14, name: '沮丧' },
  { id: 15, name: '割喉' },
  { id: 16, name: '刺拳' },
  { id: 17, name: '连续击打' },
  { id: 18, name: '踢腿' },
  { id: 19, name: '侧踢' },
  { id: 20, name: '打太极' },
  { id: 21, name: '后空翻' },
  { id: 22, name: '蹲姿转体' },
  { id: 23, name: '走路-1' },
  { id: 24, name: '走路-2' },
  { id: 25, name: '走路-3' },
  { id: 26, name: '待机-1' },
  { id: 27, name: '待机-2' },
  { id: 28, name: '街舞' },
  { id: 29, name: '扭扭舞' },
  { id: 30, name: '左转弯' },
  { id: 31, name: '右转弯' },
  { id: 32, name: '慢跑' },
  { id: 33, name: '慢跑-2' },
  { id: 34, name: '奔跑' },
  { id: 35, name: '冲刺跑-1' },
  { id: 36, name: '冲刺跑-2' },
  { id: 37, name: '冲刺跑-3' },
  { id: 38, name: '原地跳-1' },
  { id: 39, name: '滑铲' },
  { id: 40, name: '向前大跳' },
  { id: 41, name: '向前大跳-2' },
  { id: 42, name: '跨越' },
  { id: 43, name: '恐吓' },
  { id: 44, name: '向前跌倒' },
  { id: 45, name: '右转' },
  { id: 46, name: '原地跳-2' },
  { id: 47, name: '转身' },
  { id: 48, name: '发送冲击波' },
]

/** 静态动作条目（本地表原始形态） */
export interface MotionTypeEntry {
  readonly id: number
  readonly name: string
}

// ---------------------------------------------------------------------------
// 内部类型
// ---------------------------------------------------------------------------

/** 任务轮询路径（公共契约 TaskHandle 不含，由本 provider 进程内注册表记录） */
export type HunyuanTaskPath = 'tokenhub' | 'tc3'

/** 任务类别：生成 / 自动绑骨 / 文生动作 / 智能拓扑 */
export type HunyuanTaskKind = 'generate' | 'auto-rigging' | 'motion' | 'smart-topology'

interface TaskMeta {
  readonly path: HunyuanTaskPath
  readonly kind: HunyuanTaskKind
  readonly model?: HunyuanModel
}

interface ResultFile {
  readonly type: string
  readonly url: string
  readonly previewImageUrl?: string
}

/** 轮询中间态（内部用） */
type QueryState =
  | { readonly status: 'running' }
  | { readonly status: 'done'; readonly result: TaskResult }
  | { readonly status: 'failed'; readonly error: ProviderError }

// ---------------------------------------------------------------------------
// ProviderError 构造与错误映射
// ---------------------------------------------------------------------------

function providerError(
  code: ProviderErrorCode,
  message: string,
  extra?: { httpStatus?: number; retryable?: boolean; cause?: unknown },
): ProviderError {
  return new ProviderError({ code, message, ...extra })
}

/** 发起请求并解析 JSON；网络错误统一映射为可重试的 provider_http_error */
async function httpJson(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let res: Response
  try {
    res = await fetchImpl(url, init)
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause)
    throw providerError('provider_http_error', `请求 ${url} 失败：${msg}`, { retryable: true, cause })
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  return { status: res.status, body }
}

function isOk(status: number): boolean {
  return status >= 200 && status < 300
}

/** 可中断的 sleep（AbortSignal 触发时抛 DOMException AbortError） */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 合并多个 signal：任一触发即整体中止 */
function combineSignals(signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController()
  for (const s of signals) {
    if (!s) continue
    if (s.aborted) {
      controller.abort()
      break
    }
    s.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const b = body as { error?: unknown; message?: unknown }
  if (typeof b.error === 'string') return b.error
  if (typeof b.error === 'object' && b.error !== null) {
    const e = b.error as { message?: unknown }
    if (typeof e.message === 'string') return e.message
  }
  if (typeof b.message === 'string') return b.message
  return undefined
}

/** TokenHub（OpenAI 风格错误：HTTP 状态码 + error 字段）→ 公共错误码 */
export function mapTokenHubHttpError(status: number, body?: unknown): ProviderError {
  const message = extractErrorMessage(body) ?? `TokenHub HTTP ${status}`
  if (status === 401 || status === 403) {
    return providerError('provider_unauthorized', message, { httpStatus: status })
  }
  if (status === 429) {
    // 429 多为限频；若明确为队列积压则归 provider_queue_full
    if (/queue|queu|排队|队列/.test(message)) {
      return providerError('provider_queue_full', message, { httpStatus: status })
    }
    return providerError('provider_rate_limited', message, { httpStatus: status })
  }
  if (status === 400 || status === 404 || status === 422) {
    return providerError('provider_bad_request', message, { httpStatus: status })
  }
  if (status >= 500) {
    return providerError('provider_http_error', message, { httpStatus: status })
  }
  return providerError('provider_http_error', message, { httpStatus: status })
}

/** 腾讯云 API 3.0 错误（Response.Error{Code,Message} 或任务级 ErrorCode/ErrorMessage）→ 公共错误码 */
export function mapTc3Error(code: unknown, message: unknown, httpStatus?: number): ProviderError {
  const c = typeof code === 'string' ? code : ''
  const m = typeof message === 'string' ? message : '腾讯云 API 错误'
  const text = c ? `${c}: ${m}` : m
  if (c.startsWith('AuthFailure')) {
    return providerError('provider_unauthorized', text, { httpStatus })
  }
  if (c.startsWith('LimitExceeded')) {
    return providerError('provider_rate_limited', text, { httpStatus })
  }
  if (c.startsWith('ResourceInsufficient') || c.startsWith('ResourceUnavailable')) {
    // 官方文档：ResourceUnavailable 含计费 / 配额异常（免费包耗尽且未开通后付费）
    return providerError('provider_insufficient_credits', text, { httpStatus })
  }
  if (c.startsWith('InvalidParameter') || c.startsWith('MissingParameter') || c.startsWith('UnsupportedOperation')) {
    return providerError('provider_bad_request', text, { httpStatus })
  }
  if (c.startsWith('FailedOperation')) {
    return providerError('provider_http_error', text, { httpStatus })
  }
  // 未知错误码：按错误文本关键词兜底
  if (/积分|余额|额度|计费|欠费/.test(m)) {
    return providerError('provider_insufficient_credits', text, { httpStatus })
  }
  return providerError('provider_http_error', text, { httpStatus })
}

// ---------------------------------------------------------------------------
// 结果下载物映射（公共契约 TaskDownloads）
// ---------------------------------------------------------------------------

/**
 * 把官方 ResultFile3Ds / data 数组映射为公共契约 downloads：
 * glb 优先、obj 兜底进主模型槽；fbx 单独槽；图片进 previewImage；其余进 textureUrls。
 */
function taskDownloadsOf(files: readonly ResultFile[]): TaskDownloads {
  const downloads: TaskDownloads = {}
  const glb = files.find((f) => f.type.toLowerCase() === 'glb')
  const obj = files.find((f) => f.type.toLowerCase() === 'obj')
  if (glb) downloads.glb = glb.url
  else if (obj) downloads.glb = obj.url
  const fbx = files.find((f) => f.type.toLowerCase() === 'fbx')
  if (fbx) downloads.fbx = fbx.url
  const image = files.find(
    (f) => f.previewImageUrl && ['image', 'png', 'jpg', 'jpeg', 'webp'].includes(f.type.toLowerCase()),
  )
  // 预览图优先取"图片类型条目"的 PreviewImageUrl；否则取任意条目的 PreviewImageUrl（官方每条结果都带）
  const preview = image ?? files.find((f) => f.previewImageUrl)
  if (preview?.previewImageUrl) downloads.previewImage = preview.previewImageUrl
  const textures = files.filter(
    (f) => !['glb', 'obj', 'fbx', 'image', 'png', 'jpg', 'jpeg', 'webp'].includes(f.type.toLowerCase()),
  )
  if (textures.length > 0) downloads.textureUrls = textures.map((f) => f.url)
  return downloads
}

// ---------------------------------------------------------------------------
// TC3-HMAC-SHA256 签名（腾讯云签名方法 v3，纯函数，供单测稳定验证）
// 算法：https://cloud.tencent.com/document/product/1278/8530
// ---------------------------------------------------------------------------

export interface Tc3SignRequest {
  readonly secretId: string
  readonly secretKey: string
  readonly service: string
  readonly host: string
  /** 请求体（JSON 字符串） */
  readonly payload: string
  /** 请求时间戳（秒）；由调用方传入以便单测稳定 */
  readonly timestamp: number
  readonly method?: string
  readonly uri?: string
  readonly query?: string
}

export interface Tc3SignResult {
  readonly date: string
  readonly timestamp: number
  readonly contentType: string
  readonly authorization: string
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** 时间戳 → YYYY-MM-DD（UTC） */
export function tc3DateOf(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10)
}

export interface Tc3CanonicalParts {
  readonly method: string
  readonly uri: string
  readonly query: string
  readonly contentType: string
  readonly host: string
  readonly payloadHash: string
}

/**
 * 构造 CanonicalRequest（规范请求）：
 *   POST\n<uri>\n<query>\ncontent-type:<ct>\nhost:<host>\n\ncontent-type;host\n<hashedPayload>
 */
export function buildCanonicalRequest(parts: Tc3CanonicalParts): {
  readonly canonicalRequest: string
  readonly signedHeaders: string
} {
  const signedHeaders = 'content-type;host'
  const canonicalHeaders = `content-type:${parts.contentType}\nhost:${parts.host}\n`
  const canonicalRequest = [
    parts.method,
    parts.uri,
    parts.query,
    canonicalHeaders,
    signedHeaders,
    parts.payloadHash,
  ].join('\n')
  return { canonicalRequest, signedHeaders }
}

/** StringToSign：TC3-HMAC-SHA256\n<timestamp>\n<date>/<service>/tc3_request\n<sha256(CanonicalRequest)> */
export function buildStringToSign(timestamp: number, date: string, service: string, canonicalRequest: string): string {
  return `TC3-HMAC-SHA256\n${timestamp}\n${date}/${service}/tc3_request\n${sha256Hex(canonicalRequest)}`
}

/** 派生签名密钥：HMAC(TC3+SecretKey, date) → HMAC(., service) → HMAC(., "tc3_request") */
export function deriveSigningKey(secretKey: string, date: string, service: string): Buffer {
  const kDate = createHmac('sha256', `TC3${secretKey}`).update(date).digest()
  const kService = createHmac('sha256', kDate).update(service).digest()
  return createHmac('sha256', kService).update('tc3_request').digest()
}

export function computeSignature(signingKey: Buffer, stringToSign: string): string {
  return createHmac('sha256', signingKey).update(stringToSign).digest('hex')
}

/** Authorization 头：TC3-HMAC-SHA256 Credential=<SecretId>/<date>/<service>/tc3_request, ... */
export function buildAuthorizationHeader(parts: {
  readonly secretId: string
  readonly date: string
  readonly service: string
  readonly signedHeaders: string
  readonly signature: string
}): string {
  return [
    `TC3-HMAC-SHA256 Credential=${parts.secretId}/${parts.date}/${parts.service}/tc3_request`,
    `SignedHeaders=${parts.signedHeaders}`,
    `Signature=${parts.signature}`,
  ].join(', ')
}

/** 完整 TC3 签名（Content-Type 固定 application/json; charset=utf-8） */
export function signTc3Request(req: Tc3SignRequest): Tc3SignResult {
  const method = req.method ?? 'POST'
  const uri = req.uri ?? '/'
  const query = req.query ?? ''
  const contentType = 'application/json; charset=utf-8'
  const date = tc3DateOf(req.timestamp)
  const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
    method,
    uri,
    query,
    contentType,
    host: req.host,
    payloadHash: sha256Hex(req.payload),
  })
  const stringToSign = buildStringToSign(req.timestamp, date, req.service, canonicalRequest)
  const signingKey = deriveSigningKey(req.secretKey, date, req.service)
  const signature = computeSignature(signingKey, stringToSign)
  return {
    date,
    timestamp: req.timestamp,
    contentType,
    authorization: buildAuthorizationHeader({
      secretId: req.secretId,
      date,
      service: req.service,
      signedHeaders,
      signature,
    }),
  }
}

// ---------------------------------------------------------------------------
// TokenHub 客户端（路径 A）
// ---------------------------------------------------------------------------

/** TokenHub 请求参数（官方 wire 格式：小写下划线）。构建期可变，故字段非 readonly。 */
export interface TokenHubSubmitParams {
  model: HunyuanModel
  prompt?: string
  image_base64?: string
  image_url?: string
  multi_view_images?: readonly {
    readonly name: string
    readonly image_base64?: string
    readonly image_url?: string
  }[]
  generate_type?: string
  enable_pbr?: boolean
  face_count?: number
  polygon_type?: string
  result_format?: string
}

export class TokenHubClient {
  readonly apiKey: string
  private readonly fetchImpl: FetchLike

  constructor(opts: { readonly apiKey: string; readonly fetchImpl?: FetchLike }) {
    this.apiKey = opts.apiKey
    this.fetchImpl = resolveFetchImpl(opts.fetchImpl)
  }

  /** 提交任务，返回任务 id */
  async submit(params: TokenHubSubmitParams, signal?: AbortSignal): Promise<string> {
    const { status, body } = await httpJson(
      this.fetchImpl,
      TOKENHUB_SUBMIT_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(params),
        signal,
      },
    )
    if (!isOk(status)) throw mapTokenHubHttpError(status, body)
    const id = (body as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || id === '') {
      throw providerError('provider_http_error', 'TokenHub 提交响应缺少 id 字段', { httpStatus: status })
    }
    return id
  }

  /** 查询任务状态：completed → done；error 字段 → failed；进行中 / 未知状态 → running（容忍上游新增状态） */
  async query(model: string, taskId: string, signal?: AbortSignal): Promise<QueryState> {
    const { status, body } = await httpJson(
      this.fetchImpl,
      TOKENHUB_QUERY_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model, id: taskId }),
        signal,
      },
    )
    if (!isOk(status)) throw mapTokenHubHttpError(status, body)
    const b = body as { status?: unknown; error?: unknown; data?: unknown } | null
    if (b?.error) {
      const message = extractErrorMessage(b) ?? 'TokenHub 任务失败'
      return { status: 'failed', error: providerError('provider_http_error', message, { httpStatus: status }) }
    }
    if (b?.status === 'completed') {
      const data = Array.isArray(b.data) ? (b.data as Record<string, unknown>[]) : []
      const files: ResultFile[] = data
        .map((f) => ({
          type: typeof f.type === 'string' ? f.type : '',
          url: typeof f.url === 'string' ? f.url : '',
          previewImageUrl: typeof f.preview_image_url === 'string' ? f.preview_image_url : undefined,
        }))
        .filter((f) => f.url !== '')
      if (files.length === 0) {
        return {
          status: 'failed',
          error: providerError('provider_http_error', 'TokenHub 任务 completed 但无结果文件', { httpStatus: status }),
        }
      }
      return { status: 'done', result: { status: 'succeeded', downloads: taskDownloadsOf(files), raw: body } }
    }
    // queued / in_progress / 未知状态一律视为进行中
    return { status: 'running' }
  }
}

// ---------------------------------------------------------------------------
// 腾讯云 API 3.0 客户端（路径 B，TC3 签名）
// ---------------------------------------------------------------------------

const TC3_SUBMIT_ACTIONS: Record<HunyuanTaskKind, string> = {
  generate: 'SubmitHunyuanTo3DProJob',
  'auto-rigging': 'SubmitAutoRiggingJob',
  motion: 'SubmitHunyuanTo3DMotionJob',
  'smart-topology': 'Submit3DSmartTopologyJob',
}

const TC3_QUERY_ACTIONS: Record<HunyuanTaskKind, string> = {
  generate: 'QueryHunyuanTo3DProJob',
  'auto-rigging': 'DescribeAutoRiggingJob',
  motion: 'DescribeHunyuanTo3DMotionJob',
  'smart-topology': 'Describe3DSmartTopologyJob',
}

export interface TencentCloud3dClientOptions {
  readonly secretId: string
  readonly secretKey: string
  readonly fetchImpl?: FetchLike
  readonly endpoint?: string
  readonly region?: string
}

export class TencentCloud3dClient {
  readonly secretId: string
  readonly endpoint: string
  readonly region: string
  private readonly secretKey: string
  private readonly fetchImpl: FetchLike

  constructor(opts: TencentCloud3dClientOptions) {
    this.secretId = opts.secretId
    this.secretKey = opts.secretKey
    this.endpoint = opts.endpoint ?? TC3_ENDPOINT
    this.region = opts.region ?? TC3_REGION
    this.fetchImpl = resolveFetchImpl(opts.fetchImpl)
  }

  /**
   * TC3 签名调用：POST <endpoint>，返回业务 Response 对象。
   * 错误响应（HTTP 非 2xx，或 Response.Error 存在）统一映射为 ProviderError。
   */
  async call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const payload = JSON.stringify(params)
    const timestamp = Math.floor(Date.now() / 1000)
    const host = new URL(this.endpoint).host
    const { contentType, authorization } = signTc3Request({
      secretId: this.secretId,
      secretKey: this.secretKey,
      service: TC3_SERVICE,
      host,
      payload,
      timestamp,
    })
    const { status, body } = await httpJson(
      this.fetchImpl,
      this.endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          Host: host,
          'X-TC-Action': action,
          'X-TC-Version': TC3_VERSION,
          'X-TC-Region': this.region,
          'X-TC-Timestamp': String(timestamp),
          'X-TC-Signature-Version': 'TC3-HMAC-SHA256',
          Authorization: authorization,
        },
        body: payload,
        signal,
      },
    )
    const response = (body as { Response?: unknown } | null)?.Response
    if (typeof response !== 'object' || response === null) {
      throw mapTc3Error(undefined, undefined, status)
    }
    const error = (response as { Error?: unknown }).Error
    if (!isOk(status) || error) {
      const e = error as { Code?: unknown; Message?: unknown } | undefined
      throw mapTc3Error(e?.Code, e?.Message, status)
    }
    return response as Record<string, unknown>
  }

  /** 查询任务状态：DONE → done；FAIL → failed（立即）；WAIT/RUN/未知 → running */
  async queryTask(kind: HunyuanTaskKind, jobId: string, signal?: AbortSignal): Promise<QueryState> {
    const response = await this.call(TC3_QUERY_ACTIONS[kind], { JobId: jobId }, signal)
    const status = response.Status
    if (status === 'DONE') {
      const rawFiles = Array.isArray(response.ResultFile3Ds) ? (response.ResultFile3Ds as Record<string, unknown>[]) : []
      const files: ResultFile[] = rawFiles
        .map((f) => ({
          type: typeof f.Type === 'string' ? f.Type : '',
          url: typeof f.Url === 'string' ? f.Url : '',
          previewImageUrl: typeof f.PreviewImageUrl === 'string' ? f.PreviewImageUrl : undefined,
        }))
        .filter((f) => f.url !== '')
      if (files.length === 0) {
        return { status: 'failed', error: providerError('provider_http_error', `任务 ${jobId} DONE 但无结果文件`) }
      }
      // 积分明细（ResultCreditConsumed / ResultCreditDetails）保留在 raw 中供审计 / 排障
      return { status: 'done', result: { status: 'succeeded', downloads: taskDownloadsOf(files), raw: response } }
    }
    if (status === 'FAIL') {
      return { status: 'failed', error: mapTc3Error(response.ErrorCode, response.ErrorMessage) }
    }
    // WAIT / RUN / 未知状态一律视为进行中
    return { status: 'running' }
  }
}

// ---------------------------------------------------------------------------
// Hunyuan3dProvider（公共契约实现）
// ---------------------------------------------------------------------------

export interface Hunyuan3dProviderOptions {
  readonly fetchImpl?: FetchLike
  /** 轮询间隔，默认 5s */
  readonly pollIntervalMs?: number
  /** 轮询总超时，默认 10min */
  readonly pollTimeoutMs?: number
  /** 显式注入 TokenHub key（缺省经 readProviderKey('hunyuan3d') 读取） */
  readonly tokenHubApiKey?: string
  /** 显式注入 TC3 凭证（缺省经 readHunyuanSecretId / readHunyuanSecretKey 读取） */
  readonly tc3SecretId?: string
  readonly tc3SecretKey?: string
  readonly tc3Region?: string
}

/**
 * Hunyuan3D 直连实现。
 * 生成类提交统一走 TokenHub（官方主推）；未配 TokenHub key 而配了 TC3 凭证时走 TC3。
 * 后处理（绑骨 / 文生动作 / 智能拓扑）只有 TC3 路径。
 */
export class Hunyuan3dProvider implements Gen3dProvider {
  readonly id: ProviderId = HUNYUAN3D_PROVIDER_ID
  private readonly intervalMs: number
  private readonly timeoutMs: number
  private readonly tokenHub: TokenHubClient | undefined
  private readonly tc3: TencentCloud3dClient | undefined
  /** 公共契约 TaskHandle 只含 { provider, taskId }，轮询路径 / 类别由本表记录（进程内有效） */
  private readonly taskMeta = new Map<string, TaskMeta>()
  private readonly pending = new Map<string, AbortController>()

  constructor(opts: Hunyuan3dProviderOptions = {}) {
    this.intervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.timeoutMs = opts.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
    const tokenHubKey = opts.tokenHubApiKey ?? readProviderKey(HUNYUAN3D_PROVIDER_ID)
    if (tokenHubKey) {
      this.tokenHub = new TokenHubClient({ apiKey: tokenHubKey, fetchImpl: opts.fetchImpl })
    }
    const secretId = opts.tc3SecretId ?? readHunyuanSecretId()
    const secretKey = opts.tc3SecretKey ?? readHunyuanSecretKey()
    if (secretId && secretKey) {
      this.tc3 = new TencentCloud3dClient({
        secretId,
        secretKey,
        fetchImpl: opts.fetchImpl,
        region: opts.tc3Region,
      })
    }
  }

  isConfigured(): boolean {
    return this.tokenHub !== undefined || this.tc3 !== undefined
  }

  /** 生成任务：mode 为 text / image / views，TokenHub 优先，TC3 兜底 */
  async submitGeneration(req: GenerationRequest, opts?: SubmitOptions): Promise<TaskHandle> {
    if (this.tokenHub) return this.submitGenerationTokenHub(req, opts?.signal)
    if (this.tc3) return this.submitGenerationTc3(req, opts?.signal)
    throw providerError(
      'provider_not_configured',
      'Hunyuan3D 未配置凭证：请设置 HUNYUAN3D_API_KEY（TokenHub 路径）或 HUNYUAN3D_SECRET_ID/HUNYUAN3D_SECRET_KEY（腾讯云 API 3.0 路径）',
    )
  }

  /** 自动绑骨（公共契约可选能力）。MotionType 预设动作经 providerOptions.motionType 传入 */
  async submitRig(req: RigRequest, opts?: SubmitOptions): Promise<TaskHandle> {
    // 后处理接口只有腾讯云 API 3.0 路径（TokenHub 公开文档未覆盖）
    const tc3 = this.requireTc3('自动绑骨')
    const options = req.providerOptions ?? {}
    const fileType = String(options.fileType ?? 'FBX').toUpperCase()
    assertFileType(fileType, ['FBX', 'GLB'], '自动绑骨')
    const params: Record<string, unknown> = { File3D: { Url: req.assetUrl, Type: fileType } }
    if (options.motionType !== undefined) params.MotionType = Number(options.motionType)
    const response = await tc3.call('SubmitAutoRiggingJob', params, opts?.signal)
    return this.recordJobId(response, 'auto-rigging')
  }

  /**
   * 文生动作（Hunyuan3D 扩展方法，公共契约无对应方法；轮询统一走 pollTask）。
   * 输入文本 → 3D 人物动作 → 带动画数据的 FBX。
   */
  async submitMotionJob(
    req: {
      readonly prompt: string
      readonly retargetFileUrl?: string
      readonly retargetFileType?: string
      /** 动画时长 1–12 秒，默认 5 */
      readonly duration?: number
      /** 返回的 FBX 是否带蒙皮 mesh，默认 true */
      readonly enableMesh?: boolean
      /** prompt 扩写，默认 false */
      readonly enableRewrite?: boolean
      /** 时长自动匹配，默认 false */
      readonly enableDurationEst?: boolean
      /** 模型，默认 HY-Motion-1.0 */
      readonly model?: string
    },
    opts?: SubmitOptions,
  ): Promise<TaskHandle> {
    const tc3 = this.requireTc3('文生动作')
    if (!req.prompt || req.prompt.trim() === '') {
      throw providerError('provider_bad_request', '文生动作（SubmitHunyuanTo3DMotionJob）必须提供 prompt')
    }
    if (req.prompt.length > 128) {
      throw providerError('provider_bad_request', `文生动作 prompt 超过 128 字符（当前 ${req.prompt.length}）`)
    }
    if (req.duration !== undefined && (req.duration < 1 || req.duration > 12)) {
      throw providerError('provider_bad_request', `动画时长须在 1–12 秒（当前 ${req.duration}）`)
    }
    const params: Record<string, unknown> = { Prompt: req.prompt, Model: req.model ?? 'HY-Motion-1.0' }
    if (req.retargetFileUrl) {
      params.RetargetFile = { Url: req.retargetFileUrl, Type: req.retargetFileType ?? 'FBX' }
    }
    if (req.duration !== undefined) params.Duration = req.duration
    if (req.enableMesh !== undefined) params.EnableMesh = req.enableMesh
    if (req.enableRewrite !== undefined) params.EnableRewrite = req.enableRewrite
    if (req.enableDurationEst !== undefined) params.EnableDurationEst = req.enableDurationEst
    const response = await tc3.call('SubmitHunyuanTo3DMotionJob', params, opts?.signal)
    return this.recordJobId(response, 'motion')
  }

  /** 低模重拓扑（Hunyuan3D 扩展方法；Polygon 1.5 模型，高模 → 规整低面数） */
  async submitSmartTopology(
    req: {
      readonly fileUrl: string
      readonly fileType: 'GLB' | 'OBJ'
      /** triangle（默认）/ quadrilateral */
      readonly polygonType?: 'triangle' | 'quadrilateral'
      /** high / medium / low */
      readonly faceLevel?: 'high' | 'medium' | 'low'
    },
    opts?: SubmitOptions,
  ): Promise<TaskHandle> {
    const tc3 = this.requireTc3('智能拓扑')
    assertFileType(req.fileType, ['GLB', 'OBJ'], '智能拓扑')
    const params: Record<string, unknown> = { File3D: { Url: req.fileUrl, Type: req.fileType } }
    if (req.polygonType !== undefined) params.PolygonType = req.polygonType
    if (req.faceLevel !== undefined) params.FaceLevel = req.faceLevel
    const response = await tc3.call('Submit3DSmartTopologyJob', params, opts?.signal)
    return this.recordJobId(response, 'smart-topology')
  }

  /**
   * 轮询至终态：succeeded 返回下载物；FAIL / 轮询错误立即抛 ProviderError；
   * 超时（默认 10min）抛 provider_timeout。
   */
  async pollTask(handle: TaskHandle, opts?: SubmitOptions): Promise<TaskResult> {
    if (handle.provider !== this.id) {
      throw providerError('provider_bad_request', `任务不属于 ${this.id}：${String(handle.provider)}`)
    }
    const meta = this.taskMeta.get(handle.taskId)
    if (!meta) {
      throw providerError(
        'provider_http_error',
        `任务 ${handle.taskId} 不在本 provider 进程内任务表（句柄仅对提交它的实例有效）`,
      )
    }
    const taskAbort = new AbortController()
    this.pending.set(handle.taskId, taskAbort)
    try {
      const signal = combineSignals([opts?.signal, taskAbort.signal])
      const deadline = Date.now() + this.timeoutMs
      for (;;) {
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
        }
        const state = await this.queryTaskState(handle.taskId, meta, signal)
        if (state.status === 'done') return state.result
        if (state.status === 'failed') throw state.error // FAIL 终态立即抛，不继续轮询
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          throw providerError(
            'provider_timeout',
            `任务 ${handle.taskId} 轮询超时（${Math.round(this.timeoutMs / 1000)}s，间隔 ${Math.round(this.intervalMs / 1000)}s）`,
          )
        }
        await sleep(Math.min(this.intervalMs, remaining), signal)
      }
    } finally {
      this.pending.delete(handle.taskId)
    }
  }

  /** 本地动作目录：官方 48 个 MotionType 预设（静态表） */
  async listMotions(query?: MotionQuery): Promise<MotionItem[]> {
    let items: MotionItem[] = HUNYUAN_MOTION_TYPES.map((m) => ({ id: m.id, label: m.name }))
    if (query?.query) {
      const q = query.query
      items = items.filter((i) => i.label.includes(q))
    }
    return items
  }

  /** 任务级取消（扩展方法；发布后的任务由取消而非调用方 signal 控制） */
  abort(handle: TaskHandle, reason?: string): void {
    const controller = this.pending.get(handle.taskId)
    if (controller) controller.abort(reason)
  }

  // -- 内部：提交 ------------------------------------------------------------

  private requireTc3(context: string): TencentCloud3dClient {
    if (!this.tc3) {
      throw providerError(
        'provider_not_configured',
        `Hunyuan3D ${context}仅支持腾讯云 API 3.0 路径：请设置 HUNYUAN3D_SECRET_ID/HUNYUAN3D_SECRET_KEY`,
      )
    }
    return this.tc3
  }

  private recordJobId(response: Record<string, unknown>, kind: HunyuanTaskKind): TaskHandle {
    const jobId = response.JobId
    if (typeof jobId !== 'string' || jobId === '') {
      throw providerError('provider_http_error', `${kind} 提交响应缺少 JobId`)
    }
    this.taskMeta.set(jobId, { path: 'tc3', kind })
    return { taskId: jobId, provider: this.id }
  }

  private async submitGenerationTokenHub(req: GenerationRequest, signal?: AbortSignal): Promise<TaskHandle> {
    const model = normalizeTokenHubModel(req.providerOptions?.model)
    const params = buildTokenHubParams(req, model)
    const taskId = await this.tokenHub!.submit(params, signal)
    this.taskMeta.set(taskId, { path: 'tokenhub', kind: 'generate', model })
    return { taskId, provider: this.id }
  }

  private async submitGenerationTc3(req: GenerationRequest, signal?: AbortSignal): Promise<TaskHandle> {
    const model = normalizeTc3Model(req.providerOptions?.model)
    const params: Record<string, unknown> = { Model: model }
    switch (req.mode) {
      case 'text':
        if (!req.prompt) throw providerError('provider_bad_request', '文生 3D 必须提供 prompt')
        params.Prompt = req.prompt
        break
      case 'image': {
        const url = req.imageUrls?.[0]
        const base64 = req.providerOptions?.imageBase64
        const hasUrl = typeof url === 'string' && url !== ''
        const hasBase64 = typeof base64 === 'string' && base64 !== ''
        if (!hasUrl && !hasBase64) {
          throw providerError('provider_bad_request', '图生 3D 必须提供 imageUrls[0] 或 providerOptions.imageBase64')
        }
        if (hasBase64) params.ImageBase64 = base64
        else params.ImageUrl = url
        break
      }
      case 'views': {
        const views = buildViewsParams(req)
        params.MultiViewImages = views.map((v) => ({ Name: v.name, ImageUrl: v.image_url }))
        break
      }
    }
    const options = req.providerOptions ?? {}
    if (options.generateType) params.GenerateType = String(options.generateType)
    if (options.enablePbr !== undefined) params.EnablePBR = Boolean(options.enablePbr)
    if (options.faceCount !== undefined) params.FaceCount = Number(options.faceCount)
    if (options.polygonType) params.PolygonType = String(options.polygonType)
    if (options.resultFormat) params.ResultFormat = String(options.resultFormat)
    const response = await this.tc3!.call('SubmitHunyuanTo3DProJob', params, signal)
    const jobId = response.JobId
    if (typeof jobId !== 'string' || jobId === '') {
      throw providerError('provider_http_error', 'SubmitHunyuanTo3DProJob 响应缺少 JobId')
    }
    this.taskMeta.set(jobId, { path: 'tc3', kind: 'generate', model: `hy-3d-${model}` })
    return { taskId: jobId, provider: this.id }
  }

  private async queryTaskState(taskId: string, meta: TaskMeta, signal: AbortSignal): Promise<QueryState> {
    if (meta.path === 'tokenhub') {
      if (!this.tokenHub) {
        throw providerError('provider_http_error', '任务路径为 tokenhub 但 TokenHub 客户端未配置')
      }
      return this.tokenHub.query(meta.model ?? TOKENHUB_DEFAULT_MODEL, taskId, signal)
    }
    if (!this.tc3) {
      throw providerError('provider_http_error', '任务路径为 tc3 但腾讯云 API 3.0 客户端未配置')
    }
    return this.tc3.queryTask(meta.kind, taskId, signal)
  }
}

// ---------------------------------------------------------------------------
// 参数构建与校验
// ---------------------------------------------------------------------------

function normalizeTokenHubModel(model: unknown): HunyuanModel {
  if (model === undefined || model === null || model === '') return TOKENHUB_DEFAULT_MODEL
  if (model === 'hy-3d-3.0') return 'hy-3d-3.0'
  if (model === 'hy-3d-3.1') return 'hy-3d-3.1'
  throw providerError('provider_bad_request', `TokenHub 不支持的模型：${String(model)}（支持 hy-3d-3.0 / hy-3d-3.1）`)
}

function normalizeTc3Model(model: unknown): '3.0' | '3.1' {
  if (model === undefined || model === null || model === '') return '3.0'
  if (model === '3.0' || model === 'hy-3d-3.0') return '3.0'
  if (model === '3.1' || model === 'hy-3d-3.1') return '3.1'
  throw providerError('provider_bad_request', `腾讯云 API 不支持的模型：${String(model)}（支持 3.0 / 3.1）`)
}

/**
 * 多视图视角名分配：优先 providerOptions.viewNames 显式名单；
 * 缺省按官方视角全集顺序分配（left/right/back/top/bottom/left_front/right_front）。
 * 超长（超过可用视角名数量）报 provider_bad_request —— 官方文档列出的视角名共 7 个，
 * 若官方有第 8 视角名，请经 viewNames 显式传入。
 */
function buildViewsParams(req: GenerationRequest): { name: string; image_url: string }[] {
  const urls = req.imageUrls ?? []
  if (urls.length === 0) {
    throw providerError('provider_bad_request', '多视图生 3D 必须提供 imageUrls')
  }
  const model = normalizeTokenHubModel(req.providerOptions?.model)
  const explicit = req.providerOptions?.viewNames
  const names = Array.isArray(explicit) && explicit.length > 0
    ? explicit.map((n) => String(n))
    : HUNYUAN_MULTI_VIEW_DEFAULT_NAMES.slice(0, urls.length)
  if (urls.length > names.length) {
    throw providerError(
      'provider_bad_request',
      `多视图图片数量（${urls.length}）超过可用视角名数量（${names.length}）；请经 providerOptions.viewNames 提供完整视角名单`,
    )
  }
  const allowed = model === 'hy-3d-3.1' ? HUNYUAN_MULTI_VIEW_NAMES_3_1 : HUNYUAN_MULTI_VIEW_NAMES_3_0
  for (const name of names) {
    if (!(allowed as readonly string[]).includes(name)) {
      throw providerError(
        'provider_bad_request',
        `模型 ${model} 不支持视角 ${name}（支持：${allowed.join('/')}）`,
      )
    }
  }
  return urls.map((url, i) => ({ name: names[i]!, image_url: url }))
}

/** 构建 TokenHub 提交参数（官方 wire 格式：小写下划线） */
function buildTokenHubParams(req: GenerationRequest, model: HunyuanModel): TokenHubSubmitParams {
  const params: TokenHubSubmitParams = { model }
  switch (req.mode) {
    case 'text':
      if (!req.prompt) throw providerError('provider_bad_request', '文生 3D 必须提供 prompt')
      params.prompt = req.prompt
      break
    case 'image': {
      const url = req.imageUrls?.[0]
      const base64 = req.providerOptions?.imageBase64
      const hasUrl = typeof url === 'string' && url !== ''
      const hasBase64 = typeof base64 === 'string' && base64 !== ''
      if (!hasUrl && !hasBase64) {
        throw providerError('provider_bad_request', '图生 3D 必须提供 imageUrls[0] 或 providerOptions.imageBase64')
      }
      if (hasBase64) params.image_base64 = base64
      else params.image_url = url
      break
    }
    case 'views': {
      const views = buildViewsParams(req)
      params.multi_view_images = views.map((v) => ({
        name: v.name,
        image_url: v.image_url,
      }))
      break
    }
  }
  const options = req.providerOptions ?? {}
  if (options.generateType) params.generate_type = String(options.generateType)
  if (options.enablePbr !== undefined) params.enable_pbr = Boolean(options.enablePbr)
  if (options.faceCount !== undefined) params.face_count = Number(options.faceCount)
  if (options.polygonType) params.polygon_type = String(options.polygonType)
  if (options.resultFormat) params.result_format = String(options.resultFormat)
  return params
}

function assertFileType(actual: string, allowed: readonly string[], context: string): void {
  const upper = actual.toUpperCase()
  const normalized = allowed.map((a) => a.toUpperCase())
  if (!normalized.includes(upper)) {
    throw providerError(
      'provider_bad_request',
      `${context} 不支持输入格式 ${actual}（支持：${allowed.join('/')}）`,
    )
  }
}
