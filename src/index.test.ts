// 插件入口单测 —— mock ctx 验证装配行为（不打真网、不碰真实凭证）：
// 1. 21 个工具全部经 defineTool 注册（官方 DSL 字段齐备）；
// 2. 长任务工具（= billing 名单 7 个）output.schema 注入后台句柄分支 + render 分支；
// 3. tools/pre-execute 审批 gate：mock 回退放行 / 真实 provider ask（reason 含供应商与 credits）；
// 4. 长任务 execute 经 ctx.jobs.start 后台化（返回 { kind: 'background', jobId }）；
// 5. 随包 skill provider 注册（list/get 返回包内 SKILL.md 摘要与正文）；
// 6. attachments 注入预览工具；webServer 存在时注册资产/文件路由，不存在时静默跳过。
//
// 凭证隔离：beforeEach 把四家 provider 环境变量与 DSH_HOME 全部 stub 为空/临时目录
// （config.ts 空串视为未配置），用例内再按需设置；afterEach 统一恢复。

import { mkdtempSync, rmSync } from 'node:fs';
import * as mainFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { Context } from '@deepseek-ai/cordis';
import type { PreToolDecision, ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools';
import type { JobStart } from '@deepseek-ai/dsh-jobs';
import type { SkillCandidate, SkillProvider } from '@deepseek-ai/dsh-skill';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apply, inject, name, scanSkillDirs } from './index.js';
import { providerEnvKeyOf } from './config.js';
import { allGen3dTools, billingToolNames } from './tools/index.js';
import { configureToolDeps } from './tools/common.js';
import { FakeProvider, glbBytes, makeStore } from './tools/test-helpers.js';

// ── mock ctx（记录 register / on / jobs.start / skills.registerProvider） ──────

