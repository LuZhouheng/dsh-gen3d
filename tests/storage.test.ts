// 资产落盘单测：saveAsset / sidecar / cache.jsonl（含 tombstone）/
// audit.jsonl / per-asset 锁 / 原子写 / 路径安全。全程本地临时目录，无网络。

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Gen3dStore, type AuditRecord, type CacheEntry } from '../src/storage.js';

const GLB_BYTES = Uint8Array.from([0x67, 0x6c, 0x62, 0x00, 0x01, 0x02]);

let tmp: string;
let store: Gen3dStore;

function newStore(overrides: { workspaceRoot?: string; env?: Record<string, string> } = {}): Gen3dStore {
  return new Gen3dStore({ workspaceRoot: overrides.workspaceRoot ?? join(tmp, 'ws'), cwd: tmp, env: overrides.env ?? {} });
}

function makeSidecar() {
  return {
    custom: {
      provider: 'meshy' as const,
      providerMode: 'real' as const,
      mode: 'text' as const,
      cacheKey: 'cache-1',
      prompt: '一个武士',
    },
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dsh-gen3d-storage-'));
  store = newStore();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('saveAsset', () => {
  it('原子写入主文件 + sidecar，字段齐全', async () => {
    const result = await store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: GLB_BYTES,
      sidecar: makeSidecar(),
    });
    expect(result.assetPath).toBe('assets/3d/characters/hero.glb');
    expect(result.sha256).toHaveLength(64);

    // 主文件落盘
    const abs = store.absolutePath(result.assetPath);
    expect(readFileSync(abs)).toEqual(Buffer.from(GLB_BYTES));

    // sidecar 落盘（<asset>.gen3d-meta.json）
    const sidecar = JSON.parse(readFileSync(result.sidecarPath, 'utf8')) as Record<string, any>;
    expect(sidecar.schemaVersion).toBe(1);
    expect(sidecar.producer).toEqual({ plugin: 'dsh-gen3d', pluginVersion: '0.1.0' });
    expect(sidecar.contentHash).toBe(`sha256:${result.sha256}`);
    expect(sidecar.size).toBe(GLB_BYTES.byteLength);
    expect(sidecar.type).toBe('gen3d-asset');
    expect(sidecar.dependencies).toEqual([]);
    expect(sidecar.custom).toMatchObject({
      provider: 'meshy',
      providerMode: 'real',
      mode: 'text',
      assetSlot: 'characters',
      cacheKey: 'cache-1',
      prompt: '一个武士',
      sourceJobId: null,
      sourceInputAssetPaths: [],
      readiness: { hasSourceMesh: true, rigged: false, animated: false },
    });

    // 无 .tmp- 残留（原子写）
    const names = (await import('node:fs/promises')).readdir(store.assetDir('characters'));
    expect((await names).every((n) => !n.startsWith('.tmp-'))).toBe(true);
  });

  it('不传 sidecar 时只写主文件', async () => {
    const result = await store.saveAsset({ slot: 'meshes', fileName: 'rock.glb', data: GLB_BYTES });
    expect(result.assetPath).toBe('assets/3d/meshes/rock.glb');
    expect(await store.readSidecar(result.assetPath)).toBeNull();
  });

  it('拒绝不安全文件名（路径穿越）', async () => {
    for (const bad of ['../evil.glb', 'a/b.glb', 'a\\b.glb', '..', 'x\0y.glb']) {
      await expect(
        store.saveAsset({ slot: 'meshes', fileName: bad, data: GLB_BYTES }),
      ).rejects.toMatchObject({ code: 'invalid_file_name' });
    }
  });
});

describe('readSidecar / updateSidecar / hasAsset / listAssets', () => {
  it('readSidecar 往返一致；缺失返回 null', async () => {
    await store.saveAsset({ slot: 'characters', fileName: 'hero.glb', data: GLB_BYTES, sidecar: makeSidecar() });
    const read = await store.readSidecar('assets/3d/characters/hero.glb');
    expect(read?.custom.provider).toBe('meshy');
    expect(await store.readSidecar('assets/3d/characters/ghost.glb')).toBeNull();
  });

  it('updateSidecar 读改写并持久化', async () => {
    await store.saveAsset({ slot: 'characters', fileName: 'hero.glb', data: GLB_BYTES, sidecar: makeSidecar() });
    await store.updateSidecar('assets/3d/characters/hero.glb', (s) => ({
      ...s,
      custom: { ...s.custom, userLabel: '主角' },
    }));
    const read = await store.readSidecar('assets/3d/characters/hero.glb');
    expect(read?.custom.userLabel).toBe('主角');
  });

  it('updateSidecar 对缺失 sidecar 抛 sidecar_not_found', async () => {
    await expect(
      store.updateSidecar('assets/3d/characters/ghost.glb', (s) => s),
    ).rejects.toMatchObject({ code: 'sidecar_not_found' });
  });

  it('hasAsset 判定存在性', async () => {
    await store.saveAsset({ slot: 'characters', fileName: 'hero.glb', data: GLB_BYTES, sidecar: makeSidecar() });
    expect(await store.hasAsset('assets/3d/characters/hero.glb')).toBe(true);
    expect(await store.hasAsset('assets/3d/characters/ghost.glb')).toBe(false);
  });

  it('listAssets 跨槽位盘点，含 sidecar', async () => {
    await store.saveAsset({ slot: 'characters', fileName: 'hero.glb', data: GLB_BYTES, sidecar: makeSidecar() });
    await store.saveAsset({ slot: 'meshes', fileName: 'rock.glb', data: GLB_BYTES });
    const all = await store.listAssets();
    expect(all.map((a) => a.assetPath)).toEqual([
      'assets/3d/characters/hero.glb',
      'assets/3d/meshes/rock.glb',
    ]);
    expect(all[0]?.sidecar?.custom.provider).toBe('meshy');
    expect(all[1]?.sidecar).toBeNull();

    const chars = await store.listAssets('characters');
    expect(chars.map((a) => a.assetPath)).toEqual(['assets/3d/characters/hero.glb']);
    // 空/缺失目录不炸
    expect(await store.listAssets('meshes')).toHaveLength(1);
    const emptyStore = newStore({ workspaceRoot: join(tmp, 'ws-empty') });
    expect(await emptyStore.listAssets()).toEqual([]);
  });
});

