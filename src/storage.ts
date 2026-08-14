// 资产落盘 —— dsh-gen3d 的本地持久化层。
//
// 布局（workspaceRoot 默认 cwd，可用 GEN3D_WORKSPACE_ROOT 环境变量覆盖）：
//   <root>/assets/3d/{characters,meshes}/<file>          —— 主资产（GLB/FBX/PNG…）
//   <root>/assets/3d/{characters,meshes}/<file>.gen3d-meta.json  —— sidecar（复用 legacy
//       shared/manifest.ts 的 AssetSidecar 契约形状，provider 字段收窄为新契约 ProviderId）
//   <root>/.dsh-gen3d/cache.jsonl  —— cacheKey → assetPath 映射；追加写、后写胜出；
//       删除资产时对相关 cacheKey 打 tombstone（复用 legacy makeCacheKey 语义）
//   <root>/.dsh-gen3d/audit.jsonl  —— 审计；只记元数据，绝不写密钥 / 请求载荷 / 原始响应
//
// 实现要点：
// - 所有写入原子化（同目录临时文件 + rename）；文件先落盘、sidecar 后落盘，
//   中途崩溃最多丢 sidecar（可重建），不会出现"有 sidecar 无资产"的假象；
// - 进程内 per-asset 异步锁（withAssetLock），同一资产路径上的操作串行；
// - 无任何外部平台环境变量与宿主 URL 耦合（localUrl 一律 null，由调用方决定）。
//
// 注：跨进程锁不在本层范围（DSH 单进程运行）；cache.jsonl 的"后写胜出"读取
// 天然容忍并发追加。