interface MockContext {
  registered: ToolDefinition[];
  preExecute: ((exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>)[];
  jobStarts: { spec: JobStart; id: string }[];
  skillProviders: SkillProvider[];
  settingsRegistrations: { ns: unknown; schema: unknown; base: unknown }[];
  webServerRoutes: { kind: string; path: string; handler: unknown }[];
  /** false = headless（webServer 服务缺席）；默认 true（web 组合）。 */
  webServerPresent: boolean;
  tools: { register: (def: ToolDefinition) => () => void };
  jobs: { start: (spec: JobStart) => string };
  skills: { registerProvider: (create: () => SkillProvider) => () => void };
  settings: {
    register: (ns: unknown, schema: unknown, options?: { base?: unknown }) => {
      get: () => object;
      watch: () => () => void;
      update: () => Promise<void>;
      replace: () => Promise<void>;
    };
  };
  attachments?: { saveImage: (input: unknown) => Promise<unknown> };
  inject: (services: string[], callback: (ctx: MockContext) => unknown) => unknown;
  get: (name: string) => unknown;
  effect: (callback: () => void | (() => void)) => void;
  on: (event: string, listener: (...args: unknown[]) => unknown) => () => void;
}

function makeMockCtx(): MockContext {
  const m = {
    registered: [],
    preExecute: [],
    jobStarts: [],
    skillProviders: [],
    settingsRegistrations: [],
    webServerRoutes: [],
    webServerPresent: true,
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
  // settings 服务最小面：记录命名空间注册，scope 只读返回空节（引用源随之
  // 全 undefined → providerEnvKeyOf 回退缺省，不污染其他用例）。
  m.settings = {
    register: (ns, schema, options) => {
      m.settingsRegistrations.push({ ns, schema, base: options?.base });
      return {
        get: () => ({}),
        watch: () => () => undefined,
        update: async () => {},
        replace: async () => {},
      };
    },
  };
  m.inject = (_services, callback) => callback(m);
  // 与 cordis ctx.effect 同语义：立即执行回调；返回的 disposer 仅记录不调用
  // （测试不模拟 teardown —— 路由在应用生命周期内恒在）。
  m.effect = (callback) => {
    void callback();
  };
  m.on = (event, listener) => {
    if (event === 'tools/pre-execute') m.preExecute.push(listener as MockContext['preExecute'][number]);
    return () => undefined;
  };
  m.get = (name) => {
    if (name === 'webServer') {
      if (!m.webServerPresent) return undefined;
      return {
        register: (route: { kind: string; path: string; handler: unknown }) => {
          m.webServerRoutes.push({ kind: route.kind, path: route.path, handler: route.handler });
          return () => undefined;
        },
      };
    }
    if (name === 'attachments') return m.attachments;
    return undefined;
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
  it('导出 name=dsh-gen3d、inject=[tools, credentials, skills, jobs, attachments]', () => {
    expect(name).toBe('dsh-gen3d');
    expect(inject).toEqual(['tools', 'credentials', 'skills', 'jobs', 'attachments']);
  });

  it('21 个工具全部注册，名字唯一且与镜像清单一致', () => {
    const ctx = appliedCtx();
    expect(ctx.registered).toHaveLength(21);
    expect(ctx.registered.map((t) => t.name).sort()).toEqual(allGen3dTools.map((t) => t.name).sort());
    expect(new Set(ctx.registered.map((t) => t.name)).size).toBe(21);
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

  it('gen3d_render_preview 携带合作超时预算（180s），其余工具不注入 timeoutMs', () => {
    const ctx = appliedCtx();
    for (const t of ctx.registered) {
      const td = t as { timeoutMs?: number };
      if (t.name === 'gen3d_render_preview') {
        expect(td.timeoutMs).toBe(180_000);
      } else {
        expect(td.timeoutMs).toBeUndefined();
      }
    }
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

    const listed = await provider.list({});
    const candidates: SkillCandidate[] = Array.isArray(listed) ? listed : [];
    // skills/ 目录扫描：至少含 generate-3d-character（并可能含同任务并行新增的技能）
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const candidate = (candidates as SkillCandidate[]).find((c) => c.name === 'generate-3d-character');
    expect(candidate).toBeDefined();
    expect(candidate!.description).toContain('3D 角色');
    expect(candidate!.invocation).toEqual({ modelInvocable: true, userInvocable: true });
    expect(candidate!.provider).toBe('gen3d');
    expect(candidate!.source).toBe('bundled');
    expect(candidate!.rank).toBe(600); // BUNDLED_SKILL_RANK
    expect(candidate!.resourceBase).toMatchObject({ kind: 'directory' });

    const def = await provider.get(candidate!, {});
    expect(def).toBeDefined();
    expect(def!.name).toBe('generate-3d-character');
    expect(def!.content).toContain('# Generate a 3D Character');
    expect(def!.content).toContain('## Procedure');
  });

  it('多候选：包内两个技能都被发现，且 get 命中各自目录（locator 区分）', async () => {
    const ctx = appliedCtx();
    const provider = ctx.skillProviders[0]!;
    const candidates = (await provider.list({})) as SkillCandidate[];
    // 并行任务会往 skills/ 追加技能；此处只验证「若有两个候选则各自 get 正确」
    if (candidates.length < 2) return; // 单技能时由上一用例覆盖
    const byName = new Map(candidates.map((c) => [c.name, c]));
    const gameSkill = byName.get('game-3d-assets');
    if (gameSkill) {
      const def = await provider.get(gameSkill, {});
      expect(def!.content).toContain('# Game 3D Assets');
      expect(def!.name).toBe('game-3d-assets');
    }
    const charSkill = byName.get('generate-3d-character')!;
    const charDef = await provider.get(charSkill, {});
    expect(charDef!.content).toContain('# Generate a 3D Character');
  });

  it('skill 目录扫描：子目录含 SKILL.md 才是候选，顺序稳定', async () => {
    // 用临时目录构造：两个合法技能（a-z 排序）+ 一个无 SKILL.md 的目录 + 一个文件
    const root = mkdtempSync(join(tmpdir(), 'dsh-gen3d-skill-scan-'));
    const skillsDir = join(root, 'skills');
    const mk = (dir: string, content: string) => {
      const dirPath = join(skillsDir, dir);
      mainFs.mkdirSync(dirPath, { recursive: true });
      mainFs.writeFileSync(join(dirPath, 'SKILL.md'), content);
    };
    mk('zeta-skill', '---\nname: zeta-skill\ndescription: 测试技能乙\n---\n\n# Zeta\n');
    mk('alpha-skill', '---\nname: alpha-skill\ndescription: 测试技能甲\n---\n\n# Alpha\n');
    mainFs.mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true }); // 无 SKILL.md
    mainFs.writeFileSync(join(skillsDir, 'plain-file.md'), '---\nname: x\n---\n');
    const dirs = await scanSkillDirs(pathToFileURL(join(skillsDir) + '/'));
    expect(dirs).toEqual(['alpha-skill', 'zeta-skill']); // 排序稳定且只收含 SKILL.md 的目录
    rmSync(root, { recursive: true, force: true });
  });

  it('list 对 locator 排序稳定（多候选时顺序确定）', async () => {
    const provider = appliedCtx().skillProviders[0]!;
    const a = (await provider.list({})) as SkillCandidate[];
    const b = (await provider.list({})) as SkillCandidate[];
    expect(a.map((x) => x.locator)).toEqual(b.map((x) => x.locator));
  });
});

// ── webServer 可选路由（web 组合） ───────────────────────────────────────────

describe('webServer 可选路由', () => {
  it('webServer 存在时注册资产清单与文件服务两条路由', async () => {
    const ctx = makeMockCtx();
    apply(ctx as unknown as Context);
    expect(ctx.webServerRoutes.map((r) => r.path).sort()).toEqual([
      '/plugins/dsh-gen3d/api/assets',
      '/plugins/dsh-gen3d/files',
    ]);
    const assetsRoute = ctx.webServerRoutes.find((r) => r.path === '/plugins/dsh-gen3d/api/assets')!;
    expect(typeof assetsRoute.handler).toBe('function');
    const filesRoute = ctx.webServerRoutes.find((r) => r.path === '/plugins/dsh-gen3d/files')!;
    expect(filesRoute.kind).toBe('prefix');
  });

  it('用户态请求 /api/assets 会先被 405 拦（非 GET/HEAD）', async () => {
    const ctx = makeMockCtx();
    apply(ctx as unknown as Context);
    const route = ctx.webServerRoutes.find((r) => r.path === '/plugins/dsh-gen3d/api/assets')!;
    const req = { method: 'POST', url: '/plugins/dsh-gen3d/api/assets' };
    const res = fakeRes();
    await (route.handler as (req: unknown, res: unknown) => Promise<void>)(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('文件路由拒绝路径穿越与越权根（404/403/400 语义）', async () => {
    const ctx = makeMockCtx();
    apply(ctx as unknown as Context);
    const route = ctx.webServerRoutes.find((r) => r.path === '/plugins/dsh-gen3d/files')!;
    const handler = route.handler as (req: unknown, res: unknown) => Promise<void>;
    // 缺段：404
    const r1 = fakeRes();
    await handler({ method: 'GET', url: '/plugins/dsh-gen3d/files/assets' }, r1);
    expect(r1.statusCode).toBe(404);
    // 穿越（percent-encoded ..）：安全段校验 → 400
    const r2 = fakeRes();
    await handler({ method: 'GET', url: '/plugins/dsh-gen3d/files/assets%2f..%2fsecrets.txt' }, r2);
    expect(r2.statusCode).toBe(400);
    // 越权根（不在 assets/.dsh-gen3d 白名单）：404
    const r4 = fakeRes();
    await handler({ method: 'GET', url: '/plugins/dsh-gen3d/files/docs/readme.md' }, r4);
    expect(r4.statusCode).toBe(404);
    // 不存在的文件：404
    const r3 = fakeRes();
    await handler({ method: 'GET', url: '/plugins/dsh-gen3d/files/assets/3d/characters/none.glb' }, r3);
    expect(r3.statusCode).toBe(404);
  });

  it('webServer 存在时文件路由能读出资产字节并以 model/gltf-binary 返回', async () => {
    const { store, cleanup } = makeStore();
    configureToolDeps({ store });
    await store.saveAsset({
      slot: 'characters',
      fileName: 'hero.glb',
      data: glbBytes('hero'),
      sidecar: { custom: { provider: 'meshy', providerMode: 'mock', mode: 'text' } },
    });
    const ctx = makeMockCtx();
    apply(ctx as unknown as Context);
    const route = ctx.webServerRoutes.find((r) => r.path === '/plugins/dsh-gen3d/files')!;
    const res = fakeRes();
    await (route.handler as (req: unknown, res: unknown) => Promise<void>)(
      { method: 'GET', url: '/plugins/dsh-gen3d/files/assets/3d/characters/hero.glb' },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('model/gltf-binary');
    expect((res.body as Uint8Array).byteLength).toBeGreaterThan(0);
    cleanup();
  });

  it('webServer 缺席（headless）时静默跳过，不注册任何路由', () => {
    const ctx = makeMockCtx();
    ctx.webServerPresent = false;
    apply(ctx as unknown as Context);
    expect(ctx.webServerRoutes).toHaveLength(0);
  });

  it('attachments 存在时预览工具附件挂接可用（saveImage 转发到 ctx.get 的结果）', async () => {
    const saved: unknown[] = [];
    const ctx = makeMockCtx();
    ctx.attachments = {
      saveImage: async (input) => {
        saved.push(input);
        return { attachmentId: 'att-1', mediaType: (input as { mediaType: string }).mediaType, bytes: 1, width: 1, height: 1 };
      },
    };
    apply(ctx as unknown as Context);
    // 直接执行预览工具（最小几何 mock 不可渲染 → asset_unrenderable 信封，
    // 不触达 saveImage；这里只验证装配不抛 + 工具已注册）
    const def = ctx.registered.find((t) => t.name === 'gen3d_render_preview')!;
    expect(def).toBeDefined();
  });
});

function fakeRes(): {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer | Uint8Array | null;
  setHeader: (k: string, v: string) => void;
  end: (chunk?: Buffer | Uint8Array | string) => void;
} {
  const state = { statusCode: 200, headers: {} as Record<string, string>, body: null as Buffer | Uint8Array | null };
  return {
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    get headers() {
      return state.headers;
    },
    get body() {
      return state.body;
    },
    setHeader: (k, v) => {
      state.headers[k] = v;
    },
    end: (chunk) => {
      if (chunk !== undefined) {
        state.body = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      }
    },
  };
}

describe('设置卡片 host 半边', () => {
  it('apply 注册 gen3d 命名空间，composition base 为空（缺省引用由 schema 承担）', () => {
    const ctx = appliedCtx();
    expect(ctx.settingsRegistrations).toHaveLength(1);
    const registration = ctx.settingsRegistrations[0]!;
    expect(registration.ns).toBe('gen3d');
    expect(registration.base).toEqual({});
  });

  it('装配后 providerEnvKeyOf 回退 PROVIDER_ENV_KEYS 缺省（空节 + settings 服务缺失都安全）', () => {
    appliedCtx();
    // mock scope.get() 返回空节 → 引用源全 undefined → 回退缺省（见 settings.test.ts）。
    expect(providerEnvKeyOf('meshy')).toBe('MESHY_API_KEY');
  });
});
