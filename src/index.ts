// DSH 插件入口 —— dsh-gen3d 装配层。
//
// 职责（对照 docs/dsh-api.md 的权威结论，§2/§3/§5/§6）：
// 1. 把 src/tools/ 的 21 个本地镜像定义映射为官方 ctx.tools.register(defineTool(...))。
//    映射逐字段对齐官方 DSL（参数节点 9 种 / required 逐属性 / output.schema+render /
//    execute(args, exec)）；defineTool 在注册期即编译 parameters/output.schema，
//    任何镜像与官方不一致都会在装配期抛错（镜像修正见 src/tools/common.ts 头注）。
// 2. tools/pre-execute 审批 gate：工具名命中 billingToolNames 且本次调用将走真实
//    provider（非确定性 mock）时返回 { kind: 'ask', reason }（reason 写明供应商与
//    预估 credits）；mock 回退直接 next() 放行。判定以工具自身相同的解析逻辑为准
//    （provider 参数 / 配置状态 / apply_motion 的 rig 来源），无法确定时按“调用
//    方校验必然失败、不可能计费”放行（真正的计费风险面是 provider 已配置）。
// 3. 长任务（生成 / 绑骨 / 套动作 = billingToolNames 全 7 个）经 ctx.jobs.start
//    后台化，execute 返回 { kind: 'background', jobId } 结构化句柄；output.schema
//    注入后台句柄分支（kind const 'background' + jobId），render 对两种形状分支。
//    任务级取消信号与调用方 signal 解耦（外层取消只停止等待，不杀已发布任务）。
// 4. 随包 skill（skills/ 目录下每个含 SKILL.md 的子目录）经 ctx.skills.registerProvider
//    注册（官方 skill-badge 模式；路径在插件模块内用 import.meta.url 解析——patch 的
//    !!js 求值环境没有 import.meta.url，见 dsh-api.md §6.3）。
// 5. web 组合的 webServer 路由（可选：headless 无此服务不注册）：资产清单 API 与
//    工作区预览/资产只读文件服务（/plugins/dsh-gen3d/api/assets、/plugins/dsh-gen3d/files/*）。
//
// 凭证走 src/config.ts 四层读取（env > $DSH_HOME/.credentials.yaml > .env），
// 插件零内置 key；inject 声明 tools / credentials / skills / jobs / attachments
// （tools / credentials / skills / attachments 由 dsh-base 恒提供，jobs 由
// dsh-jobs-local 提供）。

import { readFile, readdir } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { PreToolDecision, ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { JobOutcome } from '@deepseek-ai/dsh-jobs';
import {
  BUNDLED_SKILL_RANK,
  type SkillCandidate,
  type SkillDefinition,
  type SkillProvider,
} from '@deepseek-ai/dsh-skill';

import { isProviderConfigured, readHunyuanSecretId, readHunyuanSecretKey } from './config.js';
import type { ProviderId } from './providers/types.js';
import { installGen3dSettingsSection } from './settings.js';
import { allGen3dTools, billingToolNames } from './tools/index.js';
import type { ContentBlock, Gen3dToolDefinition, ParameterSchemaSpec, ValueSchemaSpec } from './tools/common.js';
import { getStore } from './tools/common.js';
import { setPreviewAttachmentStore, type ImageAttachmentRefLike } from './tools/preview.js';

// 声明合并：把 gen3d 任务种类挂进官方 JobKindMap（挂包根模块名，无 ./types
// 子路径；dsh-api.md §5.2）。
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    gen3d: 'gen3d';
  }
}

/** Cordis 插件名（patch 行 name: 'dsh-gen3d' 对应）。 */
export const name = 'dsh-gen3d';

/**
 * 需要宿主提供的服务：tools / credentials / skills / attachments 由 dsh-base
 * 恒提供，jobs 由 dsh-jobs-local 提供（实测可用名单见 dsh-api.md §7.1 / §8.2；
 * 长任务经 ctx.jobs.start 后台化，必须列入 inject，否则 Cordis 注入守卫抛错；
 * attachments 供 gen3d_render_preview 保存图片块）。webServer 不进 inject
 * （headless 无此服务；有则注册路由，没有就静默跳过）。
 */
