// 凭证解析 —— dsh-gen3d 唯一的密钥读取入口。
//
// 读取优先级（与 DSH credentials-local 四层一致，见 docs/dsh-api.md §4.3）：
//   1. process.env（只读源，总是胜出）
//   2. $DSH_HOME/.credentials.yaml（YAML 文档，仅一个映射）
//   3. <cwd>/.env
//   4. $DSH_HOME/.env
//
// 规则：
// - 自实现 YAML / `.env` 子集解析，不依赖 dsh 内部包；解析失败按"该层无内容"
//   处理（不抛出，不把半截值当配置）；
// - 空字符串视为未配置（与 DSH「空存储值即缺席」一致）；
// - 每次调用重新读文件（文件极小），不跨操作缓存 —— 轮换的密钥无需重启生效；
// - 所有密钥只读不打印；对外展示一律经 redactKey() 脱敏。

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ProviderId } from './providers/types.js';

// ── 变量名注册表 ────────────────────────────────────────────────────────────

/** 供应商 → 官方凭证环境变量名。 */
export const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  meshy: 'MESHY_API_KEY',
  hunyuan3d: 'HUNYUAN3D_API_KEY',
  tripo3d: 'TRIPO3D_API_KEY',
  rodin: 'RODIN_API_KEY',
};

/**
 * 腾讯云 API 3.0 签名路径预留（HUNYUAN3D_API_KEY 走 TokenHub Bearer，
 * 无需这两个；仅当官方要求密钥对签名时使用）。与 HUNYUAN3D_API_KEY
 * 同优先级链读取。
 */
export const HUNYUAN3D_SECRET_ID_ENV = 'HUNYUAN3D_SECRET_ID';
export const HUNYUAN3D_SECRET_KEY_ENV = 'HUNYUAN3D_SECRET_KEY';

// ── 可注入选项（默认读真实环境；测试注入隔离的 env / 目录） ─────────────────

export interface ConfigOptions {
  /** $DSH_HOME（默认 process.env.DSH_HOME，未设置回退 ~/.dsh）。 */
  dshHome?: string;
  /** 调用方 cwd（默认 process.cwd()）。 */
  cwd?: string;
  /** 环境（默认 process.env；**整体替换**，用于测试隔离）。 */
  env?: Record<string, string | undefined>;
}

function defaultEnv(options: ConfigOptions): Record<string, string | undefined> {
  return options.env ?? process.env;
}

/** $DSH_HOME 目录（显式 options.dshHome 优先，其次注入 env 的 DSH_HOME）。 */
export function dshHomeDir(options: ConfigOptions = {}): string {
  if (options.dshHome) return resolve(options.dshHome);
  const fromEnv = defaultEnv(options).DSH_HOME;
  if (fromEnv) return resolve(fromEnv);
  return join(homedir(), '.dsh');
}

// ── 文件解析（简单自实现子集） ──────────────────────────────────────────────

/** 解析 `.env` 子集：KEY=VALUE 行、忽略空行与整行注释、支持单双引号包裹。 */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = unquote(line.slice(eq + 1).trim());
    if (value === '') continue; // 空串视为未配置
    out[key] = value;
  }
  return out;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** 去掉 YAML 标量值里未加引号、前面有空白的行尾注释（引号内不动）。 */
function stripYamlComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(value[i - 1]!))) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value.trim();
}

const YAML_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*\s*:/;

/**
 * 解析 `$DSH_HOME/.credentials.yaml` 子集：仅一个扁平映射（键: 标量值）。
 * 兼容两种形态：
 *   1. 权威 DSH 形态（docs/dsh-api.md §4.3）：根映射直接是 `KEY: value`；
 *   2. 兼容形态：顶层 `credentials:` 包裹一层映射（README 旧示例）。
 * 其余 YAML 特性（数组 / 嵌套 / 流式映射）不支持，遇到非键值行跳过。
 */
