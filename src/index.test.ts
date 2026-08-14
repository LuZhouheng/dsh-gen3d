// 插件入口单测 —— mock ctx 验证装配行为（不打真网、不碰真实凭证）：
// 1. 19 个工具全部经 defineTool 注册（官方 DSL 字段齐备）；
// 2. 长任务工具（= billing 名单 7 个）output.schema 注入后台句柄分支 + render 分支；
// 3. tools/pre-execute 审批 gate：mock 回退放行 / 真实 provider ask（reason 含供应商与 credits）；
// 4. 长任务 execute 经 ctx.jobs.start 后台化（返回 { kind: 'background', jobId }）；
// 5. 随包 skill provider 注册（list/get 返回包内 SKILL.md 摘要与正文）。
//
// 凭证隔离：beforeEach 把四家 provider 环境变量与 DSH_HOME 全部 stub 为空/临时目录
// （config.ts 空串视为未配置），用例内再按需设置；afterEach 统一恢复。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Context } from '@deepseek-ai/cordis';
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import type { JobStart } from '@deepseek-ai/dsh-jobs';
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name } from './index.js';
import { allGen3dTools, billingToolNames } from './tools/index.js';
import { configureToolDeps } from './tools/common.js';
import { FakeProvider, glbBytes, makeStore } from './tools/test-helpers.js';

// ── mock ctx（记录 register / on / jobs.start / skills.registerProvider） ──────