export const inject = ['tools', 'credentials', 'skills', 'jobs', 'attachments'];

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 供应商展示名（与 src/tools/generation.ts 的 PROVIDER_NAMES 同一口径，仅用于审批 reason）。 */
const PROVIDER_DISPLAY: Record<ProviderId, string> = {
  meshy: 'Meshy',
  hunyuan3d: 'Hunyuan3D',
  tripo3d: 'Tripo3D',
  rodin: 'Rodin',
};

const PROVIDER_LIST: readonly ProviderId[] = ['meshy', 'hunyuan3d', 'tripo3d', 'rodin'];
const RIG_PRIORITY: readonly ProviderId[] = ['meshy', 'hunyuan3d', 'tripo3d'];

/**
 * 长任务工具名集合：生成 / 绑骨 / 套动作类（text/image/views_to_3d、refine、
 * retopo、auto_rig、apply_motion）——与 billingToolNames 完全一致（计费名单
 * 即 provider 长任务名单）。经 ctx.jobs.start 后台化。
 */
const LONG_TASK_TOOL_NAMES: ReadonlySet<string> = new Set(billingToolNames);

const billingByName: ReadonlyMap<string, Gen3dToolDefinition> = new Map(allGen3dTools.map((t) => [t.name, t]));

// ── 工具定义映射（本地镜像 → 官方 defineTool） ───────────────────────────────

/** 后台任务句柄的 schema 属性（注入长任务工具 output.schema：kind 精确 const）。 */
const BACKGROUND_HANDLE_PROPS: ParameterSchemaSpec = {
  kind: { type: 'string', const: 'background', description: '后台任务句柄标记' },
  jobId: { type: 'string', description: '后台任务 id（gen3d-N）；可用 job_output 查询进度 / job_kill 终止' },
};

function isBackgroundHandle(value: unknown): value is { kind: 'background'; jobId: string } {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'background';
}

/**
 * 长任务 output.schema 注入后台句柄分支：原 schema 保持开放（additionalProperties
 * 不变），只并入 kind/jobId 两个声明属性——后台句柄与完整结果都落在同一对象节点，
 * 避免 oneOf「精确一选一」下开放对象同时命中两支的校验冲突。
 */
function withBackgroundHandle(schema: ValueSchemaSpec): ValueSchemaSpec {
  // oneOf 分支没有 type 键，先收窄再取字段
  if (!('type' in schema) || schema.type !== 'object' || schema.properties === undefined) {
    return schema; // 理论不可达：全部 resultSchema
  }
  return {
    type: 'object',
    properties: { ...BACKGROUND_HANDLE_PROPS, ...schema.properties },
    additionalProperties: schema.additionalProperties,
  };
}

/** 长任务 render：后台句柄输出引导文本，完整结果委托原 render（纯函数）。 */
function renderBackgroundAware(
  render: Gen3dToolDefinition['output']['render'],
): (args: Record<string, unknown>, value: unknown) => ContentBlock[] {
  return (args, value) => {
    if (isBackgroundHandle(value)) {
      return [
        {
          type: 'text',
          text: `任务已在后台运行：jobId=${value.jobId}。可用 job_output 查询进度、job_kill 终止；完成后返回完整结果。`,
        },
      ];
    }
    return render(args, value);
  };
}

function jobLabel(toolName: string, args: Record<string, unknown>): string {
  const brief = JSON.stringify(args);
  return brief !== undefined && brief.length > 120
    ? `${toolName} ${brief.slice(0, 117)}…`
    : `${toolName} ${brief ?? ''}`;
}

/**
 * 长任务 execute 包装：把底层工具执行放进 ctx.jobs.start 的 gen3d 任务，
 * 立即返回 { kind: 'background', jobId }。任务级 AbortController 独立于调用方
 * signal（dsh-api.md §5.4：外层取消只停止等待，不杀已发布工作）；job_kill /
 * owner 销毁 / 服务 teardown 经 cancel 中止底层 provider 轮询。
 */