import { createHash, randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import {
  ASSET_SLOT_DIRS,
  type AssetSidecar,
  type AssetSlot,
  type GenerationMode,
  type PlayableDeliverySnapshot,
  type ProviderMode,
  type QualityReport,
  type RigChain,
  type SidecarDependency,
} from './legacy/shared/manifest.js';
// manifest.ts 只是 import 了这两个类型并未 re-export，需从源头模块导入
import type { CharacterMotionOverride, MotionMappingDraft } from './legacy/shared/playable-profile.js';
import type { AuditEvent } from './legacy/server/audit.js';
import type { ProviderId } from './providers/types.js';

// ── 对外类型 ────────────────────────────────────────────────────────────────

/** sidecar：复用 legacy AssetSidecar 契约形状，provider 字段改为新契约 ProviderId。 */
export type Gen3dSidecar = Omit<AssetSidecar, 'custom'> & {
  custom: Omit<AssetSidecar['custom'], 'provider'> & { provider: ProviderId };
};

export interface StoreOptions {
  /** 工作区根（默认 GEN3D_WORKSPACE_ROOT 环境变量，缺省 cwd）。 */
  workspaceRoot?: string;
  /** 调用方 cwd（默认 process.cwd()；测试注入用）。 */
  cwd?: string;
  /** 环境（默认 process.env；测试注入用）。 */
  env?: Record<string, string | undefined>;
}

/** saveAsset 的 sidecar 描述；完整性关键字段（provider / providerMode / mode）必填。 */
export interface SaveSidecarSpec {
  /** 资产类型标签（如 gen3d-character / gen3d-mesh）。默认 gen3d-asset。 */
  type?: string;
  producer?: { plugin: string; pluginVersion: string };
  dependencies?: SidecarDependency[];
  custom: {
    provider: ProviderId;
    /** mock 标记必须显式：mock 产物绝不冒充真实生成。 */
    providerMode: ProviderMode;
    mode: GenerationMode;
    /** 以下字段缺省由存储层填安全默认值。 */
    sourceJobId?: string | null;
    prompt?: string | null;
    sourceInputAssetPaths?: string[];
    readiness?: Gen3dSidecar['custom']['readiness'];
    cacheKey?: string;
    userLabel?: string | null;
    faceCount?: number;
    quality?: QualityReport;
    meshyTaskRefs?: Gen3dSidecar['custom']['meshyTaskRefs'];
    rig?: RigChain;
    playableOverride?: CharacterMotionOverride;
    motionMapping?: MotionMappingDraft;
    playableDelivery?: PlayableDeliverySnapshot;
  };
}

export interface SaveAssetInput {
  slot: AssetSlot;
  /** 文件名（仅 basename；含路径分隔符 / .. / NUL 一律拒绝，防穿越）。 */
  fileName: string;
  data: Uint8Array;
  /** 缺省则不写 sidecar（一般不缺省）。 */
  sidecar?: SaveSidecarSpec;
}

export interface SaveAssetResult {
  /** 资产身份：相对 workspaceRoot 的路径（assets/3d/characters/hero.glb）。 */
  assetPath: string;
  sidecarPath: string;
  /** 主文件 sha256（hex，无前缀）。 */
  sha256: string;
  sidecar: Gen3dSidecar;
}

export interface StoredAsset {
  assetPath: string;
  slot: AssetSlot;
  /** sidecar 缺失（如崩溃残留）时为 null。 */
  sidecar: Gen3dSidecar | null;
}

/** cache.jsonl 行。tombstone 表示该 cacheKey 对应的资产已删除，不得复用。 */
export interface CacheEntry {
  cacheKey: string;
  /** 命中的资产相对路径；tombstone 时为 null。 */
  assetPath: string | null;
  status: 'live' | 'tombstone';
  ts: string;
}

/** 审计记录（复用 legacy audit 事件枚举；只记元数据）。 */
export interface AuditRecord {
  ts: string;
  provider: ProviderId | 'unknown';
  mode: GenerationMode;
  event: AuditEvent;
  sourceJobId?: string | null;
  assetPath?: string;
  cacheKey?: string;
  model?: string;
  httpStatus?: number;
  durationMs?: number;
  errorCode?: string;
  /** 简短、非秘密的说明（状态串 / 错误类）。绝不写载荷。 */
  detail?: string;
}

const DEFAULT_PRODUCER = { plugin: 'dsh-gen3d', pluginVersion: '0.1.0' } as const;
const META_DIR = '.dsh-gen3d';
const SIDECAR_SUFFIX = '.gen3d-meta.json';

// ── 工具函数 ────────────────────────────────────────────────────────────────

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 只允许裸文件名（防路径穿越）。 */
function safeFileName(name: string): string {
  if (
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw Object.assign(new Error(`unsafe file name ${JSON.stringify(name)}`), {
      code: 'invalid_file_name',
    });
  }
  return name;
}

/** 原子写：同目录临时文件 + rename；失败时清理临时文件。 */
async function writeFileAtomic(target: string, data: string | Uint8Array): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${basename(target)}-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, data);
  try {
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

function workspaceRootFrom(options: StoreOptions): string {
  const env = options.env ?? process.env;
  const envRoot = env['GEN3D_WORKSPACE_ROOT'];
  const root = options.workspaceRoot ?? (envRoot && envRoot.trim() !== '' ? envRoot : undefined);
  return resolve(root ?? options.cwd ?? process.cwd());
}

function buildSidecar(
  input: SaveAssetInput,
  assetPath: string,
  sha256: string,
  size: number,
  createdAt: string,
): Gen3dSidecar {
  const spec = input.sidecar!;
  const custom = spec.custom;
  const sidecar: Gen3dSidecar = {
    schemaVersion: 1,
    producer: spec.producer ?? DEFAULT_PRODUCER,
    createdAt,
    contentHash: `sha256:${sha256}`,
    size,
    type: spec.type ?? 'gen3d-asset',
    dependencies: spec.dependencies ?? [],
    custom: {
      provider: custom.provider,
      providerMode: custom.providerMode,
      mode: custom.mode,
      assetSlot: input.slot,
      sourceJobId: custom.sourceJobId ?? null,
      prompt: custom.prompt ?? null,
      sourceInputAssetPaths: custom.sourceInputAssetPaths ?? [],
      readiness: custom.readiness ?? { hasSourceMesh: true, rigged: false, animated: false },
      ...(custom.userLabel !== undefined && { userLabel: custom.userLabel }),
      ...(custom.cacheKey !== undefined && { cacheKey: custom.cacheKey }),
      ...(custom.faceCount !== undefined && { faceCount: custom.faceCount }),
      ...(custom.quality !== undefined && { quality: custom.quality }),
      ...(custom.meshyTaskRefs !== undefined && { meshyTaskRefs: custom.meshyTaskRefs }),
      ...(custom.rig !== undefined && { rig: custom.rig }),
      ...(custom.playableOverride !== undefined && { playableOverride: custom.playableOverride }),
      ...(custom.motionMapping !== undefined && { motionMapping: custom.motionMapping }),
      ...(custom.playableDelivery !== undefined && { playableDelivery: custom.playableDelivery }),
    },
  };
  return sidecar;
}

// ── Gen3dStore ──────────────────────────────────────────────────────────────

/**
 * 资产存储：工作区布局、sidecar、cache.jsonl、audit.jsonl、per-asset 异步锁、
 * 原子写。所有方法幂等安全，可被工具层直接调用。
 */
export class Gen3dStore {
  readonly workspaceRoot: string;

  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: StoreOptions = {}) {
    this.workspaceRoot = workspaceRootFrom(options);
  }

  // ── 路径 ────────────────────────────────────────────────────────────────

  /** 槽位目录（绝对路径）。 */
  assetDir(slot: AssetSlot): string {
    return join(this.workspaceRoot, 'assets', '3d', ASSET_SLOT_DIRS[slot]);
  }

  /** 资产相对路径（身份键，工具层以此为 assetPath）。 */
  assetPathFor(slot: AssetSlot, fileName: string): string {
    return join('assets', '3d', ASSET_SLOT_DIRS[slot], safeFileName(fileName));
  }

  /** 资产绝对路径。 */
  absolutePath(assetPath: string): string {
    return resolve(this.workspaceRoot, assetPath);
  }

  /** sidecar 绝对路径：<asset>.gen3d-meta.json。 */
  sidecarPathFor(assetPath: string): string {
    return `${this.absolutePath(assetPath)}${SIDECAR_SUFFIX}`;
  }

  private metaDir(): string {
    return join(this.workspaceRoot, META_DIR);
  }

  private cacheFile(): string {
    return join(this.metaDir(), 'cache.jsonl');
  }

  private auditFile(): string {
    return join(this.metaDir(), 'audit.jsonl');
  }

  // ── per-asset 异步锁 ────────────────────────────────────────────────────

  /**
   * 进程内 per-asset 异步互斥：同一 key（建议用 assetPath 或 cacheKey）上的
   * 操作串行执行；前序失败不阻塞后续。返回 fn 的结果。
   */
  async withAssetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => {
        if (this.locks.get(key) === tail) this.locks.delete(key);
      },
      () => {
        if (this.locks.get(key) === tail) this.locks.delete(key);
      },
    );
    this.locks.set(key, tail);
    return run;
  }

  // ── 资产写入 / 读取 ─────────────────────────────────────────────────────

  /** 原子写入主资产文件 + sidecar（同一锁内；先文件后 sidecar）。 */
  async saveAsset(input: SaveAssetInput): Promise<SaveAssetResult> {
    const assetPath = this.assetPathFor(input.slot, input.fileName);
    return this.withAssetLock(assetPath, async () => {
      const abs = this.absolutePath(assetPath);
      const sha256 = sha256Hex(input.data);
      await writeFileAtomic(abs, input.data);
      if (input.sidecar) {
        const sidecar = buildSidecar(input, assetPath, sha256, input.data.byteLength, nowIso());
        await writeFileAtomic(this.sidecarPathFor(assetPath), `${JSON.stringify(sidecar, null, 2)}\n`);
        return { assetPath, sidecarPath: this.sidecarPathFor(assetPath), sha256, sidecar };
      }
      return {
        assetPath,
        sidecarPath: this.sidecarPathFor(assetPath),
        sha256,
        sidecar: null as unknown as Gen3dSidecar,
      };
    });
  }

  /** 读取 sidecar；不存在返回 null。 */
  async readSidecar(assetPath: string): Promise<Gen3dSidecar | null> {
    try {
      const text = await readFile(this.sidecarPathFor(assetPath), 'utf8');
      return JSON.parse(text) as Gen3dSidecar;
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /**
   * 读-改-写 sidecar（同锁内原子更新；sidecar 不存在时抛错）。
   * 用于 rename-asset（userLabel）、rig / motion-mapping 等后续步骤。
   */
  async updateSidecar(
    assetPath: string,
    updater: (sidecar: Gen3dSidecar) => Gen3dSidecar,
  ): Promise<Gen3dSidecar> {
    return this.withAssetLock(assetPath, async () => {
      const current = await this.readSidecar(assetPath);
      if (current === null) {
        throw Object.assign(new Error(`sidecar not found for ${assetPath}`), {
          code: 'sidecar_not_found',
        });
      }
      const next = updater(current);
      await writeFileAtomic(
        this.sidecarPathFor(assetPath),
        `${JSON.stringify(next, null, 2)}\n`,
      );
      return next;
    });
  }

  /** 资产主文件是否存在（cache 命中前先验证，防悬空映射）。 */
  async hasAsset(assetPath: string): Promise<boolean> {
    try {
      await readFile(this.absolutePath(assetPath));
      return true;
    } catch (err) {
      if (isEnoent(err)) return false;
      throw err;
    }
  }

  /** 盘点资产（按槽位过滤可省略）；返回稳定资产相对路径 + sidecar。 */
  async listAssets(slot?: AssetSlot): Promise<StoredAsset[]> {
    const slots: AssetSlot[] = slot ? [slot] : ['characters', 'meshes'];
    const out: StoredAsset[] = [];
    for (const s of slots) {
      const dir = this.assetDir(s);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if (isEnoent(err)) continue;
        throw err;
      }
      const mainNames = names.filter((n) => !n.endsWith(SIDECAR_SUFFIX)).sort();
      for (const n of mainNames) {
        const assetPath = this.assetPathFor(s, n);
        out.push({ assetPath, slot: s, sidecar: await this.readSidecar(assetPath) });
      }
    }
    return out;
  }

  /**
   * 删除资产：主文件 + sidecar + sidecar 声明的依赖文件（同目录、防穿越），
   * 并对指向该资产的 cacheKey 全部打 tombstone，追加 asset_deleted 审计。
   * 返回是否确已删除（不存在返回 false，不审计）。
   */
  async deleteAsset(assetPath: string): Promise<boolean> {
    return this.withAssetLock(assetPath, async () => {
      const abs = this.absolutePath(assetPath);
      if (!(await this.hasAsset(assetPath))) return false;
      const sidecar = await this.readSidecar(assetPath);
      if (sidecar) {
        const baseDir = dirname(abs);
        for (const dep of sidecar.dependencies) {
          const depPath = resolve(baseDir, dep.path);
          if (!depPath.startsWith(baseDir + sep)) continue; // 防穿越，异常路径跳过
          await rm(depPath, { force: true });
        }
      }
      await rm(abs, { force: true });
      await rm(this.sidecarPathFor(assetPath), { force: true });
      const tombstoned = await this.tombstoneForAssetPath(assetPath);
      await this.appendAudit({
        ts: nowIso(),
        provider: sidecar?.custom.provider ?? 'unknown',
        mode: sidecar?.custom.mode ?? 'text',
        event: 'asset_deleted',
        assetPath,
        detail: tombstoned.length > 0 ? `tombstoned cacheKeys: ${tombstoned.join(',')}` : undefined,
      });
      return true;
    });
  }

  // ── cache.jsonl ─────────────────────────────────────────────────────────

  /** 读全部缓存行（含 tombstone）；坏行跳过（容忍半截追加）。 */
  async readCacheFile(): Promise<CacheEntry[]> {
    const p = this.cacheFile();
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const entries: CacheEntry[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        entries.push(JSON.parse(line) as CacheEntry);
      } catch {
        // 跳过坏行
      }
    }
    return entries;
  }

  private async appendCacheLine(entry: CacheEntry): Promise<void> {
    const p = this.cacheFile();
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** 缓存查询：同一 cacheKey 后写胜出；返回该 key 的最新条目（无则 null）。 */
  async getCacheEntry(cacheKey: string): Promise<CacheEntry | null> {
    const entries = await this.readCacheFile();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!;
      if (e.cacheKey === cacheKey) return e;
    }
    return null;
  }

  /** 记录 cacheKey → assetPath（追加；同 key 再次写入即更新为最新）。 */
  async putCache(cacheKey: string, assetPath: string): Promise<void> {
    await this.appendCacheLine({ cacheKey, assetPath, status: 'live', ts: nowIso() });
  }

  /** 对 cacheKey 打 tombstone（资产删除后调用，防止复用已删资产）。 */
  async tombstoneCache(cacheKey: string): Promise<void> {
    await this.appendCacheLine({ cacheKey, assetPath: null, status: 'tombstone', ts: nowIso() });
  }

  /** 反查：把所有 live 且指向该 assetPath 的 cacheKey 打 tombstone，返回受影响 key。 */
  async tombstoneForAssetPath(assetPath: string): Promise<string[]> {
    const entries = await this.readCacheFile();
    const keys = [
      ...new Set(
        entries
          .filter((e) => e.status === 'live' && e.assetPath === assetPath)
          .map((e) => e.cacheKey),
      ),
    ];
    for (const key of keys) await this.tombstoneCache(key);
    return keys;
  }

  /** 当前缓存状态（后写胜出去重；tombstone 条目保留以便诊断）。 */
  async listCache(): Promise<CacheEntry[]> {
    const entries = await this.readCacheFile();
    const byKey = new Map<string, CacheEntry>();
    for (const e of entries) byKey.set(e.cacheKey, e);
    return [...byKey.values()];
  }

  // ── audit.jsonl ─────────────────────────────────────────────────────────

  /** 追加审计（只记元数据；密钥 / 载荷绝不落盘）。 */
  async appendAudit(record: AuditRecord): Promise<void> {
    const p = this.auditFile();
    await mkdir(dirname(p), { recursive: true });
    await appendFile(p, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** 读全部审计记录（坏行跳过）。 */
  async listAudit(): Promise<AuditRecord[]> {
    const p = this.auditFile();
    let text: string;
    try {
      text = await readFile(p, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const out: AuditRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as AuditRecord);
      } catch {
        // 跳过坏行
      }
    }
    return out;
  }
}
