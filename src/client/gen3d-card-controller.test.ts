// 卡片控制器数据面单测：节 + 凭证域 → 状态投影、覆盖标记、setRef/clearRef
// 写路径。纯 TS 数据面，不渲染 React（不引入组件测试设施）。
//
// runtime/client 的发布产物是浏览器 bundle（顶层引用 window），node 测试
// 环境 mock 掉 createSnapshotStore（控制器只用 store.set/getSnapshot/subscribe）。

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client';

import { GEN3D_SETTINGS_NAMESPACE, PROVIDER_SETTING_KEYS } from '../settings.js';
import {
  CLIENT_SETTING_KEYS,
  GEN3D_CARD_KEY,
  Gen3dCardController,
} from './gen3d-card-controller.js';

vi.mock('@deepseek-ai/dsh-client-runtime/client', () => ({
  createSnapshotStore<T>(init: T) {
    let state = init;
    const listeners = new Set<() => void>();
    return {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => { listeners.delete(fn) };
      },
      update: () => {},
      set: (next: T) => {
        state = next;
        for (const fn of listeners) fn();
      },
    };
  },
}));

/** 最小节形状（与控制器内部结构镜像）。 */
interface Section {
  meshyApiKeyEnv?: string;
  hunyuan3dApiKeyEnv?: string;
  tripo3dApiKeyEnv?: string;
  rodinApiKeyEnv?: string;
}

/** 记录写路径的假 scope：set/unset 同步更新快照并广播；updateSnap 供测试直接改写。 */
function makeScope(init: SettingsScopeSnapshot<Section>): SettingsScope<Section> & {
  writes: { op: 'set' | 'unset'; field: string; value?: unknown }[];
  updateSnap(next: SettingsScopeSnapshot<Section>): void;
} {
  let snap = init;
  const listeners = new Set<() => void>();
  const writes: { op: 'set' | 'unset'; field: string; value?: unknown }[] = [];
  const emit = (): void => { for (const fn of listeners) fn() };
  const scope = {
    writes,
    getSnapshot: () => snap,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => { listeners.delete(fn) };
    },
    updateSnap: (next: SettingsScopeSnapshot<Section>) => {
      snap = next;
      emit();
    },
    set: async (field: string, value: unknown) => {
      writes.push({ op: 'set', field, value });
      snap = {
        ...snap,
        status: 'ready',
        value: { ...(snap.value as Section), [field]: value as string } as Section,
        user: { ...((snap.user as Record<string, unknown> | undefined) ?? {}), [field]: value },
      };
      emit();
    },
    unset: async (field: string) => {
      writes.push({ op: 'unset', field });
      const next = { ...(snap.value as Section) };
      delete (next as Record<string, unknown>)[field];
      const user = { ...((snap.user as Record<string, unknown> | undefined) ?? {}) };
      delete user[field];
      snap = { ...snap, status: 'ready', value: next, user };
      emit();
    },
  } as unknown as SettingsScope<Section> & { writes: typeof writes; updateSnap: (next: SettingsScopeSnapshot<Section>) => void };
  return scope;
}

/** 假凭证域 wire 面（立即完成）。 */
function makeApi(views: Record<string, { configured?: boolean; writable?: boolean } | undefined>) {
  return {
    credentials: {
      describe: vi.fn(async ({ refs }: { refs: string[] }) => {
        const credentials: Record<string, { configured: boolean; writable: boolean }> = {};
        for (const ref of refs) {
          const view = views[ref];
          credentials[ref] = view === undefined
            ? { configured: false, writable: true }
            : { configured: view.configured ?? false, writable: view.writable ?? true };
        }
        return { result: { ok: true as const, value: { credentials } } };
      }),
    },
  };
}

/** describe 成功响应形状（与 wire 面 CredentialView 结构兼容）。 */
interface CredentialDescribeResponse {
  result: {
    ok: true;
    value: { credentials: Record<string, { configured: boolean; writable: boolean }> };
  };
}

/** 可控完成顺序的假凭证域：每次 describe 挂起一个 deferred，由测试按序 resolve。 */
interface DeferredDescribe {
  promise: Promise<CredentialDescribeResponse>;
  resolve(value: CredentialDescribeResponse): void;
}

function makeDeferredApi() {
  const calls: DeferredDescribe[] = [];
  return {
    calls,
    credentials: {
      describe: vi.fn((_req: { refs: string[] }) => {
        let resolve!: (value: CredentialDescribeResponse) => void;
        const promise = new Promise<CredentialDescribeResponse>((res) => { resolve = res });
        calls.push({ promise, resolve });
        return promise;
      }),
    },
  };
}

function readySnap(overrides: Partial<SettingsScopeSnapshot<Section>> = {}): SettingsScopeSnapshot<Section> {
  return {
    status: 'ready',
    value: {
      meshyApiKeyEnv: 'MESHY_API_KEY',
      hunyuan3dApiKeyEnv: 'HUNYUAN3D_API_KEY',
      tripo3dApiKeyEnv: 'TRIPO3D_API_KEY',
      rodinApiKeyEnv: 'RODIN_API_KEY',
    },
    base: {},
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
    ...overrides,
  };
}

let flush: () => Promise<void>;

beforeEach(() => {
  flush = () => new Promise((resolve) => { setTimeout(resolve, 0) });
});

