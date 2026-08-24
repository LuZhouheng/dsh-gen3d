// 工具层公共设施 —— dsh-gen3d 工具层基础（provider 工厂 / cache-first /
// mock 回退 / 错误包装 / 工具定义类型）。
//
// 本文件提供：
// 1. 与 @deepseek-ai/dsh-tools 的 defineTool 形状一一对应的本地 DSL 类型
//    （参数 ParameterSchemaSpec / 输出 ValueSchemaSpec / render / billing 元
//    信息），插件装配层可直接把它们映射进 ctx.tools.register(defineTool(...))
//    （对照 docs/dsh-api.md §2；billing 为 dsh-gen3d 扩展字段，供审批 gate 展示）。
// 2. createProvider 工厂：按 ProviderId 返回配置好的 provider 实例（四家直连
//    实现风格统一：{ fetchImpl, pollIntervalMs, pollTimeoutMs, sleep } 依赖注入）。
// 3. cache-first 生成封装 generateCacheFirst：命中缓存返回既有资产，未命中才
//    调 provider，成功落盘后再写 cache（沿用 legacy server/generate.ts 语义）。
// 4. 确定性 mock 回退 mockProviderResult：provider 未配置 → mock 产物
//    （沿用 legacy shared/catalog.ts 的 generateMeshyTextMockResult）。
// 5. 错误包装：ToolError / ProviderError → { ok:false, code, message, retryable }。
//
// 约定：
// - 凭证只经 src/config.ts 读取（provider 实现内部各自读取；测试经
//   process.env 或工厂显式注入）；本文件不直接触碰 process.env；
// - 所有 HTTP 经依赖注入 fetchImpl，单测 mock fetch 不打真网；
// - 存储经注入的 Gen3dStore（测试用临时目录 workspaceRoot）。

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { readHunyuanSecretId, readHunyuanSecretKey, readProviderKey } from '../config.js';
import {
  generateMeshyTextMockResult,
  makeCacheKey,
  type MeshyTextMockArgs,
} from '../legacy/shared/catalog.js';
import type {
  AssetSlot,
  FileFormat,
  FileRole,
  GenerationMode,
  MotionRef,
  RigChain,
  SidecarDependency,
  SkeletonProfile,
} from '../legacy/shared/manifest.js';
import type { MergePlayableInput, MergePlayableResult } from '../legacy/server/merge-playable-character.js';
import { Hunyuan3dProvider, type Hunyuan3dProviderOptions } from '../providers/hunyuan3d.js';
import { MeshyProvider, type MeshyProviderDeps } from '../providers/meshy.js';
import type { MeshyTaskResult } from '../providers/meshy.js';
import { RodinProvider, type RodinProviderDeps } from '../providers/rodin.js';
import { TripoProvider, type TripoProviderDeps } from '../providers/tripo3d.js';
import {
  isProviderError,
  ProviderError,
  resolveFetchImpl,
  type FetchLike,
  type Gen3dProvider,
  type ProviderId,
  type TaskResult,
} from '../providers/types.js';
import { Gen3dStore, type Gen3dSidecar } from '../storage.js';

export type { Gen3dSidecar } from '../storage.js';

// ── 工具定义 DSL（与 @deepseek-ai/dsh-tools 一一对应，见 docs/dsh-api.md §2.2） ──

/**
 * DSH lossless JSON 值（与 @deepseek-ai/dsh-session 的 JsonValue 同构；
 * 装配层映射进官方 defineTool 时需要注解字段可赋值，见下）。
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** 全部 schema 节点共享的注解（非校验；default/examples 必须是 lossless JSON 数据，与官方 ValueSchemaAnnotations 一致）。 */
export interface SchemaAnnotations {
  description?: string;
  title?: string;
  default?: JsonValue;
  examples?: JsonValue;
}