describe('cache.jsonl', () => {
  it('putCache / getCacheEntry：live 命中，后写胜出', async () => {
    await store.putCache('k1', 'assets/3d/characters/a.glb');
    let entry = await store.getCacheEntry('k1');
    expect(entry).toMatchObject({ cacheKey: 'k1', status: 'live', assetPath: 'assets/3d/characters/a.glb' });
    // 同 key 覆盖更新
    await store.putCache('k1', 'assets/3d/characters/b.glb');
    entry = await store.getCacheEntry('k1');
    expect(entry?.assetPath).toBe('assets/3d/characters/b.glb');
    expect(await store.getCacheEntry('missing')).toBeNull();
  });

  it('tombstone 后 getCacheEntry 返回 tombstone 条目（调用方据 status 判定不可复用）', async () => {
    await store.putCache('k1', 'assets/3d/characters/a.glb');
    await store.tombstoneCache('k1');
    const entry = await store.getCacheEntry('k1');
    expect(entry?.status).toBe('tombstone');
    expect(entry?.assetPath).toBeNull();
  });

  it('tombstoneForAssetPath 反查并批量打标', async () => {
    await store.putCache('k1', 'assets/3d/characters/a.glb');
    await store.putCache('k2', 'assets/3d/characters/a.glb');
    await store.putCache('k3', 'assets/3d/characters/other.glb');
    const affected = await store.tombstoneForAssetPath('assets/3d/characters/a.glb');
    expect(affected.sort()).toEqual(['k1', 'k2']);
    expect((await store.getCacheEntry('k1'))?.status).toBe('tombstone');
    expect((await store.getCacheEntry('k2'))?.status).toBe('tombstone');
    expect((await store.getCacheEntry('k3'))?.status).toBe('live');
  });

  it('listCache 返回后写胜出去重后的当前状态', async () => {
    await store.putCache('k1', 'assets/3d/characters/a.glb');
    await store.putCache('k2', 'assets/3d/characters/b.glb');
    await store.putCache('k1', 'assets/3d/characters/a2.glb');
    await store.tombstoneCache('k2');
    const all = await store.listCache();
    expect(all).toHaveLength(2);
    const byKey = new Map(all.map((e) => [e.cacheKey, e]));
    expect(byKey.get('k1')?.assetPath).toBe('assets/3d/characters/a2.glb');
    expect(byKey.get('k2')?.status).toBe('tombstone');
  });
});

describe('audit.jsonl', () => {
  it('appendAudit / listAudit 往返一致', async () => {
    const record: AuditRecord = {
      ts: '2026-08-13T00:00:00.000Z',
      provider: 'meshy',
      mode: 'text',
      event: 'submit',
      sourceJobId: 'job-1',
      detail: 'submitted',
    };
    await store.appendAudit(record);
    await store.appendAudit({ ...record, event: 'poll_succeeded', detail: 'done' });
    const all = await store.listAudit();
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ event: 'submit', provider: 'meshy' });
    expect(all[1]).toMatchObject({ event: 'poll_succeeded' });
    // 坏行跳过（模拟半截追加）
    const auditPath = join(tmp, 'ws', '.dsh-gen3d', 'audit.jsonl');
    writeFileSync(auditPath, `${readFileSync(auditPath, 'utf8')}{broken-json\n`);
    expect(await store.listAudit()).toHaveLength(2);
  });
});