describe('Gen3dCardController 状态投影', () => {
  it('ready 节 + 凭证域 → 四行状态（configured → real，否则 mock）', async () => {
    const scope = makeScope(readySnap());
    const api = makeApi({ MESHY_API_KEY: { configured: true }, TRIPO3D_API_KEY: { configured: false } });
    const card = new Gen3dCardController(scope as unknown as SettingsScope<Section>, api);
    await flush();

    const state = card.inject().hooks.gen3dCard.getSnapshot();
    expect(state.status).toBe('ready');
    expect(state.providers).toHaveLength(4);
    const byId = new Map(state.providers.map((p) => [p.providerId, p]));
    expect(byId.get('meshy')).toMatchObject({ apiKeyEnv: 'MESHY_API_KEY', mode: 'real', configured: true });
    expect(byId.get('tripo3d')).toMatchObject({ mode: 'mock', configured: false });
    expect(byId.get('hunyuan3d')).toMatchObject({ apiKeyEnv: 'HUNYUAN3D_API_KEY', mode: 'mock' });
    expect(api.credentials.describe).toHaveBeenCalledWith({
      refs: ['MESHY_API_KEY', 'HUNYUAN3D_API_KEY', 'TRIPO3D_API_KEY', 'RODIN_API_KEY'],
    });
  });

  it('user 层字段存在 → overridden 标记（值相等也是覆盖）', async () => {
    const scope = makeScope(readySnap({ user: { meshyApiKeyEnv: 'MESHY_API_KEY' } }));
    const api = makeApi({});
    const card = new Gen3dCardController(scope as unknown as SettingsScope<Section>, api);
    await flush();
    const state = card.inject().hooks.gen3dCard.getSnapshot();
    const meshy = state.providers.find((p) => p.providerId === 'meshy')!;
    expect(meshy.overridden).toBe(true);
    expect(state.providers.find((p) => p.providerId === 'rodin')!.overridden).toBe(false);
  });
});

describe('Gen3dCardController 写路径', () => {
  it('setRef 写对应字段并重读；空串走清除', async () => {
    const scope = makeScope(readySnap());
    const api = makeApi({});
    const card = new Gen3dCardController(scope as unknown as SettingsScope<Section>, api);
    await flush();

    await card.setRef('meshy', 'MESH_KEY');
    await flush();
    expect(scope.writes.at(-1)).toEqual({ op: 'set', field: 'meshyApiKeyEnv', value: 'MESH_KEY' });

    await card.setRef('meshy', '   ');
    await flush();
    expect(scope.writes.at(-1)!.op).toBe('unset');
    expect(scope.writes.at(-1)!.field).toBe('meshyApiKeyEnv');
  });

  it('clearRef 清除对应字段', async () => {
    const scope = makeScope(readySnap());
    const api = makeApi({});
    const card = new Gen3dCardController(scope as unknown as SettingsScope<Section>, api);
    await flush();

    await card.clearRef('hunyuan3d');
    await flush();
    expect(scope.writes.at(-1)).toEqual({ op: 'unset', field: 'hunyuan3dApiKeyEnv' });
  });
});

describe('Gen3dCardController 乱序响应守卫', () => {
  it('旧引用集合的过期 describe 晚到被丢弃，不覆盖新状态', async () => {
    const scope = makeScope(readySnap());
    const api = makeDeferredApi();
    const card = new Gen3dCardController(scope as unknown as SettingsScope<Section>, api);
    // 构造即发起 describe#1（默认四引用），pending
    expect(api.calls).toHaveLength(1);
    expect(api.credentials.describe).toHaveBeenCalledWith({
      refs: ['MESHY_API_KEY', 'HUNYUAN3D_API_KEY', 'TRIPO3D_API_KEY', 'RODIN_API_KEY'],
    });

    // 响应期间节被改写（meshy 改引 MESH_KEY）→ subscribe 触发 describe#2
    scope.updateSnap(readySnap({
      value: { ...readySnap().value, meshyApiKeyEnv: 'MESH_KEY' },
      user: { meshyApiKeyEnv: 'MESH_KEY' },
    }));
    await flush();
    expect(api.calls).toHaveLength(2);
    expect(api.credentials.describe).toHaveBeenLastCalledWith({
      refs: ['MESH_KEY', 'HUNYUAN3D_API_KEY', 'TRIPO3D_API_KEY', 'RODIN_API_KEY'],
    });

    // 新响应先回：MESH_KEY 已配置 → real
    api.calls[1]!.resolve({ result: { ok: true, value: { credentials: { MESH_KEY: { configured: true, writable: true } } } } });
    await flush();
    let meshy = card.inject().hooks.gen3dCard.getSnapshot().providers.find((p) => p.providerId === 'meshy')!;
    expect(meshy).toMatchObject({ apiKeyEnv: 'MESH_KEY', mode: 'real', configured: true });

    // 旧响应（默认四引用、未配置）晚到：守卫应丢弃，不把卡片打回 mock
    api.calls[0]!.resolve({ result: { ok: true, value: { credentials: { MESHY_API_KEY: { configured: false, writable: true } } } } });
    await flush();
    meshy = card.inject().hooks.gen3dCard.getSnapshot().providers.find((p) => p.providerId === 'meshy')!;
    expect(meshy).toMatchObject({ apiKeyEnv: 'MESH_KEY', mode: 'real', configured: true });
  });
});

describe('跨侧一致性（host ↔ client 钉死）', () => {
  it('client 命名空间与 host GEN3D_SETTINGS_NAMESPACE 同串', () => {
    expect(GEN3D_CARD_KEY).toBe(GEN3D_SETTINGS_NAMESPACE);
  });

  it('client 字段名与 host PROVIDER_SETTING_KEYS 一一对应', () => {
    expect(CLIENT_SETTING_KEYS).toEqual(PROVIDER_SETTING_KEYS);
  });
});