/** 输出 / 参数值的 schema DSL 联合（与 dsh ValueSchemaSpec 同构）。 */
export type ValueSchemaSpec =
  | ({ type: 'string'; enum?: readonly string[]; const?: string } & SchemaAnnotations)
  | ({ type: 'number'; enum?: readonly number[]; const?: number } & SchemaAnnotations)
  | ({ type: 'integer'; enum?: readonly number[]; const?: number } & SchemaAnnotations)
  | ({ type: 'boolean'; enum?: readonly boolean[]; const?: boolean } & SchemaAnnotations)
  | ({ type: 'null'; enum?: readonly null[]; const?: null } & SchemaAnnotations)
  | ({ type: 'array'; items?: ValueSchemaSpec } & SchemaAnnotations)
  | ({
      type: 'object';
      properties?: ParameterSchemaSpec;
      /** 显式 object 必须声明：true 收额外键、false 不收。 */
      additionalProperties: boolean;
    } & SchemaAnnotations)
  | ({ type: 'json' } & SchemaAnnotations)
  | ({ oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]] } & SchemaAnnotations);

/** 逐属性参数声明：ValueSchemaSpec + 逐属性必填（dsh 语义：required 只能是 true）。 */
export type ParameterPropertySpec = ValueSchemaSpec & { required?: true };

/** 隐式开放对象根的逐属性映射（dsh ParameterSchemaSpec；symbol 键永不合法）。 */
export type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec;
  [key: symbol]: never;
};

/** DSH Native 内容块（本层只用 text）。 */
export type ContentBlock = { type: 'text'; text: string };

/** 工具执行上下文（DSH ToolRunContext 的最小投影；装配层传入完整对象）。 */
export interface ToolRunContext {
  signal: AbortSignal;
}

/** 结构化失败信封（业务失败用规范值表达，不抛错；DSH 契约见 docs/dsh-api.md §2.3）。 */
export interface ToolFailure {
  ok: false;
  code: string;
  message: string;
  retryable: boolean;
}

/** 工具定义（装配层映射进 ctx.tools.register(defineTool(...)) 的形状）。 */
export interface Gen3dToolDefinition {
  name: string;
  description: string;
  parameters: ParameterSchemaSpec;
  output: {
    schema: ValueSchemaSpec;
    render: (args: Record<string, unknown>, value: unknown) => ContentBlock[];
    /** 可重放的展示元数据（随 tool/result 持久化，供 web 自定义卡片摄取；可选）。 */
    presentationMeta?: (args: Record<string, unknown>, value: unknown) => Record<string, unknown>;
  };
  /** 计费元信息（供 pre-execute 审批 gate 展示预计消耗；mock 回退不消耗）。 */
  billing?: { credits: number; note?: string };
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<unknown>;
}

/** 工具实现声明：run 只返回成功规范值，抛 ToolError / ProviderError 自动转失败信封。 */
export interface Gen3dToolSpec<O extends object> {
  name: string;
  description: string;
  parameters: ParameterSchemaSpec;
  output: {
    schema: ValueSchemaSpec;
    render?: (args: Record<string, unknown>, value: O) => ContentBlock[];
    /** 展示元数据（可选；render 为 prose 的工具用它给自定义卡片递结构化数据）。 */
    presentationMeta?: (args: Record<string, unknown>, value: O) => Record<string, unknown>;
  };
  billing?: Gen3dToolDefinition['billing'];
  run: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<O>;
}

/**
 * 声明一个 gen3d 工具：包装 run 的错误处理（业务实现抛错 → 结构化失败信封），
 * 并对顶层必填参数做预检（与 dsh validateArgs 的 INVALID_ARGS 语义一致，
 * 装配层注册后 dsh 会再校验一次）。
 */