function backgroundExecute(
  def: Gen3dToolDefinition,
  ctx: Context,
): (args: Record<string, unknown>, exec: ToolRunContext) => Promise<unknown> {
  return async (args, exec) => {
    const ac = new AbortController();
    let lastOutput = '';
    let settle!: (outcome: JobOutcome) => void;
    const done: Promise<JobOutcome> = new Promise((resolve) => {
      settle = resolve;
    });
    const jobId = ctx.jobs.start({
      kind: 'gen3d',
      label: jobLabel(def.name, args),
      owner: exec.agent,
      run: () => {
        // 任务信号只随任务级取消（cancel 幂等、同步）
        void (async () => {
          try {
            const value = await def.execute(args, { signal: ac.signal });
            const output = JSON.stringify(value);
            lastOutput = output;
            settle({ status: 'completed', output });
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            lastOutput = detail;
            settle({ status: 'failed', detail });
          }
        })();
        return {
          cancel: (reason?: string) => ac.abort(reason),
          done,
          readOutput: () => {
            const out = lastOutput;
            lastOutput = '';
            return out;
          },
        };
      },
    });
    return { kind: 'background', jobId };
  };
}

/** 装配层映射后的选项形状（官方 DSL 字段的宽松声明；defineTool 侧再做类型桥接）。 */
interface MappedToolOptions {
  name: string;
  description: string;
  parameters: ParameterSchemaSpec;
  output: {
    schema: ValueSchemaSpec;
    render: (args: Record<string, unknown>, value: unknown) => ContentBlock[];
    presentationMeta?: (args: Record<string, unknown>, value: unknown) => Record<string, unknown>;
  };
  /** 软渲染 / 编码无合作中断点，给足预算（见下方 TOOL_TIMEOUT_MS）。 */
  timeoutMs?: number;
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<unknown>;
}

/** 需要合作超时预算的工具（本地镜像 DSL 无 timeoutMs 字段，装配层按名注入）。 */
const TOOL_TIMEOUT_MS: Readonly<Record<string, number>> = {
  gen3d_render_preview: 180_000,
};

/**
 * 本地镜像定义 → 官方 defineTool 选项。逐字段映射：
 * name / description / parameters（编译为隐式开放对象根）/ output.schema /
 * output.render / execute(args, exec)；长任务额外：output.schema 并入后台句柄
 * 分支、render 分支、execute 换 jobs 后台化包装；TOOL_TIMEOUT_MS 命中的工具
 * 注入 timeoutMs（合作超时预算）。presentCall/presentResult/finalizeContent/
 * isConcurrencySafe 本地镜像未声明，不注入（走通用卡片回退，见 dsh-api.md §2.5）；
 * presentationMeta 仅 preview / inspect 两个 prose-render 工具声明（给 web
 * 自定义卡片递结构化数据），按声明透传。
 *
 * 桥接说明：镜像 schema 是宽联合类型别名，官方 defineTool 的 InferArgs/InferValue
 * 推导在宽联合上递归退化（never / TS2321），无法直接实例化泛型；在调用点做一次
 * 类型桥接（options 形状已逐字段对齐官方 DSL，且 defineTool 注册期会编译并强制
 * parameters/output.schema——任何镜像与官方不一致都会在装配期抛错）。
 */
function toToolDefinition(def: Gen3dToolDefinition, ctx: Context): ToolDefinition {
  const background = LONG_TASK_TOOL_NAMES.has(def.name);
  const timeoutMs = TOOL_TIMEOUT_MS[def.name];
  const options: MappedToolOptions = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: {
      schema: background ? withBackgroundHandle(def.output.schema) : def.output.schema,
      render: background ? renderBackgroundAware(def.output.render) : def.output.render,
      ...(def.output.presentationMeta !== undefined
        ? { presentationMeta: def.output.presentationMeta }
        : {}),
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    execute: background ? backgroundExecute(def, ctx) : def.execute,
  };
  return defineTool(options as never);
}

// ── 计费审批 gate（tools/pre-execute） ───────────────────────────────────────

function asArgs(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function providerFromArg(raw: unknown, fallback: ProviderId): ProviderId | null {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'string' && (PROVIDER_LIST as readonly string[]).includes(raw)) return raw as ProviderId;
  return null; // 非法值：工具自身校验必然失败，不可能触达 provider
}