export function parseCredentialsYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section: 'root' | 'credentials' = 'root';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (section === 'root' && indent === 0 && YAML_KEY_RE.test(trimmed)) {
      const colon = trimmed.indexOf(':');
      const key = trimmed.slice(0, colon).trim();
      const rest = stripYamlComment(trimmed.slice(colon + 1));
      if (key === 'credentials' && rest === '') {
        // 进入兼容包裹层；其子键要求缩进 ≥2
        section = 'credentials';
        continue;
      }
      const value = unquote(rest.trim());
      if (value !== '') out[key] = value;
      continue;
    }
    if (section === 'credentials' && indent >= 2) {
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (m) {
        const value = unquote(stripYamlComment(m[2]!));
        if (value !== '') out[m[1]!] = value;
      }
    }
  }
  return out;
}

// ── 分层读取 ────────────────────────────────────────────────────────────────

function readFileIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null; // 其他读取错误也按"该层无内容"处理，不把密钥解析炸掉
  }
}

/**
 * 按优先级合并全部四层凭证源（低优先级在前，高优先级覆盖）：
 * $DSH_HOME/.env ← <cwd>/.env ← $DSH_HOME/.credentials.yaml ← 环境变量。
 * 返回完整合并表；调用方按需取键。**值属于敏感数据，只可内部使用或脱敏展示。**
 */
export function loadCredentialLayers(options: ConfigOptions = {}): Record<string, string> {
  const dsh = dshHomeDir(options);
  const cwd = options.cwd ?? process.cwd();

  const merged: Record<string, string> = {};

  // 层 4：$DSH_HOME/.env
  const dshEnvText = readFileIfExists(join(dsh, '.env'));
  if (dshEnvText !== null) Object.assign(merged, parseDotEnv(dshEnvText));
  // 层 3：<cwd>/.env
  const cwdEnvText = readFileIfExists(resolve(cwd, '.env'));
  if (cwdEnvText !== null) Object.assign(merged, parseDotEnv(cwdEnvText));
  // 层 2：$DSH_HOME/.credentials.yaml
  const yamlText = readFileIfExists(join(dsh, '.credentials.yaml'));
  if (yamlText !== null) Object.assign(merged, parseCredentialsYaml(yamlText));
  // 层 1：process.env（总是胜出）
  const env = defaultEnv(options);
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }
  return merged;
}

/** 读取任意名字的凭证键（四层优先级）。 */
function readKeyByName(envName: string, options: ConfigOptions = {}): string | undefined {
  return loadCredentialLayers(options)[envName];
}

// ── 对外 API ────────────────────────────────────────────────────────────────

/**
 * 读取某供应商的官方 API key（四层优先级：env > $DSH_HOME/.credentials.yaml
 * > <cwd>/.env > $DSH_HOME/.env）。未配置返回 undefined —— provider 实现
 * 不得直接读 process.env，一律经本函数。
 */
export function readProviderKey(id: ProviderId, options: ConfigOptions = {}): string | undefined {
  return readKeyByName(PROVIDER_ENV_KEYS[id], options);
}

/** 供应商凭证是否已配置（未配置时上层回退确定性 mock）。 */
export function isProviderConfigured(id: ProviderId, options: ConfigOptions = {}): boolean {
  return readProviderKey(id, options) !== undefined;
}

/** 四家配置状态一览（provider-status 工具用；只含布尔，不含值）。 */
export function providerConfiguredMap(options: ConfigOptions = {}): Record<ProviderId, boolean> {
  return {
    meshy: isProviderConfigured('meshy', options),
    hunyuan3d: isProviderConfigured('hunyuan3d', options),
    tripo3d: isProviderConfigured('tripo3d', options),
    rodin: isProviderConfigured('rodin', options),
  };
}

/** 腾讯云 API 3.0 签名路径的 SecretId（可选预留，同优先级链）。 */
export function readHunyuanSecretId(options: ConfigOptions = {}): string | undefined {
  return readKeyByName(HUNYUAN3D_SECRET_ID_ENV, options);
}

/** 腾讯云 API 3.0 签名路径的 SecretKey（可选预留，同优先级链）。 */
export function readHunyuanSecretKey(options: ConfigOptions = {}): string | undefined {
  return readKeyByName(HUNYUAN3D_SECRET_KEY_ENV, options);
}

/**
 * 密钥脱敏展示（provider-status / 日志用）：`sk-abcd…wxyz`。
 * 长度 ≤8 一律 `***`。**禁止在任何输出里打印完整密钥。**
 */
export function redactKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