export function defineGen3dTool<O extends object>(spec: Gen3dToolSpec<O>): Gen3dToolDefinition {
  const requiredKeys = Object.entries(spec.parameters)
    .filter(([, p]) => p.required === true)
    .map(([k]) => k);
  const render = spec.output.render ?? renderJson;
  const execute = async (
    args: Record<string, unknown>,
    exec: ToolRunContext,
  ): Promise<O | ToolFailure> => {
    for (const key of requiredKeys) {
      if (args[key] === undefined || args[key] === null) {
        return { ok: false, code: 'invalid_args', message: `${spec.name}: 缺少必填参数 ${key}`, retryable: false };
      }
    }
    try {
      return await spec.run(args, exec);
    } catch (err) {
      return toToolFailure(err);
    }
  };
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: spec.output.schema,
      render: (args: Record<string, unknown>, value: unknown) => render(args, value as O),
      ...(spec.output.presentationMeta !== undefined
        ? {
            presentationMeta: (args: Record<string, unknown>, value: unknown) =>
              spec.output.presentationMeta!(args, value as O),
          }
        : {}),
    },
    ...(spec.billing !== undefined ? { billing: spec.billing } : {}),
    execute,
  };
}

/** 默认 render：规范值 JSON 投影为模型可见文本。 */
export function renderJson(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** 失败字段的属性声明（各工具 output.schema 里并入，保证失败信封可校验）。 */
export const FAILURE_PROPS: ParameterSchemaSpec = {
  ok: { type: 'boolean', description: '是否成功' },
  code: { type: 'string', description: '结构化错误码（provider_* 或工具层错误码）' },
  message: { type: 'string', description: '人类可读的错误说明' },
  retryable: { type: 'boolean', description: '是否可安全重试' },
};

/** 成功 + 失败共用的输出 schema 帮助函数。 */
export function resultSchema(properties: ParameterSchemaSpec): ValueSchemaSpec {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean', description: '是否成功' }, ...properties, ...FAILURE_PROPS },
    additionalProperties: true,
  };
}

// ── 错误 ────────────────────────────────────────────────────────────────────

/** 工具层业务错误（校验失败 / 状态不满足等；映射为结构化失败信封）。 */
export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** 任意 thrown 值 → 结构化失败信封。ProviderError 保留 provider_* 错误码。 */
export function toToolFailure(err: unknown): ToolFailure {
  if (err instanceof ToolError) {
    return { ok: false, code: err.code, message: err.message, retryable: err.retryable };
  }
  if (isProviderError(err)) {
    return { ok: false, code: err.code, message: err.message, retryable: err.retryable };
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return { ok: false, code: 'cancelled', message: '操作已取消', retryable: false };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, code: 'internal_error', message, retryable: false };
}

// ── 工具层依赖（可注入；单测用 fake provider / 临时目录 store） ───────────────