/** 供应商是否已配置（与各 provider 的 isConfigured 同口径；Hunyuan3D 双路径）。 */
function providerConfigured(id: ProviderId): boolean {
  if (id === 'hunyuan3d') {
    // 与 Hunyuan3dProvider 构造一致：TokenHub key 或 TC3 密钥对任一路径可用
    const hasTokenHub = isProviderConfigured('hunyuan3d');
    const hasTc3Pair = readHunyuanSecretId() !== undefined && readHunyuanSecretKey() !== undefined;
    return hasTokenHub || hasTc3Pair;
  }
  return isProviderConfigured(id);
}

function firstConfigured(order: readonly ProviderId[]): ProviderId | null {
  for (const id of order) {
    if (providerConfigured(id)) return id;
  }
  return null;
}

/**
 * 预判本次调用是否走真实 provider：
 * - 返回 ProviderId：该供应商已配置 key，调用将消耗配额（应 ask）；
 * - 返回 null：确定性 mock 回退 / 参数非法（工具自身校验必败，不可能计费），
 *   应直接放行。判定逻辑与各工具 run 内 resolveProviderOrMock 的解析一致。
 */
async function willUseRealProvider(toolName: string, args: Record<string, unknown>): Promise<ProviderId | null> {
  let provider: ProviderId | null;
  switch (toolName) {
    case 'gen3d_text_to_3d':
    case 'gen3d_image_to_3d':
    case 'gen3d_views_to_3d':
      provider = providerFromArg(args.provider, 'meshy');
      break;
    case 'gen3d_refine_mesh':
      provider = 'meshy';
      break;
    case 'gen3d_retopo_lowpoly':
      provider = providerFromArg(args.provider, 'hunyuan3d');
      break;
    case 'gen3d_auto_rig': {
      const route = args.rigProvider;
      if (route === undefined || route === null || route === 'auto') {
        provider = firstConfigured(RIG_PRIORITY); // auto：按工具同款优先级取第一个已配置
      } else if (typeof route === 'string' && (RIG_PRIORITY as readonly string[]).includes(route)) {
        provider = route as ProviderId;
      } else {
        provider = null; // 非法路由：工具校验必败
      }
      break;
    }
    case 'gen3d_apply_motion': {
      // 实际 provider 由资产 sidecar 的 rig 来源决定（与工具内分发一致）；
      // storage 按 JSON 原样落盘，rigProvider 运行时按 string 判读
      const assetPath = typeof args.assetPath === 'string' ? args.assetPath : '';
      const sidecar = assetPath !== '' ? await getStore().readSidecar(assetPath) : null;
      if (sidecar === null) {
        provider = null; // 资产不存在：工具先报 asset_not_found，不可能计费
        break;
      }
      const rigProvider = sidecar.custom.rig?.rigProvider as string | undefined;
      if (rigProvider === 'tripo3d') provider = 'tripo3d';
      else if (rigProvider === 'hunyuan3d' || rigProvider === 'hunyuan_rest') provider = 'hunyuan3d';
      else provider = 'meshy';
      break;
    }
    default:
      provider = null; // 理论不可达：gate 只对 billingToolNames 名单触发
  }
  if (provider === null) return null;
  return providerConfigured(provider) ? provider : null;
}

/** 计费审批 gate：命中 billing 名单且将走真实 provider → ask（reason 含供应商与预估 credits）；其余 next()。 */
async function billingGate(exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> {
  if (!billingToolNames.includes(exec.name)) return next();
  const provider = await willUseRealProvider(exec.name, asArgs(exec.arguments));
  if (provider === null) return next(); // 确定性 mock / 参数非法：直接放行
  const credits = billingByName.get(exec.name)?.billing?.credits ?? 0;
  return {
    kind: 'ask',
    reason: `${exec.name} 将调用 ${PROVIDER_DISPLAY[provider]} 官方 API（预估约 ${credits} credits，实际消耗以官方计费为准），请确认后继续。`,
  };
}

// ── 随包 skill provider（官方 skill-badge 模式，dsh-api.md §6.3） ─────────────

const SKILLS_DIR_URL = new URL('../skills/', import.meta.url);
const SKILL_INVOCATION = { modelInvocable: true, userInvocable: true } as const;

/** frontmatter 子集解析（name / description；发现摘要与正文同源，杜绝漂移）。 */
function parseFrontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return { name: out.name, description: out.description };
}

