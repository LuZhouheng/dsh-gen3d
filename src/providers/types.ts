// 供应商公共契约 —— dsh-gen3d 所有 provider 实现（Meshy / 腾讯混元 3D /
// Tripo3D / Rodin）的统一接口与数据类型。
//
// 约定：
// - 各 provider 实现与工具层一律 import 本文件，禁止依赖供应商私有类型；
// - 所有 HTTP 必须经依赖注入的 fetchImpl（默认原生 fetch），单测 mock fetch
//   即可，绝不打真网；
// - 凭证不在此层读取：provider 通过 src/config.ts 的 readProviderKey() 拿 key，
//   本文件不含任何密钥语义。
//
// 各供应商私有请求字段（如 meshy 的 ai_model、混元的 enable_pbr）统一走
// `providerOptions` 透传，公共契约保持稳定。

// ── 基础标识 ──────────────────────────────────────────────────────────────

/** 四家直连供应商。 */
export type ProviderId = 'meshy' | 'hunyuan3d' | 'tripo3d' | 'rodin';

/** 生成模式：文生 3D / 图生 3D / 多视图生 3D。 */
export type GenMode = 'text' | 'image' | 'views';

// ── 任务句柄与结果 ─────────────────────────────────────────────────────────

/** 提交生成后立即返回的任务句柄，供 pollTask 轮询。 */
export interface TaskHandle {
  provider: ProviderId;
  /** 供应商侧任务 id（官方 API 的 job/task id）。 */
  taskId: string;
}

/** 下载物清单。URL 形式由供应商官方协议给出，下载为字节由 provider 实现负责。 */
export interface TaskDownloads {
  /** 主模型（通常 GLB）。 */
  glb?: string;
  /** 可选 FBX。 */
  fbx?: string;
  /** 贴图 URL 列表。 */
  textureUrls?: string[];
  /** 预览图。 */
  previewImage?: string;
}

/** 轮询结果。`pending` 表示尚未终态应继续轮询；`succeeded` / `failed` 为终态。 */
export interface TaskResult {
  status: 'pending' | 'succeeded' | 'failed';
  downloads: TaskDownloads;
  /** 失败时的错误码（provider_* 系列）。 */
  errorCode?: ProviderErrorCode;
  errorMessage?: string;
  /** 供应商原始响应（审计 / 排障用）。**不得包含任何可打印的密钥**。 */
  raw?: unknown;
}

// ── 请求形状（公共子集，私有参数走 providerOptions 透传） ───────────────────

/** 生成提交请求。 */
export interface GenerationRequest {
  mode: GenMode;
  prompt: string;
  /** 图生 / 多视图的参考图 URL（image 通常单张，views 可多张）。 */
  imageUrls?: string[];
  seed?: number;
  negativePrompt?: string;
  /** 供应商私有透传参数，按各官方协议填写。 */
  providerOptions?: Record<string, unknown>;
}

/** 绑骨请求（可选能力 submitRig）。 */
export interface RigRequest {
  /** 待绑骨模型的 URL（如 Meshy refine 结果）。 */
  assetUrl: string;
  /** 骨架类型（如 Meshy style_01）。 */
  skeletonType?: string;
  providerOptions?: Record<string, unknown>;
}

/** 套动作请求（可选能力 submitAnimation）。 */
export interface AnimationRequest {
  /** 供应商侧绑骨任务 id（apply-motion 幂等键的组成部分）。 */
  rigTaskId: string;
  /** 供应商侧动作 id（如 Meshy action id）。 */
  actionId: string | number;
  label?: string;
  providerOptions?: Record<string, unknown>;
}

/** 动作目录条目（可选能力 listMotions）。 */
export interface MotionItem {
  id: string | number;
  label: string;
  category?: string;
  /** 兼容的骨架类型（宽松匹配由工具层做）。 */
  rigType?: string;
  isFree?: boolean;
  previewUrl?: string;
}

/** 动作目录查询收窄条件（可选能力 listMotions）。 */
export interface MotionQuery {
  query?: string;
  category?: string;
  rigType?: string;
}

/** 余额查询结果（可选能力 getBalance）。数值含义以各官方协议为准。 */
export interface BalanceInfo {
  balance?: number | string;
  currency?: string;
  /** 供应商原始响应。 */
  raw?: unknown;
}