export interface ProviderFactoryDeps {
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ToolDeps extends ProviderFactoryDeps {
  /** 存储注入（默认 new Gen3dStore()：GEN3D_WORKSPACE_ROOT 或 cwd）。 */
  store?: Gen3dStore;
  /** provider 工厂注入（单测替换为 fake；缺省 createProvider 真实实现）。 */
  providerFactory?: (id: ProviderId, deps: ProviderFactoryDeps) => Promise<Gen3dProvider>;
  /** Hunyuan3D TokenHub key 显式注入（缺省 readProviderKey('hunyuan3d')）。 */
  hunyuan3dTokenHubKey?: string;
  /** Hunyuan3D 腾讯云 API 3.0 凭证显式注入（缺省 config.ts 四层读取）。 */
  hunyuan3dSecretId?: string;
  hunyuan3dSecretKey?: string;
  /** GLB 动作合并函数注入（单测替换 fake；缺省 legacy merge-playable-character）。 */
  mergePlayableCharacter?: (input: MergePlayableInput) => Promise<MergePlayableResult>;
}

let currentDeps: ToolDeps = {};

/** 注入 / 替换工具层依赖（插件装配层启动时调用；测试 per-file 配置）。 */
export function configureToolDeps(deps: ToolDeps): void {
  currentDeps = deps;
}

/** 当前依赖快照。 */
export function toolDeps(): ToolDeps {
  return currentDeps;
}

/** 解析存储实例（未注入则按 GEN3D_WORKSPACE_ROOT / cwd 新建）。 */
export function getStore(): Gen3dStore {
  return currentDeps.store ?? new Gen3dStore();
}

// ── provider 工厂 ───────────────────────────────────────────────────────────

/**
 * 按 ProviderId 返回配置好的 provider 实例。四家构造风格统一
 * （{ fetchImpl, pollIntervalMs, pollTimeoutMs, sleep } 依赖注入）：
 * meshy → MeshyProvider；hunyuan3d → Hunyuan3dProvider（TokenHub + TC3 双路径，
 * 凭证显式注入优先，缺省走 config.ts 四层读取）；tripo3d → TripoProvider；
 * rodin → RodinProvider。
 */
export async function createProvider(id: ProviderId, deps: ProviderFactoryDeps = {}): Promise<Gen3dProvider> {
  const shared: ProviderFactoryDeps = {
    fetchImpl: deps.fetchImpl,
    pollIntervalMs: deps.pollIntervalMs,
    pollTimeoutMs: deps.pollTimeoutMs,
    sleep: deps.sleep,
  };
  switch (id) {
    case 'meshy':
      return new MeshyProvider(shared as MeshyProviderDeps);
    case 'hunyuan3d': {
      const opts: Hunyuan3dProviderOptions = {
        fetchImpl: shared.fetchImpl,
        pollIntervalMs: shared.pollIntervalMs,
        pollTimeoutMs: shared.pollTimeoutMs,
        tokenHubApiKey: currentDeps.hunyuan3dTokenHubKey ?? readProviderKey('hunyuan3d'),
        tc3SecretId: currentDeps.hunyuan3dSecretId ?? readHunyuanSecretId(),
        tc3SecretKey: currentDeps.hunyuan3dSecretKey ?? readHunyuanSecretKey(),
      };
      return new Hunyuan3dProvider(opts);
    }
    case 'tripo3d':
      return new TripoProvider(shared as TripoProviderDeps);
    case 'rodin':
      return new RodinProvider(shared as RodinProviderDeps);
  }
}

/**
 * 解析 provider 或判定 mock 回退：provider 未配置（isConfigured() === false）
 * → 返回 { provider: null, usedMock: true }，调用方走确定性 mock；
 * 已配置 → 返回真实实例。工厂经 toolDeps().providerFactory 注入（测试替换）。
 */
export async function resolveProviderOrMock(
  id: ProviderId,
): Promise<{ provider: Gen3dProvider | null; usedMock: boolean }> {
  const deps = toolDeps();
  const factory = deps.providerFactory ?? createProvider;
  const provider = await factory(id, {
    fetchImpl: deps.fetchImpl,
    pollIntervalMs: deps.pollIntervalMs,
    pollTimeoutMs: deps.pollTimeoutMs,
    sleep: deps.sleep,
  });
  if (!provider.isConfigured()) return { provider: null, usedMock: true };
  return { provider, usedMock: false };
}

// ── 生成结果（ToolProviderResult）与 meshy 任务结果映射 ──────────────────────

/** 生成 / 精修产出的文件（角色 + 格式 + 字节），即落盘侧的 ProviderResult 形状。 */
export interface ToolProviderResultFile {
  role: FileRole;
  format: FileFormat;
  data: Uint8Array;
}

/** 与 legacy catalog.ProviderResult 同构的生成结果（mock / 真实 provider 统一形状）。 */
export interface ToolProviderResult {
  provider: ProviderId;
  mode: GenerationMode;
  providerMode: 'mock' | 'real';
  sourceJobId: string | null;
  prompt: string | null;
  files: ToolProviderResultFile[];
  /** Meshy 专属 preview/result 任务对（两阶段；手动 refine 用 previewTaskId）。 */
  meshyTaskRefs?: { previewTaskId: string | null; resultTaskId: string | null };
}

/** Meshy 文件格式 → legacy FileFormat（3mf 等 legacy 未收录的格式不落盘）。 */
const FILE_FORMAT_MAP: Record<string, FileFormat> = {
  glb: 'glb',
  fbx: 'fbx',
  obj: 'obj',
  mtl: 'mtl',
  usdz: 'usdz',
  stl: 'stl',
  png: 'png',
  jpg: 'jpg',
  webp: 'webp',
  mp4: 'mp4',
};

function toFileFormat(format: string): FileFormat {
  return FILE_FORMAT_MAP[format] ?? 'png';
}

export { toFileFormat };

/** Meshy 生成类任务的角色映射：glb → source_mesh；thumbnail → preview_image；贴图 → texture；其余（fbx/obj 等）沿用 legacy 只保留主 GLB + 预览 / 贴图（不落盘）。 */
export function meshyFilesToProviderFiles(result: MeshyTaskResult): ToolProviderResultFile[] {
  const out: ToolProviderResultFile[] = [];
  const textures = new Set(['base_color', 'metallic', 'normal', 'roughness', 'emission']);
  for (const f of result.files) {
    if (f.role === 'glb' && f.format === 'glb') {
      out.push({ role: 'source_mesh', format: 'glb', data: f.buffer });
    } else if (f.role === 'thumbnail' || f.role === 'alpha_thumbnail') {
      out.push({ role: 'preview_image', format: toFileFormat(f.format), data: f.buffer });
    } else if (textures.has(f.role)) {
      out.push({ role: 'texture', format: toFileFormat(f.format), data: f.buffer });
    }
  }
  return out;
}

/**
 * 契约级任务结果 → ToolProviderResult：provider 的 pollTask 只给 URL
 * （hunyuan3d / tripo3d / rodin 的 TaskDownloads），由本层用注入的
 * fetchImpl 立即下载字节（官方指引：查询成功后立即下载，签名 URL 有时效）。
 * 失败按 provider_empty_download / provider_http_error 抛错。
 */
export async function providerResultFromTask(
  providerId: ProviderId,
  mode: GenerationMode,
  sourceJobId: string,
  result: TaskResult,
  prompt: string | null,
): Promise<ToolProviderResult> {
  const fetchImpl = toolDeps().fetchImpl ?? resolveFetchImpl();
  const download = async (url: string): Promise<Uint8Array> => {
    const resp = await fetchImpl(url, { method: 'GET' });
    if (!resp.ok) {
      throw new ProviderError({
        code: 'provider_http_error',
        message: `资产下载失败 HTTP ${resp.status}（签名 URL 可能已过期）：${url}`,
        httpStatus: resp.status,
        retryable: false,
      });
    }
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.byteLength === 0) {
      throw new ProviderError({ code: 'provider_empty_download', message: `资产下载内容为空：${url}`, retryable: false });
    }
    return buf;
  };
  const d = result.downloads;
  const files: ToolProviderResultFile[] = [];
  if (d.glb) files.push({ role: 'source_mesh', format: 'glb', data: await download(d.glb) });
  if (d.fbx) files.push({ role: 'source_mesh', format: 'fbx', data: await download(d.fbx) });
  if (d.previewImage) files.push({ role: 'preview_image', format: 'png', data: await download(d.previewImage) });
  for (const url of d.textureUrls ?? []) {
    files.push({ role: 'texture', format: 'png', data: await download(url) });
  }
  if (!files.some((f) => f.role === 'source_mesh' && f.format === 'glb')) {
    throw new ProviderError({
      code: 'provider_empty_download',
      message: `${providerId} 任务成功但下载物中没有主 GLB（${sourceJobId}）`,
      retryable: false,
    });
  }
  return { provider: providerId, mode, providerMode: 'real', sourceJobId, prompt, files };
}