/** 包内扫描：skills/ 下每个含 SKILL.md 的子目录 = 一个候选（返回目录名列表）。 */
export async function scanSkillDirs(dirUrl: URL): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dirUrl, { withFileTypes: true });
  } catch {
    return []; // 目录缺失（打包问题）：无候选，注册表不受影响
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(new URL(`${entry.name}/SKILL.md`, dirUrl), 'utf8');
      dirs.push(entry.name);
    } catch {
      // 子目录里没有 SKILL.md：不是技能，跳过
    }
  }
  return dirs.sort();
}

/** skills/ 下的一个技能目录（locator 用目录名，与 get 的路径推导一致）。 */
export interface BundledSkillDir {
  dirName: string;
  dirUrl: URL;
  bodyUrl: URL;
}

async function listBundledSkillDirs(): Promise<BundledSkillDir[]> {
  const dirs = await scanSkillDirs(SKILLS_DIR_URL);
  return dirs.map((dirName) => ({
    dirName,
    dirUrl: new URL(`${dirName}/`, SKILLS_DIR_URL),
    bodyUrl: new URL(`${dirName}/SKILL.md`, SKILLS_DIR_URL),
  }));
}

/** 包内 skills/ 各子目录的自注册 provider（get 返回对应目录的完整正文）。 */
export const gen3dSkillProvider: SkillProvider = {
  name: 'gen3d',
  async list(): Promise<readonly SkillCandidate[]> {
    const dirs = await listBundledSkillDirs();
    const candidates: SkillCandidate[] = [];
    for (const dir of dirs) {
      let meta: { name?: string; description?: string };
      try {
        meta = parseFrontmatter(await readFile(dir.bodyUrl, 'utf8'));
      } catch {
        continue; // 目录刚被删掉（并发）：跳过该候选
      }
      candidates.push({
        name: meta.name ?? dir.dirName,
        description:
          meta.description ?? '生成一个游戏可用的 3D 角色资产（文生 / 图生 / 多视图 + 绑骨 / 动作）。',
        invocation: SKILL_INVOCATION,
        provider: 'gen3d',
        source: 'bundled',
        resourceBase: { kind: 'directory', path: fileURLToPath(dir.dirUrl) },
        rank: BUNDLED_SKILL_RANK,
        locator: dir.dirName,
      });
    }
    return candidates;
  },
  async get(candidate: SkillCandidate): Promise<SkillDefinition> {
    const dirName = String(candidate.locator);
    const bodyUrl = new URL(`${dirName}/SKILL.md`, SKILLS_DIR_URL);
    return {
      name: candidate.name,
      description: candidate.description,
      invocation: candidate.invocation,
      provider: candidate.provider,
      source: candidate.source,
      resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`${dirName}/`, SKILLS_DIR_URL)) },
      content: await readFile(bodyUrl, 'utf8'),
    };
  },
};

// ── webServer 可选路由（web 组合才有；headless 无此服务静默跳过） ──────────────

import type { IncomingMessage, ServerResponse } from 'node:http';

/** dsh-host-webserver 的 WebRoute 结构投影（该包不在本插件依赖内，按形状声明）。 */
interface WebServerRouteLike {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

interface WebServerLike {
  register(route: WebServerRouteLike): () => void;
}

/** 路径分段白名单校验（与存储层 safeFileName 同语义：拒绝分隔符 / .. / NUL）。 */
function safePathSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  );
}

const FILE_CONTENT_TYPES: Record<string, string> = {
  glb: 'model/gltf-binary',
  png: 'image/png',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(text);
}

/** GET /plugins/dsh-gen3d/api/assets：工作区资产清单。 */
async function handleApiAssets(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const store = getStore();
  const assets = await store.listAssets();
  // 已存在的预览文件名（按 <stem>-* 前缀归组）
  let previewNames: string[] = [];
  try {
    previewNames = (await readdir(join(store.workspaceRoot, '.dsh-gen3d', 'previews'))).sort();
  } catch {
    previewNames = []; // 还没有任何预览
  }
  const list = assets.map((a) => {
    const stem = basename(a.assetPath).replace(/\.glb$/i, '');
    const previews = previewNames.filter((n) => n.startsWith(`${stem}-`));
    return {
      assetPath: a.assetPath,
      userLabel: a.sidecar?.custom.userLabel ?? null,
      faceCount: a.sidecar?.custom.faceCount ?? null,
      previews,
    };
  });
  sendJson(res, 200, { assets: list });
}