// ── 错误码与 ProviderError ─────────────────────────────────────────────────

/** 全部 provider_* 错误码（公共约定，工具层按此映射结构化结果）。 */
export const PROVIDER_ERROR_CODES = [
  'provider_bad_request',
  'provider_unauthorized',
  'provider_insufficient_credits',
  'provider_rate_limited',
  'provider_queue_full',
  'provider_timeout',
  'provider_http_error',
  'provider_empty_download',
  'provider_not_configured',
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** 各类错误码默认是否可安全重试（限流 / 超时 / 5xx 类可重试）。 */
const DEFAULT_RETRYABLE: Readonly<Record<ProviderErrorCode, boolean>> = {
  provider_bad_request: false,
  provider_unauthorized: false,
  provider_insufficient_credits: false,
  provider_rate_limited: true,
  provider_queue_full: true,
  provider_timeout: true,
  provider_http_error: true,
  provider_empty_download: false,
  provider_not_configured: false,
};

export interface ProviderErrorOptions {
  code: ProviderErrorCode;
  message?: string;
  /** 供应商 HTTP 状态码（非 HTTP 错误可为空）。 */
  httpStatus?: number;
  /** 显式指定是否可重试；缺省按错误码默认值（http_error 且 5xx 视为可重试）。 */
  retryable?: boolean;
  cause?: unknown;
}

/**
 * provider 层统一错误。工具层 catch 后映射为 TaskResult / 结构化结果。
 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly httpStatus?: number;
  readonly retryable: boolean;

  constructor(options: ProviderErrorOptions) {
    super(options.message ?? options.code, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProviderError';
    this.code = options.code;
    this.httpStatus = options.httpStatus;
    // http_error：有状态码时按 5xx / 429 判定；无状态码按默认（可重试）
    const status = options.httpStatus;
    this.retryable =
      options.retryable ??
      (options.code === 'provider_http_error' && status !== undefined
        ? status >= 500 || status === 429
        : DEFAULT_RETRYABLE[options.code]);
  }
}

/** 类型守卫：判断任意 thrown 值是否为 ProviderError。 */
export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

// ── fetch 依赖注入 ─────────────────────────────────────────────────────────

/** 依赖注入的 fetch 形状（与原生 fetch 兼容，便于 mock）。 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * 解析实际使用的 fetch 实现：优先注入值，否则原生全局 fetch。
 * 两者皆无（极简运行时）时显式抛错，避免运行时才炸。
 */
export function resolveFetchImpl(injected?: FetchLike): FetchLike {
  if (injected !== undefined) return injected;
  const native = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof native === 'function') return native.bind(globalThis);
  throw new ProviderError({
    code: 'provider_not_configured',
    message: '当前环境没有全局 fetch，请在构造 provider 时注入 fetchImpl',
  });
}

// ── Gen3dProvider 接口 ─────────────────────────────────────────────────────

/** 提交 / 轮询的公共选项（转发调用方取消信号）。 */
export interface SubmitOptions {
  signal?: AbortSignal;
}

/**
 * 供应商统一接口。可选方法（submitRig 等）未实现时按能力缺失处理，
 * 工具层通过 `'submitRig' in provider` 探测。
 */
export interface Gen3dProvider {
  readonly id: ProviderId;

  /** 凭证是否已配置；未配置时上层回退确定性 mock。 */
  isConfigured(): boolean;

  /** 提交生成任务（text / image / views 统一入口）。 */
  submitGeneration(req: GenerationRequest, opts?: SubmitOptions): Promise<TaskHandle>;

  /** 轮询任务；返回 pending 需继续轮询，succeeded / failed 为终态。 */
  pollTask(handle: TaskHandle, opts?: SubmitOptions): Promise<TaskResult>;

  /** 自动绑骨（可选能力）。 */
  submitRig?(req: RigRequest, opts?: SubmitOptions): Promise<TaskHandle>;

  /** 套动作（可选能力）。 */
  submitAnimation?(req: AnimationRequest, opts?: SubmitOptions): Promise<TaskHandle>;

  /** 动作目录（可选能力）。 */
  listMotions?(query?: MotionQuery): Promise<MotionItem[]>;

  /** 余额查询（可选能力）。 */
  getBalance?(): Promise<BalanceInfo>;
}