// ── 确定性 mock 回退（沿用 legacy shared/catalog.ts 的 mock 生成） ───────────

/**
 * provider 未配置时的确定性 mock 产物：与请求的 provider/mode 打标
 * （providerMode: 'mock'），字节沿用 generateMeshyTextMockResult。
 */
export function mockProviderResult(provider: ProviderId, mode: GenerationMode, prompt: string | null): ToolProviderResult {
  const { result } = generateMeshyTextMockResult({ prompt: prompt ?? mode } as MeshyTextMockArgs);
  return { ...result, provider, mode, sourceJobId: null };
}

/** 确定性占位模型字节（GLB magic 头 + 尾串）—— rig / motion / lowpoly 等 append 型 mock。 */
export function mockModelBytes(seed: string): Uint8Array {
  const header = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
  const tail = new TextEncoder().encode(`mock-model:${seed}`);
  const out = new Uint8Array(header.length + tail.length);
  out.set(header, 0);
  out.set(tail, header.length);
  return out;
}

// ── 文件名与落盘辅助 ─────────────────────────────────────────────────────────

/** sha256 hex（无前缀）。 */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 资产基底名清洗：去掉路径分隔 / 控制字符，保留中文与字母数字 .- ，截断 64。 */
export function sanitizeStem(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
  if (cleaned.length > 0) return cleaned;
  return sanitizeStem(fallback, 'asset');
}