/** GET /plugins/dsh-gen3d/files/<path>：只读服务 workspace 内资产与预览文件。 */
async function handleApiFiles(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendText(res, 405, 'method not allowed');
    return;
  }
  const url = new URL(req.url ?? '/', 'http://local');
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, 'malformed percent-encoding');
    return;
  }
  const segments = decoded.replace(/^\/+/, '').split('/').filter((s) => s !== '');
  // 前缀 /plugins/dsh-gen3d/files/ 已由 prefix 路由消费；剩余段名仍需逐段校验
  if (segments.length < 4 || segments[0] !== 'plugins' || segments[1] !== 'dsh-gen3d' || segments[2] !== 'files') {
    sendText(res, 404, 'not found');
    return;
  }
  const rest = segments.slice(3);
  for (const segment of rest) {
    if (!safePathSegment(segment)) {
      sendText(res, 400, `unsafe path segment: ${JSON.stringify(segment)}`);
      return;
    }
  }
  // 只允许两类：assets/** 与 .dsh-gen3d/previews/**
  const store = getStore();
  let root: string;
  if (rest[0] === 'assets') {
    root = join(store.workspaceRoot, 'assets');
  } else if (rest[0] === '.dsh-gen3d' && rest[1] === 'previews') {
    root = join(store.workspaceRoot, '.dsh-gen3d', 'previews');
  } else {
    sendText(res, 404, 'not found');
    return;
  }
  const abs = resolve(store.workspaceRoot, ...rest);
  if (!abs.startsWith(resolve(root) + sep) && abs !== resolve(root)) {
    sendText(res, 403, 'path escapes allowed roots');
    return;
  }
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(abs));
  } catch {
    sendText(res, 404, `no such file: ${rest.join('/')}`);
    return;
  }
  const ext = basename(abs).split('.').pop()?.toLowerCase() ?? '';
  res.statusCode = 200;
  res.setHeader('content-type', FILE_CONTENT_TYPES[ext] ?? 'application/octet-stream');
  res.end(data);
}

/** 可选 webServer 装配：存在则注册资产清单 API 与文件服务路由（ctx.effect 托管注销）。 */
function installGen3dWebServer(ctx: Context): void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined;
  if (webServer === undefined) return; // headless / 未挂载 webServer：静默跳过
  ctx.effect(() => webServer.register({ kind: 'exact', path: '/plugins/dsh-gen3d/api/assets', handler: handleApiAssets }));
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/plugins/dsh-gen3d/files', handler: handleApiFiles }));
}

// ── 插件装配 ─────────────────────────────────────────────────────────────────

/** 装配：注册 21 个工具 + 计费审批 gate + 随包 skill provider + 设置卡片 host 半边 + 可选 webServer 路由。 */
export function apply(ctx: Context): void {
  for (const def of allGen3dTools) {
    ctx.tools.register(toToolDefinition(def, ctx));
  }
  ctx.on('tools/pre-execute', billingGate);
  ctx.skills.registerProvider(() => gen3dSkillProvider);
  // 预览工具的附件服务注入（attachments 已在 inject，装配时挂接；
  // 经 ctx.get 而非 ctx.attachments —— 类型上该服务的 declare module 增强
  // 在 @deepseek-ai/dsh-attachment 包里，本插件未依赖它，get 返回 any）
  const attachments = ctx.get('attachments') as { saveImage: (input: never) => Promise<ImageAttachmentRefLike> } | undefined;
  setPreviewAttachmentStore(attachments ? { saveImage: (input) => attachments.saveImage(input as never) } : null);
  // 设置卡片 host 半边：注册 gen3d 命名空间（浏览器卡片同 key 配对），并把
  // 解析后的 apiKeyEnv 引用接给 config.ts 工具密钥解析（settings 服务缺席时
  // 整体不生效，密钥解析回退 PROVIDER_ENV_KEYS 缺省）。
  installGen3dSettingsSection(ctx);
  installGen3dWebServer(ctx);
}