describe('deleteAsset', () => {
  it('删除主文件 + sidecar + 依赖文件，并 tombstone 关联 cacheKey、写审计', async () => {
    await store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: GLB_BYTES,
      sidecar: {
        dependencies: [{ path: 'hero.png', hash: 'sha256:abc', kind: 'preview_image' }],
        custom: { provider: 'meshy', providerMode: 'real', mode: 'text', cacheKey: 'ck-hero' },
      },
    });
    // 依赖文件：同目录 hero.png（与主文件同名同目录）
    const depPath = join(store.assetDir('characters'), 'hero.png');
    writeFileSync(depPath, 'png');
    await store.putCache('ck-hero', 'assets/3d/characters/hero.glb');

    const deleted = await store.deleteAsset('assets/3d/characters/hero.glb');
    expect(deleted).toBe(true);
    expect(await store.hasAsset('assets/3d/characters/hero.glb')).toBe(false);
    expect(await store.readSidecar('assets/3d/characters/hero.glb')).toBeNull();
    // 依赖文件 hero.png 一并删除
    await expect(import('node:fs/promises').then((m) => m.readFile(depPath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await store.getCacheEntry('ck-hero'))?.status).toBe('tombstone');

    const audits = await store.listAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ event: 'asset_deleted', provider: 'meshy', assetPath: 'assets/3d/characters/hero.glb' });

    // 再删已不存在的资产 → false 且不追加审计
    expect(await store.deleteAsset('assets/3d/characters/hero.glb')).toBe(false);
    expect(await store.listAudit()).toHaveLength(1);
  });

  it('依赖路径防穿越：../ 目标被跳过，不影响主文件删除', async () => {
    await store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: GLB_BYTES,
      sidecar: {
        dependencies: [{ path: '../secret.txt', hash: 'sha256:x', kind: 'texture' }],
        custom: { provider: 'rodin', providerMode: 'mock', mode: 'text' },
      },
    });
    writeFileSync(join(tmp, 'secret.txt'), 'keep');
    await store.deleteAsset('assets/3d/characters/hero.glb');
    expect(readFileSync(join(tmp, 'secret.txt'), 'utf8')).toBe('keep'); // 未被误删
  });
});

describe('withAssetLock', () => {
  it('同一 key 上操作严格串行', async () => {
    const order: string[] = [];
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 15));
      order.push('first');
    };
    const fast = async () => {
      order.push('second');
    };
    await Promise.all([store.withAssetLock('a', slow), store.withAssetLock('a', fast)]);
    expect(order).toEqual(['first', 'second']); // fast 必须等 slow 完成
    // 不同 key 互不阻塞
    const parallel: string[] = [];
    await Promise.all([
      store.withAssetLock('x', async () => { parallel.push('x'); }),
      store.withAssetLock('y', async () => { parallel.push('y'); }),
    ]);
    expect(parallel.sort()).toEqual(['x', 'y']);
  });

  it('前序失败不阻塞后续操作', async () => {
    const calls: string[] = [];
    await Promise.allSettled([
      store.withAssetLock('a', async () => { calls.push('fail'); throw new Error('boom'); }),
      store.withAssetLock('a', async () => { calls.push('ok'); }),
    ]);
    expect(calls).toEqual(['fail', 'ok']);
    // 锁已释放，后续可再次使用
    await store.withAssetLock('a', async () => { calls.push('again'); });
    expect(calls).toEqual(['fail', 'ok', 'again']);
  });
});

describe('workspaceRoot', () => {
  it('GEN3D_WORKSPACE_ROOT 环境变量覆盖工作区根', () => {
    const s = new Gen3dStore({ cwd: tmp, env: { GEN3D_WORKSPACE_ROOT: join(tmp, 'alt-ws') } });
    expect(s.workspaceRoot).toBe(join(tmp, 'alt-ws'));
    expect(s.assetDir('characters')).toBe(join(tmp, 'alt-ws', 'assets', '3d', 'characters'));
  });

  it('显式 workspaceRoot 胜过环境变量；缺省用 cwd', () => {
    const s = new Gen3dStore({
      workspaceRoot: join(tmp, 'explicit'),
      cwd: tmp,
      env: { GEN3D_WORKSPACE_ROOT: join(tmp, 'alt-ws') },
    });
    expect(s.workspaceRoot).toBe(join(tmp, 'explicit'));
    expect(newStore({ env: {} }).workspaceRoot).toBe(join(tmp, 'ws'));
  });
});

describe('cache 与资产删除联动（端到端）', () => {
  it('saveAsset → putCache → 命中验证 → deleteAsset 后 cache 失效', async () => {
    const r = await store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: GLB_BYTES,
      sidecar: { custom: { provider: 'meshy', providerMode: 'mock', mode: 'text', cacheKey: 'ck' } },
    });
    await store.putCache('ck', r.assetPath);

    const hit = await store.getCacheEntry('ck');
    expect(hit?.status).toBe('live');
    expect(await store.hasAsset(hit!.assetPath!)).toBe(true);

    await store.deleteAsset(r.assetPath);
    const after = await store.getCacheEntry('ck');
    expect(after?.status).toBe('tombstone');
    expect(after?.assetPath).toBeNull();
  });
});