/** 侧文件命名（沿用 legacy per-game-store）：preview → <stem>.<fmt>；texture → <stem>.texture.<fmt>；其余 → <stem>.<role>[.motion-<system>-<id>].<fmt>。 */
export function sideFileName(stem: string, role: FileRole, format: FileFormat, motionRef?: MotionRef): string {
  if (role === 'preview_image') return `${stem}.${format}`;
  if (role === 'texture') return `${stem}.texture.${format}`;
  const variant = motionRef ? `.motion-${motionRef.system}-${String(motionRef.id)}` : '';
  return `${stem}.${role}${variant}.${format}`;
}

/** 原子写侧文件（同目录 tmp + rename；失败清理 tmp）。 */
export async function writeAssetSideFile(store: Gen3dStore, slot: AssetSlot, fileName: string, data: Uint8Array): Promise<void> {
  const abs = join(store.assetDir(slot), fileName);
  await mkdir(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.tmp-${fileName}-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, data);
  try {
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

// ── cache-first 生成（沿用 legacy server/generate.ts 语义） ──────────────────

export interface GenerationCtx {
  provider: ProviderId;
  mode: GenerationMode;
  cacheKey: string;
  slot: AssetSlot;
  /** 资产基底名（不含扩展名；清洗后做文件名）。 */
  assetName: string;
  prompt: string | null;
  faceCount?: number;
  sourceInputAssetPaths?: string[];
  /** 显示名（userLabel）。 */
  userLabel?: string;
}

export interface GenerateResult {
  ok: true;
  cacheKey: string;
  cacheHit: boolean;
  usedMock: boolean;
  assetPath: string;
  manifest: Gen3dSidecar;
}

/**
 * cache-first 生成：
 * - 命中：返回既有 manifest（assetPath 指向的资产必须仍在，防悬空映射），
 *   不调 provider、不落盘，usedMock 取既有资产的 providerMode；
 * - 未命中：调 produce() 得 ToolProviderResult → 落盘（主 GLB + 侧文件 +
 *   sidecar）→ 全部成功后才写 cacheKey → assetPath（write-after-success）；
 * - tombstone / 指向已删资产：视为未命中，重新生成（不复活已删资产）。
 */
export async function generateCacheFirst(
  ctx: GenerationCtx,
  produce: () => Promise<ToolProviderResult>,
): Promise<GenerateResult> {
  const store = getStore();
  const hit = await store.getCacheEntry(ctx.cacheKey);
  if (hit !== null && hit.status === 'live' && hit.assetPath !== null && (await store.hasAsset(hit.assetPath))) {
    const sidecar = await store.readSidecar(hit.assetPath);
    if (sidecar !== null) {
      await store.appendAudit({
        ts: new Date().toISOString(),
        provider: sidecar.custom.provider,
        mode: sidecar.custom.mode,
        event: 'cache_hit',
        cacheKey: ctx.cacheKey,
        assetPath: hit.assetPath,
      });
      return {
        ok: true,
        cacheKey: ctx.cacheKey,
        cacheHit: true,
        usedMock: sidecar.custom.providerMode === 'mock',
        assetPath: hit.assetPath,
        manifest: sidecar,
      };
    }
    // 映射指向已删文件（无 tombstone）→ 落空重新生成
  }

  const result = await produce();
  const { assetPath, manifest } = await persistProviderResult(result, ctx);
  await store.putCache(ctx.cacheKey, assetPath);
  await store.appendAudit({
    ts: new Date().toISOString(),
    provider: result.provider,
    mode: result.mode,
    event: 'submit',
    sourceJobId: result.sourceJobId,
    assetPath,
    cacheKey: ctx.cacheKey,
  });
  return { ok: true, cacheKey: ctx.cacheKey, cacheHit: false, usedMock: result.providerMode === 'mock', assetPath, manifest };
}

/**
 * 生成结果落盘：先写侧文件（预览 / 贴图），再一次性落主 GLB + sidecar
 * （dependencies 齐备）。主文件 + sidecar 由存储层同一锁内原子写。
 */
export async function persistProviderResult(
  result: ToolProviderResult,
  ctx: GenerationCtx,
): Promise<{ assetPath: string; manifest: Gen3dSidecar }> {
  const store = getStore();
  const stem = sanitizeStem(ctx.assetName, `${ctx.mode}-${ctx.provider}`);
  const main = result.files.find((f) => f.role === 'source_mesh' && f.format === 'glb');
  if (!main) {
    throw new ToolError('empty_download', `${ctx.provider} ${ctx.mode} 结果缺少主 GLB（source_mesh/glb）`);
  }
  const dependencies: SidecarDependency[] = [];
  for (const f of result.files) {
    if (f === main) continue;
    if (f.role === 'source_mesh') continue; // 非 GLB 主模型（fbx 等）沿用 legacy 不落盘
    const fileName = sideFileName(stem, f.role, f.format);
    await writeAssetSideFile(store, ctx.slot, fileName, f.data);
    dependencies.push({ path: fileName, hash: `sha256:${sha256Hex(f.data)}`, kind: f.role });
  }
  const saved = await store.saveAsset({
    slot: ctx.slot,
    fileName: `${stem}.glb`,
    data: main.data,
    sidecar: {
      dependencies,
      custom: {
        provider: result.provider,
        providerMode: result.providerMode,
        mode: result.mode,
        sourceJobId: result.sourceJobId,
        prompt: result.prompt,
        sourceInputAssetPaths: ctx.sourceInputAssetPaths ?? [],
        ...(ctx.faceCount !== undefined ? { faceCount: ctx.faceCount } : {}),
        readiness: { hasSourceMesh: true, rigged: false, animated: false },
        ...(ctx.cacheKey ? { cacheKey: ctx.cacheKey } : {}),
        ...(ctx.userLabel !== undefined && ctx.userLabel !== null ? { userLabel: ctx.userLabel } : {}),
        ...(result.meshyTaskRefs ? { meshyTaskRefs: result.meshyTaskRefs } : {}),
      },
    },
  });
  return { assetPath: saved.assetPath, manifest: saved.sidecar };
}

// ── 派生文件追加（auto-rig / apply-motion 用） ──────────────────────────────

/** DSH 版 rig 链：rigProvider 用新契约 ProviderId（legacy RigChain 类型仅收
 *  'meshy' | 'hunyuan_rest'，写入时经本类型收窄；存储层按 JSON 原样落盘）。 */
export type DshRigChain = Omit<RigChain, 'rigProvider'> & { rigProvider: ProviderId };

export interface AppendDerivedFileInput {
  role: 'rigged_model' | 'animated_model';
  format: FileFormat;
  data: Uint8Array;
  motionRef?: MotionRef;
}

export interface AppendDerivedCtx {
  assetPath: string;
  files: AppendDerivedFileInput[];
  /** 骨架元数据（绑骨产物必带；套动作不带）。 */
  skeleton?: { hasSkeleton: boolean; skeletonProfile: SkeletonProfile; animationInputReady: boolean };
  rigChain?: DshRigChain;
}

/**
 * 向既有资产追加派生文件（rigged_model / animated_model GLB+FBX）：
 * 写侧文件 + read-modify-write sidecar（dependencies 追加、readiness 翻转、
 * rig 链写入）。同资产串行由存储层 per-asset 锁保证。
 */
export async function appendDerivedFiles(ctx: AppendDerivedCtx): Promise<Gen3dSidecar> {
  const store = getStore();
  const sidecar = await store.readSidecar(ctx.assetPath);
  if (sidecar === null) {
    throw new ToolError('asset_not_found', `资产不存在：${ctx.assetPath}`);
  }
  const stem = sanitizeStem(ctx.assetPath.split('/').pop()?.replace(/\.glb$/i, '') ?? '', 'asset');
  const byPath = new Map(sidecar.dependencies.map((d) => [d.path, d]));
  for (const f of ctx.files) {
    const fileName = sideFileName(stem, f.role, f.format, f.motionRef);
    await writeAssetSideFile(store, sidecar.custom.assetSlot, fileName, f.data);
    const dep: SidecarDependency = { path: fileName, hash: `sha256:${sha256Hex(f.data)}`, kind: f.role };
    if (f.role === 'rigged_model' && ctx.skeleton) {
      dep.hasSkeleton = ctx.skeleton.hasSkeleton;
      dep.skeletonProfile = ctx.skeleton.skeletonProfile;
      dep.animationInputReady = ctx.skeleton.animationInputReady;
    }
    if (f.motionRef) dep.motionRef = f.motionRef;
    byPath.set(fileName, dep);
  }
  const appended = ctx.files;
  return store.updateSidecar(ctx.assetPath, (s) => {
    const readiness = { ...s.custom.readiness };
    if (appended.some((f) => f.role === 'rigged_model')) readiness.rigged = true;
    if (appended.some((f) => f.role === 'animated_model')) readiness.animated = true;
    return {
      ...s,
      dependencies: [...byPath.values()],
      custom: {
        ...s.custom,
        readiness,
        // rigProvider 为 DSH 新契约 ProviderId（legacy RigChain 类型仅收 'meshy'|'hunyuan_rest'，
        // 存储层按 JSON 原样落盘；读取侧统一按 string 判读）
        ...(ctx.rigChain ? { rig: ctx.rigChain as unknown as RigChain } : {}),
      },
    };
  });
}

/**
 * 清除既有绑骨与动作（force 重绑前）：删除 rigged_model / animated_model
 * 侧文件与 sidecar 记录，readiness.rigged/animated 置 false、rig 链清除。
 * 源网格 / 预览 / 贴图保留，主 GLB 身份不变。
 */
export async function clearRigAndMotions(assetPath: string): Promise<Gen3dSidecar> {
  const store = getStore();
  const sidecar = await store.readSidecar(assetPath);
  if (sidecar === null) {
    throw new ToolError('asset_not_found', `资产不存在：${assetPath}`);
  }
  const removed = sidecar.dependencies.filter((d) => d.kind === 'rigged_model' || d.kind === 'animated_model');
  for (const d of removed) {
    await rm(join(store.assetDir(sidecar.custom.assetSlot), d.path), { force: true });
  }
  return store.updateSidecar(assetPath, (s) => {
    const kept = s.dependencies.filter((d) => d.kind !== 'rigged_model' && d.kind !== 'animated_model');
    const custom = { ...s.custom, readiness: { ...s.custom.readiness, rigged: false, animated: false } };
    delete custom.rig;
    return { ...s, dependencies: kept, custom };
  });
}
