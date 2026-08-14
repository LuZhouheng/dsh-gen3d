// 公共契约单测：错误码全集、ProviderError 语义、fetch 注入解析、接口可用性。
// 全程无网络（fetch 仅检查注入行为）。

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_ERROR_CODES,
  ProviderError,
  isProviderError,
  resolveFetchImpl,
  type Gen3dProvider,
  type TaskHandle,
} from '../src/providers/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PROVIDER_ERROR_CODES', () => {
  it('错误码全集与公共约定一致（9 个 provider_*）', () => {
    expect(PROVIDER_ERROR_CODES).toEqual([
      'provider_bad_request',
      'provider_unauthorized',
      'provider_insufficient_credits',
      'provider_rate_limited',
      'provider_queue_full',
      'provider_timeout',
      'provider_http_error',
      'provider_empty_download',
      'provider_not_configured',
    ]);
  });
});

describe('ProviderError', () => {
  it('是 Error 实例，携带 code / name / retryable', () => {
    const err = new ProviderError({ code: 'provider_unauthorized' });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe('ProviderError');
    expect(err.code).toBe('provider_unauthorized');
    expect(err.message).toBe('provider_unauthorized'); // 未给 message 时默认 code
    expect(err.retryable).toBe(false);
    expect(err.httpStatus).toBeUndefined();
  });

  it('按错误码给出可重试默认值', () => {
    expect(new ProviderError({ code: 'provider_rate_limited' }).retryable).toBe(true);
    expect(new ProviderError({ code: 'provider_timeout' }).retryable).toBe(true);
    expect(new ProviderError({ code: 'provider_queue_full' }).retryable).toBe(true);
    expect(new ProviderError({ code: 'provider_bad_request' }).retryable).toBe(false);
    expect(new ProviderError({ code: 'provider_empty_download' }).retryable).toBe(false);
    expect(new ProviderError({ code: 'provider_not_configured' }).retryable).toBe(false);
  });

  it('http_error 按状态码判定可重试（5xx / 429 可重试，其他 4xx 不可）', () => {
    expect(new ProviderError({ code: 'provider_http_error', httpStatus: 503 }).retryable).toBe(true);
    expect(new ProviderError({ code: 'provider_http_error', httpStatus: 429 }).retryable).toBe(true); // 429 本质是限流
    expect(new ProviderError({ code: 'provider_http_error', httpStatus: 400 }).retryable).toBe(false);
    expect(new ProviderError({ code: 'provider_http_error' }).retryable).toBe(true); // 无状态码默认可重试
  });

  it('显式 retryable 覆盖默认值；cause 透传', () => {
    const cause = new Error('boom');
    const err = new ProviderError({
      code: 'provider_http_error',
      httpStatus: 400,
      retryable: true,
      cause,
      message: 'bad shape',
    });
    expect(err.retryable).toBe(true);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('bad shape');
  });

  it('isProviderError 守卫正确区分 ProviderError 与其他异常', () => {
    expect(isProviderError(new ProviderError({ code: 'provider_timeout' }))).toBe(true);
    expect(isProviderError(new Error('plain'))).toBe(false);
    expect(isProviderError('string')).toBe(false);
    expect(isProviderError(undefined)).toBe(false);
  });
});

describe('resolveFetchImpl', () => {
  it('优先使用注入的 fetchImpl', async () => {
    const injected = vi.fn(async () => new Response('{}'));
    const resolved = resolveFetchImpl(injected);
    expect(resolved).toBe(injected);
    await resolved('https://example.test/x');
    expect(injected).toHaveBeenCalledOnce();
  });

  it('未注入时回退原生全局 fetch', () => {
    const resolved = resolveFetchImpl();
    expect(typeof resolved).toBe('function'); // 原生 fetch（有全局 fetch 的环境）
    // 不真发请求：只验证形态
  });

  it('既无注入又无全局 fetch 时显式抛 provider_not_configured', () => {
    vi.stubGlobal('fetch', undefined);
    let caught: unknown;
    try {
      resolveFetchImpl();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderError);
    expect((caught as ProviderError).code).toBe('provider_not_configured');
  });
});

describe('Gen3dProvider 接口可用性', () => {
  it('最小实现：只有提交与轮询；可选能力探测为 false', async () => {
    const provider: Gen3dProvider = {
      id: 'meshy',
      isConfigured: () => false,
      async submitGeneration(req) {
        expect(req.mode).toBe('text');
        return { provider: 'meshy', taskId: 'task-1' } satisfies TaskHandle;
      },
      async pollTask(handle) {
        expect(handle.taskId).toBe('task-1');
        return { status: 'succeeded', downloads: { glb: 'https://cdn.test/x.glb' } };
      },
    };
    expect(provider.isConfigured()).toBe(false);
    expect('submitRig' in provider).toBe(false);
    expect('listMotions' in provider).toBe(false);
    const handle = await provider.submitGeneration({ mode: 'text', prompt: '一个武士' });
    expect(handle.provider).toBe('meshy');
    const result = await provider.pollTask(handle);
    expect(result.status).toBe('succeeded');
    expect(result.downloads.glb).toBe('https://cdn.test/x.glb');
  });

  it('完整实现：全部可选能力齐备', async () => {
    const provider: Gen3dProvider = {
      id: 'hunyuan3d',
      isConfigured: () => true,
      async submitGeneration() {
        return { provider: 'hunyuan3d', taskId: 'h1' };
      },
      async pollTask() {
        return { status: 'pending', downloads: {} };
      },
      async submitRig() {
        return { provider: 'hunyuan3d', taskId: 'rig-1' };
      },
      async submitAnimation() {
        return { provider: 'hunyuan3d', taskId: 'anim-1' };
      },
      async listMotions() {
        return [{ id: 'walk', label: '步行' }];
      },
      async getBalance() {
        return { balance: 100, currency: 'CNY' };
      },
    };
    expect('submitRig' in provider).toBe(true);
    expect('submitAnimation' in provider).toBe(true);
    expect('listMotions' in provider).toBe(true);
    expect('getBalance' in provider).toBe(true);
    expect((await provider.listMotions?.())?.[0]?.label).toBe('步行');
    expect((await provider.getBalance?.())?.balance).toBe(100);
  });
});