interface MockContext {
  registered: ToolDefinition[];
  preExecute: ((exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>)[];
  jobStarts: { spec: JobStart; id: string }[];
  skillProviders: SkillProvider[];
  tools: { register: (def: ToolDefinition) => () => void };
  jobs: { start: (spec: JobStart) => string };
  skills: { registerProvider: (create: () => SkillProvider) => () => void };
  on: (event: string, listener: (...args: unknown[]) => unknown) => () => void;
}

function makeMockCtx(): MockContext {
  const m = {
    registered: [],
    preExecute: [],
    jobStarts: [],
    skillProviders: [],
  } as unknown as MockContext;
  m.tools = {
    register: (def) => {
      m.registered.push(def);
      return () => undefined;
    },
  };
  m.jobs = {
    start: (spec) => {
      const id = `gen3d-${m.jobStarts.length + 1}`;
      m.jobStarts.push({ spec, id });
      return id;
    },
  };
  m.skills = {
    registerProvider: (create) => {
      m.skillProviders.push(create());
      return () => undefined;
    },
  };
  m.on = (event, listener) => {
    if (event === 'tools/pre-execute') m.preExecute.push(listener as MockContext['preExecute'][number]);
    return () => undefined;
  };
  return m;
}

function makeExec(name: string, args: Record<string, unknown>): ToolExecution {
  return {
    callId: `call-${name}`,
    rootCallId: `call-${name}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
    token: Symbol() as never,
  } as unknown as ToolExecution;
}

const allowNext = (): Promise<PreToolDecision> => Promise.resolve({ kind: 'allow' });

// ── 夹具 ─────────────────────────────────────────────────────────────────────

let dshHome: string;

beforeEach(() => {
  dshHome = mkdtempSync(join(tmpdir(), 'dsh-gen3d-index-test-'));
  for (const key of ['MESHY_API_KEY', 'HUNYUAN3D_API_KEY', 'HUNYUAN3D_SECRET_ID', 'HUNYUAN3D_SECRET_KEY', 'TRIPO3D_API_KEY', 'RODIN_API_KEY']) {
    vi.stubEnv(key, ''); // 空串 = 未配置（config.ts 语义）
  }
  vi.stubEnv('DSH_HOME', dshHome);
  configureToolDeps({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  configureToolDeps({});
  rmSync(dshHome, { recursive: true, force: true });
});

function appliedCtx(): MockContext {
  const ctx = makeMockCtx();
  apply(ctx as unknown as Context);
  return ctx;
}

// ── 导出与注册 ────────────────────────────────────────────────────────────────

describe('插件导出与工具注册', () => {
  it('导出 name=dsh-gen3d、inject=[tools, credentials, skills]', () => {
    expect(name).toBe('dsh-gen3d');
    expect(inject).toEqual(['tools', 'credentials', 'skills']);
  });

  it('19 个工具全部注册，名字唯一且与镜像清单一致', () => {
    const ctx = appliedCtx();
    expect(ctx.registered).toHaveLength(19);
    expect(ctx.registered.map((t) => t.name).sort()).toEqual(allGen3dTools.map((t) => t.name).sort());
    expect(new Set(ctx.registered.map((t) => t.name)).size).toBe(19);
  });

  it('注册定义带完整官方字段（name/description/parameters/output.schema/render/execute）', () => {
    const ctx = appliedCtx();
    for (const t of ctx.registered) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.parameters).toBeTypeOf('object');
      expect(t.output.schema).toBeTypeOf('object');
      expect(typeof t.output.render).toBe('function');
      expect(typeof t.execute).toBe('function');
      const mirror = allGen3dTools.find((d) => d.name === t.name);
      expect(mirror).toBeDefined();
      expect(t.name).toBe(mirror!.name);
      expect(t.description).toBe(mirror!.description);
    }
  });

  it('billing 名单 = 7 个长任务工具（生成 / 绑骨 / 套动作）', () => {
    expect(billingToolNames).toHaveLength(7);
    expect([...billingToolNames].sort()).toEqual(
      [
        'gen3d_text_to_3d',
        'gen3d_image_to_3d',
        'gen3d_views_to_3d',
        'gen3d_refine_mesh',
        'gen3d_retopo_lowpoly',
        'gen3d_auto_rig',
        'gen3d_apply_motion',
      ].sort(),
    );
  });

  it('长任务工具（= billing 名单）output.schema 并入后台句柄分支；其余原样', () => {
    const ctx = appliedCtx();
    const long = new Set(billingToolNames);
    for (const t of ctx.registered) {
      const schema = t.output.schema as unknown as {
        properties?: Record<string, { const?: unknown } | undefined>;
      };
      if (long.has(t.name)) {
        expect(schema.properties?.kind?.const).toBe('background');
        expect(schema.properties?.jobId).toBeDefined();
      } else {
        expect(schema.properties?.kind).toBeUndefined();
      }
    }
  });

  it('长任务 render 对后台句柄输出 jobId 引导文本、完整结果委托原 render', () => {
    const ctx = appliedCtx();
    const def = ctx.registered.find((t) => t.name === 'gen3d_text_to_3d')!;
    const handleText = def.output.render({ prompt: 'x' } as never, { kind: 'background', jobId: 'gen3d-1' } as never);
    expect(handleText[0]!.type).toBe('text');
    expect((handleText[0] as { text?: string }).text).toContain('gen3d-1');
    const resultText = def.output.render({ prompt: 'x' } as never, { ok: true, cacheHit: true, usedMock: true } as never);
    expect((resultText[0] as { text?: string }).text).toContain('cacheHit');
  });
});

// ── 审批 gate ────────────────────────────────────────────────────────────────

describe('tools/pre-execute 审批 gate', () => {
  it('非计费工具直接 next() 放行', async () => {
    const ctx = appliedCtx();
    const gate = ctx.preExecute[0]!;
    const next = vi.fn(allowNext);
    const decision = await gate(makeExec('gen3d_list_assets', {}), next);
    expect(decision).toEqual({ kind: 'allow' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('计费工具 + provider 未配置（mock 回退）→ next() 放行', async () => {
    const ctx = appliedCtx();
    const gate = ctx.preExecute[0]!;
    const next = vi.fn(allowNext);
    const decision = await gate(makeExec('gen3d_text_to_3d', { prompt: 'x', provider: 'meshy' }), next);
    expect(decision).toEqual({ kind: 'allow' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('计费工具 + provider 已配置 → { kind: ask }，reason 含供应商与预估 credits，不调 next', async () => {
    vi.stubEnv('MESHY_API_KEY', 'sk-test-12345678');
    const ctx = appliedCtx();
    const gate = ctx.preExecute[0]!;
    const next = vi.fn(allowNext);
    const decision = await gate(makeExec('gen3d_text_to_3d', { prompt: 'x' }), next); // 缺省 provider = meshy
    expect(decision.kind).toBe('ask');
    const reason = (decision as { reason?: string }).reason ?? '';
    expect(reason).toContain('Meshy');
    expect(reason).toContain('3');
    expect(next).not.toHaveBeenCalled();
  });

  it('hunyuan3d 走 TC3 密钥对路径也判定为真实 provider', async () => {
    vi.stubEnv('HUNYUAN3D_SECRET_ID', 'AKID-test');
    vi.stubEnv('HUNYUAN3D_SECRET_KEY', 'sk-test-secret');
    const ctx = appliedCtx();
    const gate = ctx.preExecute[0]!;
    const next = vi.fn(allowNext);
    const decision = await gate(makeExec('gen3d_retopo_lowpoly', { assetPath: 'assets/3d/characters/h.glb' }), next); // 缺省 hunyuan3d
    expect(decision.kind).toBe('ask');
    expect((decision as { reason?: string }).reason).toContain('Hunyuan3D');
    expect(next).not.toHaveBeenCalled();
  });

  it('auto_rig：auto 路由按 meshy→hunyuan3d→tripo3d 取第一个已配置；全未配置放行', async () => {
    const ctx = appliedCtx();
    const gate = ctx.preExecute[0]!;
    // 全未配置 → mock → 放行
    let decision = await gate(makeExec('gen3d_auto_rig', { assetPath: 'a.glb', rigProvider: 'auto' }), allowNext);
    expect(decision).toEqual({ kind: 'allow' });
    // 只配 tripo3d → auto 路由真实走 tripo3d → ask
    vi.stubEnv('TRIPO3D_API_KEY', 'sk-test-12345678');
    const next = vi.fn(allowNext);
    decision = await gate(makeExec('gen3d_auto_rig', { assetPath: 'a.glb', rigProvider: 'auto' }), next);
    expect(decision.kind).toBe('ask');
    expect((decision as { reason?: string }).reason).toContain('Tripo3D');
    expect(next).not.toHaveBeenCalled();
    // 显式 meshy + 未配置 → 放行
    vi.stubEnv('TRIPO3D_API_KEY', '');
    decision = await gate(makeExec('gen3d_auto_rig', { assetPath: 'a.glb', rigProvider: 'meshy' }), allowNext);
    expect(decision).toEqual({ kind: 'allow' });
  });

  it('apply_motion 按资产 rig 来源判定：meshy rig + 已配置 → ask；未配置 → 放行；资产不存在 → 放行', async () => {
    const { store, cleanup } = makeStore();
    configureToolDeps({ store });
    await store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: glbBytes('hero'),
      sidecar: {
        dependencies: [],
        custom: {
          provider: 'meshy',
          providerMode: 'real',
          mode: 'text',
          sourceJobId: 'task-1',
          prompt: 'hero',
          sourceInputAssetPaths: [],
          readiness: { hasSourceMesh: true, rigged: true, animated: false },
          rig: { rigProvider: 'meshy', rigTaskId: 'rig-1', rigType: null, rigExpiresAt: null },
        },
      },
    });
    const ctx = appliedCtx();
    const gate = ctx.preExecute[0]!;
    const args = { assetPath: 'assets/3d/characters/hero.glb', actionId: 1 };

    vi.stubEnv('MESHY_API_KEY', 'sk-test-12345678');
    const next = vi.fn(allowNext);
    const decision = await gate(makeExec('gen3d_apply_motion', args), next);
    expect(decision.kind).toBe('ask');
    expect((decision as { reason?: string }).reason).toContain('Meshy');
    expect(next).not.toHaveBeenCalled();

    vi.stubEnv('MESHY_API_KEY', '');
    expect(await gate(makeExec('gen3d_apply_motion', args), allowNext)).toEqual({ kind: 'allow' });

    // 资产不存在：工具先报 asset_not_found，不可能计费 → 放行
    expect(await gate(makeExec('gen3d_apply_motion', { assetPath: 'assets/3d/characters/missing.glb', actionId: 1 }), allowNext)).toEqual({
      kind: 'allow',
    });
    cleanup();
  });
});

// ── jobs 后台化 ──────────────────────────────────────────────────────────────

describe('长任务 jobs 后台化', () => {
  it('长任务 execute 返回 { kind: background, jobId }，底层工作在 gen3d 任务内完成', async () => {
    const { store, cleanup } = makeStore();
    // providerFactory → 未配置的 fake：走确定性 mock 路径（零网络零配额）
    configureToolDeps({ store, providerFactory: async () => new FakeProvider('meshy', false) });
    const ctx = appliedCtx();
    const def = ctx.registered.find((t) => t.name === 'gen3d_text_to_3d')!;

    const fakeAgent = { id: 'agent-1' } as never;
    const handle = await def.execute(
      { prompt: '测试角色', provider: 'meshy', assetName: 'hero' } as never,
      { signal: new AbortController().signal, agent: fakeAgent } as never,
    );
    expect(handle).toMatchObject({ kind: 'background' });
    const jobId = (handle as { jobId?: unknown }).jobId;
    expect(typeof jobId).toBe('string');

    expect(ctx.jobStarts).toHaveLength(1);
    const job = ctx.jobStarts[0]!;
    expect(job.id).toBe(jobId);
    expect(job.spec.kind).toBe('gen3d');
    expect(job.spec.label).toContain('gen3d_text_to_3d');
    expect(job.spec.owner).toBe(fakeAgent);

    const hooks = job.spec.run();
    const outcome = await hooks.done;
    expect(outcome.status).toBe('completed');
    const output = JSON.parse(outcome.output ?? '{}') as { usedMock?: boolean; cacheHit?: boolean };
    expect(output.usedMock).toBe(true); // mock 回退在任务内完成
    expect(output.cacheHit).toBe(false);
    expect(hooks.readOutput?.()).toBe(outcome.output);
    expect(hooks.readOutput?.()).toBe(''); // 消费式读
    expect(() => hooks.cancel('测试取消')).not.toThrow(); // 同步幂等

    // 任务产物落盘到注入的临时工作区
    const assets = await store.listAssets();
    expect(assets.some((a) => a.assetPath.includes('hero'))).toBe(true);
    cleanup();
  });

  it('底层执行抛错 → 任务以 failed 收尾（不 reject）', async () => {
    const { store, cleanup } = makeStore();
    configureToolDeps({ store, providerFactory: async () => new FakeProvider('meshy', false) });
    const ctx = appliedCtx();
    const def = ctx.registered.find((t) => t.name === 'gen3d_image_to_3d')!;
    const handle = await def.execute(
      { provider: 'meshy', assetName: 'x' } as never, // 三种图片输入全缺 → invalid_image_url
      { signal: new AbortController().signal } as never,
    );
    expect(handle).toMatchObject({ kind: 'background' });
    const job = ctx.jobStarts[0]!;
    const outcome = await job.spec.run().done;
    expect(outcome.status).toBe('completed'); // 业务失败以失败信封为规范值（不是异常）
    const value = JSON.parse(outcome.output ?? '{}') as { ok?: boolean; code?: string };
    expect(value.ok).toBe(false);
    expect(value.code).toBe('invalid_image_url');
    cleanup();
  });

  it('非长任务 execute 直接返回结果，不启动任务', async () => {
    const ctx = appliedCtx();
    const def = ctx.registered.find((t) => t.name === 'gen3d_provider_status')!;
    const value = (await def.execute({} as never, { signal: new AbortController().signal } as never)) as {
      ok?: boolean;
      providers?: unknown[];
    };
    expect(value.ok).toBe(true);
    expect(value.providers).toHaveLength(4);
    expect(ctx.jobStarts).toHaveLength(0);
  });
});

// ── skill 注册 ───────────────────────────────────────────────────────────────

describe('随包 skill provider', () => {
  it('registerProvider 注册 gen3d provider；list/get 返回包内技能', async () => {
    const ctx = appliedCtx();
    expect(ctx.skillProviders).toHaveLength(1);
    const provider = ctx.skillProviders[0]!;
    expect(provider.name).toBe('gen3d');

    const candidates = await provider.list({});
    expect(Array.isArray(candidates)).toBe(true);
    expect(candidates).toHaveLength(1);
    const candidate = (candidates as SkillCandidate[])[0]!;
    expect(candidate.name).toBe('generate-3d-character');
    expect(candidate.description).toContain('3D 角色');
    expect(candidate.invocation).toEqual({ modelInvocable: true, userInvocable: true });
    expect(candidate.provider).toBe('gen3d');
    expect(candidate.source).toBe('bundled');
    expect(candidate.rank).toBe(600); // BUNDLED_SKILL_RANK
    expect(candidate.resourceBase).toMatchObject({ kind: 'directory' });

    const def = await provider.get(candidate, {});
    expect(def).toBeDefined();
    expect(def!.name).toBe('generate-3d-character');
    expect(def!.content).toContain('# Generate a 3D Character');
    expect(def!.content).toContain('## Procedure');
  });
});
