/**
 * MeshyProvider 单测：全部 mock fetch（真实 Response 对象），不打真网。
 *
 * 覆盖：认证头、text-to-3d 两阶段流转、image/multi-image（含 smart-topology）、
 * rigging（basic_animations / expires_at）、animations（post_process）、balance、
 * 轮询成功/失败/超时/取消、错误映射（httpStatus/retryable）、GLB magic 校验、
 * 未配置 key 抛 provider_not_configured、统一 Gen3dProvider 接口
 * （submitGeneration / submitRig / submitAnimation / listMotions / getBalance）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProviderError, type FetchLike } from './types.js'
import {
  DEFAULT_POLL_INTERVAL_MS,
  MESHY_BASE_URL,
  MeshyProvider,
  type MeshyTaskHandle,
} from './meshy.js'
import { MESHY_ACTIONS } from '../legacy/shared/meshy-actions.js'

const KEY = 'test-meshy-key-123'
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bytesResp(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status })
}

interface Route {
  test: RegExp
  handler: (url: string, init?: RequestInit) => Response
}

/** RequestInit.headers 是 HeadersInit 联合类型，取 Authorization 需要收窄 */
function authOf(init?: RequestInit): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined
  return headers?.Authorization
}

/** RequestInit.body 是 BodyInit 联合类型；测试中始终为 JSON 字符串 */
function bodyOf(init?: RequestInit): string {
  return typeof init?.body === 'string' ? init.body : '{}'
}

/** 简易路由式 fetch mock：记录全部调用（含解析后的 body），未注册的 URL 直接失败 */
function mockFetch(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input)
    const body =
      typeof init?.body === 'string' && init.body !== ''
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined
    calls.push({ url, init, body })
    const hit = routes.find((r) => r.test.test(url))
    if (!hit) throw new Error(`测试未注册的 URL：${url}`)
    return hit.handler(url, init)
  }
  return { fetchImpl, calls }
}

function handle(taskId: string, kind: MeshyTaskHandle['kind'] = 'text-to-3d-preview'): MeshyTaskHandle {
  return { provider: 'meshy', taskId, kind, createdAtMs: 0 }
}

beforeEach(() => {
  process.env.MESHY_API_KEY = KEY
})

afterEach(() => {
  delete process.env.MESHY_API_KEY
})

describe('认证与配置', () => {
  it('submit / 轮询 / balance 都带 Bearer 认证头', async () => {
    const TASK = 'auth-task-1'
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v2\/text-to-3d$/, handler: () => jsonResp({ result: TASK }, 202) },
      {
        test: /\/openapi\/v2\/text-to-3d\/auth-task-1$/,
        handler: () => jsonResp({ id: TASK, status: 'SUCCEEDED', model_urls: {} }),
      },
      { test: /\/openapi\/v1\/balance$/, handler: () => jsonResp({ balance: 42 }) },
    ])
    const provider = new MeshyProvider({ fetchImpl, sleep: async () => {} })

    await provider.textTo3dPreview({ prompt: 'knight' })
    const submitCall = calls.find((c) => c.url.endsWith('/openapi/v2/text-to-3d'))
    expect(authOf(submitCall?.init)).toBe(`Bearer ${KEY}`)

    // 轮询 GET 也带认证头（该任务无资产，轮询成功后抛 provider_empty_download）
    await expect(provider.pollTask(handle(TASK, 'text-to-3d-refine'))).rejects.toMatchObject({
      code: 'provider_empty_download',
    })
    const pollCall = calls.find((c) => c.url.includes('/openapi/v2/text-to-3d/auth-task-1'))
    expect(authOf(pollCall?.init)).toBe(`Bearer ${KEY}`)

    await expect(provider.balance()).resolves.toBe(42)
    const balanceCall = calls.find((c) => c.url.endsWith('/openapi/v1/balance'))
    expect(balanceCall?.url).toBe(`${MESHY_BASE_URL}/openapi/v1/balance`)
    expect(authOf(balanceCall?.init)).toBe(`Bearer ${KEY}`)
  })

  it('未配置 key：所有提交/轮询/余额方法抛 provider_not_configured，且不发请求', async () => {
    delete process.env.MESHY_API_KEY
    const fetchImpl: FetchLike = async () => {
      throw new Error('不应发起任何请求')
    }
    const provider = new MeshyProvider({ fetchImpl })
    expect(provider.isConfigured()).toBe(false)
    await expect(provider.textTo3dPreview({ prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.textTo3dRefine({ previewTaskId: 'pv' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.imageTo3d({ imageUrl: 'https://x/y.png' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.multiImageTo3d({ imageUrls: ['https://x/a.png'] })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.rigging({ modelUrl: 'https://x/c.glb' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.animations({ rigTaskId: 'r', actionId: 92 })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.balance()).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.pollTask(handle('any'))).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
  })
})

describe('提交：text-to-3d 两阶段', () => {
  it('preview → refine 请求体与任务句柄正确', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        test: /\/openapi\/v2\/text-to-3d$/,
        handler: (_url, init) => {
          const body = JSON.parse(bodyOf(init)) as { mode?: string }
          return jsonResp({ result: body.mode === 'preview' ? 'pv-task-1' : 'rf-task-1' }, 202)
        },
      },
    ])
    const provider = new MeshyProvider({ fetchImpl })

    const preview = await provider.textTo3dPreview({
      prompt: 'a cartoon knight character, full body',
      poseMode: 'a-pose',
      aiModel: 'meshy-6',
      targetFormats: ['glb'],
    })
    expect(preview.taskId).toBe('pv-task-1')
    expect(preview.kind).toBe('text-to-3d-preview')
    expect(preview.provider).toBe('meshy')
    const pvBody = calls[0]?.body ?? {}
    expect(pvBody).toMatchObject({
      mode: 'preview',
      prompt: 'a cartoon knight character, full body',
      pose_mode: 'a-pose',
      ai_model: 'meshy-6',
      target_formats: ['glb'],
    })

    const refine = await provider.textTo3dRefine({
      previewTaskId: 'pv-task-1',
      enablePbr: true,
      textureResolution: '4k',
    })
    expect(refine.taskId).toBe('rf-task-1')
    expect(refine.kind).toBe('text-to-3d-refine')
    const rfBody = calls[1]?.body ?? {}
    expect(rfBody).toMatchObject({
      mode: 'refine',
      preview_task_id: 'pv-task-1',
      enable_pbr: true,
      texture_resolution: '4k',
    })
  })

  it('preview 本地校验：空 prompt / 超长 prompt 抛 provider_bad_request', async () => {
    const provider = new MeshyProvider({})
    await expect(provider.textTo3dPreview({ prompt: '   ' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.textTo3dPreview({ prompt: 'x'.repeat(601) })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.textTo3dRefine({ previewTaskId: '' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('submit 202 响应缺 result 抛 provider_http_error', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/openapi\/v2\/text-to-3d$/, handler: () => jsonResp({}, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.textTo3dPreview({ prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_http_error',
    })
  })
})

describe('提交：image / multi-image（含 smart-topology 低模）', () => {
  it('image-to-3d：image_url 直传', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/image-to-3d$/, handler: () => jsonResp({ result: 'img-1' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    const h = await provider.imageTo3d({ imageUrl: 'https://example.com/character.png', aiModel: 'meshy-6' })
    expect(h.kind).toBe('image-to-3d')
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({ image_url: 'https://example.com/character.png', ai_model: 'meshy-6' })
  })

  it('image-to-3d smart-topology：ai_model 强制 meshy-t2、剥离 remesh、t2 面数钳制 100–15,000', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/image-to-3d$/, handler: () => jsonResp({ result: 'img-2' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await provider.imageTo3d({
      imageUrl: 'https://example.com/a.png',
      modelType: 'smart-topology',
      aiModel: 'meshy-6',
      shouldRemesh: true,
      targetPolycount: 20_000,
    })
    const body = calls[0]?.body ?? {}
    expect(body.model_type).toBe('smart-topology')
    expect(body.ai_model).toBe('meshy-t2')
    expect(body.target_polycount).toBe(15_000) // t2 上限 15,000
    expect(body.should_remesh).toBeUndefined()

    // input_task_id 优先于 image_url
    await provider.imageTo3d({ imageUrl: 'https://example.com/b.png', inputTaskId: 'img-task-9' })
    const body2 = calls[1]?.body ?? {}
    expect(body2.input_task_id).toBe('img-task-9')
    expect(body2.image_url).toBeUndefined()
  })

  it('multi-image-to-3d：1–4 张校验与 image_urls 直传', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/multi-image-to-3d$/, handler: () => jsonResp({ result: 'mv-1' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    const h = await provider.multiImageTo3d({ imageUrls: ['https://x/f.png', 'https://x/s.png'] })
    expect(h.kind).toBe('multi-image-to-3d')
    const body = calls[0]?.body ?? {}
    expect(body.image_urls).toEqual(['https://x/f.png', 'https://x/s.png'])

    await expect(provider.multiImageTo3d({ imageUrls: [] })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.multiImageTo3d({ imageUrls: ['1', '2', '3', '4', '5'] })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.imageTo3d({})).rejects.toMatchObject({ code: 'provider_bad_request' })
  })
})

describe('提交：auto-rigging / animations', () => {
  it('rigging：model_url 路径 + height_meters', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/rigging$/, handler: () => jsonResp({ result: 'rig-1' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    const h = await provider.rigging({ modelUrl: 'https://example.com/character.glb', heightMeters: 1.6 })
    expect(h.kind).toBe('rig')
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({
      model_url: 'https://example.com/character.glb',
      height_meters: 1.6,
    })

    // input_task_id 优先；height_meters 官方要求正数，0/负数本地校验拒绝
    await provider.rigging({ inputTaskId: 't-3' })
    const body2 = calls[1]?.body ?? {}
    expect(body2.input_task_id).toBe('t-3')
    expect(body2.height_meters).toBeUndefined()
    await expect(provider.rigging({ inputTaskId: 't-3', heightMeters: 0 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.rigging({ inputTaskId: 't-3', heightMeters: -1 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.rigging({})).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('animations：rig_task_id + action_id + post_process；非法输入本地校验', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/animations$/, handler: () => jsonResp({ result: 'an-1' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    const h = await provider.animations({
      rigTaskId: 'rig-1',
      actionId: 92,
      postProcess: { operationType: 'change_fps', fps: 24 },
    })
    expect(h.kind).toBe('animate')
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({
      rig_task_id: 'rig-1',
      action_id: 92,
      post_process: { operation_type: 'change_fps', fps: 24 },
    })

    await expect(provider.animations({ rigTaskId: '', actionId: 1 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.animations({ rigTaskId: 'r', actionId: -1 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(
      provider.animations({ rigTaskId: 'r', actionId: 1, postProcess: { operationType: 'change_fps' } }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.animations({
        rigTaskId: 'r',
        actionId: 1,
        postProcess: { operationType: 'fbx2usdz', fps: 30 },
      }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })
})

describe('balance', () => {
  it('返回剩余积分', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/balance$/, handler: () => jsonResp({ balance: 1000 }) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.balance()).resolves.toBe(1000)
    expect(calls[0]?.url).toBe(`${MESHY_BASE_URL}/openapi/v1/balance`)
  })

  it('响应缺 balance 字段抛 provider_http_error', async () => {
    const { fetchImpl } = mockFetch([{ test: /balance$/, handler: () => jsonResp({}) }])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.balance()).rejects.toMatchObject({ code: 'provider_http_error' })
  })
})

describe('轮询', () => {
  it('成功：PENDING → IN_PROGRESS → SUCCEEDED，下载资产并校验 GLB magic', async () => {
    const TASK = 'poll-ok-1'
    let pollCount = 0
    const { fetchImpl, calls } = mockFetch([
      {
        test: /\/openapi\/v2\/text-to-3d\/poll-ok-1$/,
        handler: () => {
          pollCount += 1
          if (pollCount < 3) {
            return jsonResp({ id: TASK, status: 'IN_PROGRESS', progress: pollCount * 40 })
          }
          return jsonResp({
            id: TASK,
            type: 'text-to-3d-refine',
            status: 'SUCCEEDED',
            progress: 100,
            model_urls: {
              glb: 'https://cdn.example.com/m.glb',
              fbx: 'https://cdn.example.com/m.fbx',
            },
            thumbnail_url: 'https://cdn.example.com/m.png',
            texture_urls: [{ base_color: 'https://cdn.example.com/base.png' }],
            consumed_credits: 12,
          })
        },
      },
      {
        test: /^https:\/\/cdn\.example\.com\//,
        handler: (url) => (url.includes('.glb') ? bytesResp(GLB_BYTES) : bytesResp(PNG_BYTES)),
      },
    ])
    const provider = new MeshyProvider({ fetchImpl, sleep: async () => {} })

    const result = await provider.pollTask(handle(TASK, 'text-to-3d-refine'), { intervalMs: 0 })
    expect(result.status).toBe('succeeded')
    expect(result.taskId).toBe(TASK)
    expect(result.files.map((f) => f.role)).toEqual(['glb', 'fbx', 'thumbnail', 'base_color'])
    expect(result.files[0]?.format).toBe('glb')
    expect(result.files[0]?.buffer).toEqual(GLB_BYTES)
    expect(result.modelUrls.glb).toBe('https://cdn.example.com/m.glb')
    expect(result.consumedCredits).toBe(12)
    expect(result.expiresAtMs).toBeUndefined() // text-to-3d 任务对象官方未记载 expires_at
    expect((result.raw as { consumed_credits: number }).consumed_credits).toBe(12)
    expect((result.raw as { status: string }).status).toBe('SUCCEEDED')
    expect(pollCount).toBe(3)

    // 契约形状投影：downloads 只含 URL（字节在 files 里）
    expect(result.downloads).toEqual({
      glb: 'https://cdn.example.com/m.glb',
      fbx: 'https://cdn.example.com/m.fbx',
      textureUrls: ['https://cdn.example.com/base.png'],
      previewImage: 'https://cdn.example.com/m.png',
    })
  })

  it('失败终态立即抛：FAILED 带 task_error 信息，且不再继续轮询', async () => {
    const TASK = 'poll-fail-1'
    const pollHandler = vi.fn(() =>
      jsonResp({
        id: TASK,
        status: 'FAILED',
        task_error: { type: 'invalid_input', message: 'prompt too long', code: 'invalid_input' },
        consumed_credits: 0, // 失败退费
      }),
    )
    const { fetchImpl } = mockFetch([{ test: /\/text-to-3d\/poll-fail-1$/, handler: pollHandler }])
    const provider = new MeshyProvider({ fetchImpl, sleep: async () => {} })

    const error = await provider.pollTask(handle(TASK)).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'provider_bad_request', taskStatus: 'FAILED' })
    expect(isProviderError(error)).toBe(true)
    expect((error as Error).message).toContain('invalid_input: prompt too long [invalid_input]')
    expect(pollHandler).toHaveBeenCalledTimes(1) // 立即抛，不再轮询
  })

  it('CANCELED 终态立即抛', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/text-to-3d\/cancel-1$/, handler: () => jsonResp({ id: 'cancel-1', status: 'CANCELED' }) },
    ])
    const provider = new MeshyProvider({ fetchImpl, sleep: async () => {} })
    await expect(provider.pollTask(handle('cancel-1'))).rejects.toMatchObject({
      code: 'provider_http_error',
      taskStatus: 'CANCELED',
    })
  })

  it('超时：轮询超过 timeoutMs 抛 provider_timeout', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/text-to-3d\/slow-1$/, handler: () => jsonResp({ id: 'slow-1', status: 'IN_PROGRESS' }) },
    ])
    const provider = new MeshyProvider({ fetchImpl, sleep: async () => {} })
    await expect(provider.pollTask(handle('slow-1'), { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'provider_timeout',
      taskId: 'slow-1',
      retryable: true,
    })
  })

  it('默认轮询间隔 5s（可注入覆盖）', async () => {
    const TASK = 'poll-interval-1'
    const makeRoutes = () => {
      let pollCount = 0
      return [
        {
          test: /\/text-to-3d\/poll-interval-1$/,
          handler: () => {
            pollCount += 1
            if (pollCount === 1) return jsonResp({ id: TASK, status: 'IN_PROGRESS' })
            return jsonResp({ id: TASK, status: 'SUCCEEDED', model_urls: {} })
          },
        },
      ]
    }

    // 未显式传 intervalMs → 用 provider 默认 5000
    const sleepA = vi.fn(async (_ms: number) => {})
    const providerA = new MeshyProvider({ fetchImpl: mockFetch(makeRoutes()).fetchImpl, sleep: sleepA })
    await providerA.pollTask(handle(TASK)).catch(() => {})
    expect(sleepA.mock.calls[0]?.[0]).toBe(DEFAULT_POLL_INTERVAL_MS)

    // 显式 intervalMs 覆盖默认
    const sleepB = vi.fn(async (_ms: number) => {})
    const providerB = new MeshyProvider({ fetchImpl: mockFetch(makeRoutes()).fetchImpl, sleep: sleepB })
    await providerB.pollTask(handle(TASK), { intervalMs: 123 }).catch(() => {})
    expect(sleepB.mock.calls[0]?.[0]).toBe(123)
  })

  it('轮询支持 AbortSignal 取消（AbortError）', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/text-to-3d\/abort-1$/, handler: () => jsonResp({ id: 'abort-1', status: 'IN_PROGRESS' }) },
    ])
    let release: (() => void) | undefined
    const sleep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    const provider = new MeshyProvider({ fetchImpl, sleep })
    const controller = new AbortController()
    const pending = provider.pollTask(handle('abort-1'), { signal: controller.signal })
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled())
    controller.abort()
    release?.()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('轮询 GET 失败映射到契约错误码（含 taskId 与 httpStatus）', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/text-to-3d\/http-401$/, handler: () => jsonResp({ message: 'invalid credentials' }, 401) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.pollTask(handle('http-401'))).rejects.toMatchObject({
      code: 'provider_unauthorized',
      httpStatus: 401,
      taskId: 'http-401',
    })
  })
})

describe('下载校验', () => {
  const succeedWith = (modelUrls: Record<string, string>) => ({
    test: /\/text-to-3d\/dl-1$/,
    handler: () => jsonResp({ id: 'dl-1', status: 'SUCCEEDED', model_urls: modelUrls }),
  })

  it('GLB magic 校验失败抛 provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([
      succeedWith({ glb: 'https://cdn.example.com/bad.glb' }),
      {
        test: /^https:\/\/cdn\.example\.com\//,
        handler: () => bytesResp(new Uint8Array([0x01, 0x02, 0x03, 0x04])),
      },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-1'))).rejects.toMatchObject({
      code: 'provider_empty_download',
    })
  })

  it('空内容抛 provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([
      succeedWith({ glb: 'https://cdn.example.com/empty.glb' }),
      { test: /^https:\/\/cdn\.example\.com\//, handler: () => bytesResp(new Uint8Array(0)) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-1'))).rejects.toMatchObject({
      code: 'provider_empty_download',
    })
  })

  it('下载 HTTP 失败（签名 URL 过期）抛 provider_http_error', async () => {
    const { fetchImpl } = mockFetch([
      succeedWith({ glb: 'https://cdn.example.com/gone.glb' }),
      { test: /^https:\/\/cdn\.example\.com\//, handler: () => jsonResp({ message: 'gone' }, 404) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-1'))).rejects.toMatchObject({
      code: 'provider_http_error',
      httpStatus: 404,
    })
  })

  it('任务成功但无任何资产抛 provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([succeedWith({})])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-1'))).rejects.toMatchObject({
      code: 'provider_empty_download',
    })
  })
})

describe('错误映射（请求级）', () => {
  const cases: Array<{ status: number; message: string; expected: string }> = [
    { status: 400, message: 'bad param', expected: 'provider_bad_request' },
    { status: 401, message: 'invalid credentials', expected: 'provider_unauthorized' },
    { status: 402, message: 'insufficient balance', expected: 'provider_insufficient_credits' },
    { status: 403, message: 'forbidden', expected: 'provider_http_error' },
    { status: 404, message: 'task not found', expected: 'provider_bad_request' },
    { status: 429, message: 'RateLimitExceeded', expected: 'provider_rate_limited' },
    { status: 429, message: 'NoMoreConcurrentTasks', expected: 'provider_queue_full' },
    { status: 500, message: 'server error', expected: 'provider_http_error' },
    { status: 503, message: 'unavailable', expected: 'provider_http_error' },
  ]

  for (const c of cases) {
    it(`submit HTTP ${c.status}（${c.message}）→ ${c.expected}`, async () => {
      const { fetchImpl } = mockFetch([
        { test: /\/openapi\/v2\/text-to-3d$/, handler: () => jsonResp({ message: c.message }, c.status) },
      ])
      const provider = new MeshyProvider({ fetchImpl })
      const error = await provider.textTo3dPreview({ prompt: 'knight' }).catch((e: unknown) => e)
      expect(error).toMatchObject({ code: c.expected, httpStatus: c.status })
      expect(isProviderError(error)).toBe(true)
      expect((error as Error).message).toContain(c.message)
    })
  }

  it('429 语义：队列满不重试（官方要求等待），限频可重试', async () => {
    const queueFull = new MeshyProvider({
      fetchImpl: async () => jsonResp({ message: 'NoMoreConcurrentTasks' }, 429),
    })
    const rateLimited = new MeshyProvider({
      fetchImpl: async () => jsonResp({ message: 'RateLimitExceeded' }, 429),
    })
    await expect(queueFull.textTo3dPreview({ prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_queue_full',
      retryable: false,
    })
    await expect(rateLimited.textTo3dPreview({ prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_rate_limited',
      retryable: true,
    })
  })
})

describe('统一 Gen3dProvider 接口', () => {
  it('submitGeneration：text → preview；providerOptions 透传与 refine 路径', async () => {
    const { fetchImpl, calls } = mockFetch([
      {
        test: /\/openapi\/v2\/text-to-3d$/,
        handler: (_url, init) => {
          const body = JSON.parse(bodyOf(init)) as { mode?: string }
          return jsonResp({ result: body.mode === 'refine' ? 'rf-u' : 'pv-u' }, 202)
        },
      },
    ])
    const provider = new MeshyProvider({ fetchImpl })

    const preview = await provider.submitGeneration({
      mode: 'text',
      prompt: 'a knight',
      providerOptions: { ai_model: 'meshy-6', target_formats: ['glb'] },
    })
    expect(preview.taskId).toBe('pv-u')
    expect(preview.kind).toBe('text-to-3d-preview')
    const pvBody = calls[0]?.body ?? {}
    expect(pvBody).toMatchObject({ mode: 'preview', prompt: 'a knight', ai_model: 'meshy-6' })

    const refine = await provider.submitGeneration({
      mode: 'text',
      prompt: 'add texture',
      providerOptions: { mode: 'refine', preview_task_id: 'pv-u', enable_pbr: true },
    })
    expect(refine.kind).toBe('text-to-3d-refine')
    const rfBody = calls[1]?.body ?? {}
    expect(rfBody).toMatchObject({
      mode: 'refine',
      preview_task_id: 'pv-u',
      texture_prompt: 'add texture',
      enable_pbr: true,
    })
    expect(rfBody.ai_model).toBeUndefined() // 契约级字段不透传
  })

  it('submitGeneration：image / views 模式映射', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/image-to-3d$/, handler: () => jsonResp({ result: 'u-img' }, 202) },
      { test: /\/openapi\/v1\/multi-image-to-3d$/, handler: () => jsonResp({ result: 'u-mv' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })

    const img = await provider.submitGeneration({ mode: 'image', prompt: 'p', imageUrls: ['https://x/a.png'] })
    expect(img.kind).toBe('image-to-3d')
    expect(calls[0]?.body ?? {}).toMatchObject({ image_url: 'https://x/a.png' })

    const mv = await provider.submitGeneration({
      mode: 'views',
      prompt: 'p',
      imageUrls: ['https://x/1.png', 'https://x/2.png'],
    })
    expect(mv.kind).toBe('multi-image-to-3d')
    expect(calls[1]?.body ?? {}).toMatchObject({
      image_urls: ['https://x/1.png', 'https://x/2.png'],
    })
  })

  it('submitRig：assetUrl → model_url；providerOptions 透传', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/rigging$/, handler: () => jsonResp({ result: 'u-rig' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    const h = await provider.submitRig({ assetUrl: 'https://x/c.glb', providerOptions: { height_meters: 1.7 } })
    expect(h.kind).toBe('rig')
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({ model_url: 'https://x/c.glb', height_meters: 1.7 })
  })

  it('submitAnimation：actionId 数字转换 + post_process 归一化（snake_case 或 camelCase）', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/animations$/, handler: () => jsonResp({ result: 'u-an' }, 202) },
    ])
    const provider = new MeshyProvider({ fetchImpl })
    await provider.submitAnimation({
      rigTaskId: 'rig-u',
      actionId: '92',
      providerOptions: { post_process: { operation_type: 'change_fps', fps: 24 } },
    })
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({
      rig_task_id: 'rig-u',
      action_id: 92,
      post_process: { operation_type: 'change_fps', fps: 24 },
    })
  })

  it('getBalance：返回 BalanceInfo（含 raw）', async () => {
    const { fetchImpl } = mockFetch([{ test: /\/openapi\/v1\/balance$/, handler: () => jsonResp({ balance: 7 }) }])
    const provider = new MeshyProvider({ fetchImpl })
    await expect(provider.getBalance()).resolves.toEqual({ balance: 7, raw: { balance: 7 } })
  })

  it('listMotions：静态目录全部映射 + query 过滤（label/category/rigType 宽松匹配）', async () => {
    const provider = new MeshyProvider()
    const motions = await provider.listMotions()
    expect(motions.length).toBe(MESHY_ACTIONS.length) // 目录行全部映射，无丢弃
    expect(motions.length).toBeGreaterThan(670)
    for (const m of motions) {
      expect(Number.isInteger(m.id)).toBe(true)
      expect(typeof m.label).toBe('string')
    }
    expect(motions.find((m) => m.id === 0)).toMatchObject({
      id: 0,
      label: 'Idle',
      category: 'DailyActions',
      isFree: false,
    })
    expect(motions.find((m) => m.id === 92)?.label).toBe('Double_Combo_Attack')
    expect(motions.find((m) => m.id === 696)?.label).toBe('Walk_with_Walker_Support_inplace')
    const withPreview = motions.find((m) => m.previewUrl !== undefined)
    expect(withPreview?.previewUrl).toMatch(/^https:\/\/cdn\.meshy\.ai\//)
    expect(new Set(motions.map((m) => m.id)).size).toBe(motions.length)

    // query 过滤（rigType 未知 → 宽松匹配）
    const filtered = await provider.listMotions({ query: 'walk', category: 'WalkAndRun', rigType: 'style_02' })
    expect(filtered.length).toBeGreaterThan(0)
    for (const m of filtered) {
      expect(m.label.toLowerCase()).toContain('walk')
      expect(m.category).toBe('WalkAndRun')
    }
    const none = await provider.listMotions({ query: 'zzz-no-such-motion' })
    expect(none).toEqual([])
  })
})

describe('rig 结果：basic_animations 解析与 expires_at', () => {
  it('轮询成功：rigged_character glb/fbx + walk/run 动画分组 + expires_at 毫秒显式记录', async () => {
    const TASK = 'rig-done-1'
    const rigTask = {
      id: TASK,
      type: 'rig',
      status: 'SUCCEEDED',
      progress: 100,
      consumed_credits: 30,
      expires_at: 1_800_000_000_000, // 毫秒 epoch
      result: {
        rigged_character_glb_url: 'https://cdn.example.com/rigged.glb',
        rigged_character_fbx_url: 'https://cdn.example.com/rigged.fbx',
        basic_animations: {
          walking_glb_url: 'https://cdn.example.com/walk.glb',
          walking_fbx_url: 'https://cdn.example.com/walk.fbx',
          walking_armature_glb_url: 'https://cdn.example.com/walk-arm.glb',
          running_glb_url: 'https://cdn.example.com/run.glb',
          running_armature_glb_url: 'https://cdn.example.com/run-arm.glb',
        },
      },
    }
    const { fetchImpl, calls } = mockFetch([
      { test: /\/openapi\/v1\/rigging$/, handler: () => jsonResp({ result: TASK }, 202) },
      { test: /\/openapi\/v1\/rigging\/rig-done-1$/, handler: () => jsonResp(rigTask) },
      {
        test: /^https:\/\/cdn\.example\.com\//,
        handler: (url) => (url.includes('.glb') ? bytesResp(GLB_BYTES) : bytesResp(PNG_BYTES)),
      },
    ])
    const provider = new MeshyProvider({ fetchImpl, sleep: async () => {} })

    const h = await provider.rigging({ inputTaskId: 'src-1' })
    const result = await provider.pollTask(h, { intervalMs: 0 })
    expect(result.files.map((f) => f.role)).toEqual(['rigged_character_glb', 'rigged_character_fbx'])
    expect(result.expiresAtMs).toBe(1_800_000_000_000)
    expect(result.consumedCredits).toBe(30)
    expect(result.downloads.glb).toBe('https://cdn.example.com/rigged.glb')
    expect(result.downloads.fbx).toBe('https://cdn.example.com/rigged.fbx')

    expect(result.basicAnimations?.map((a) => a.category)).toEqual(['walking', 'running'])
    const walking = result.basicAnimations?.find((a) => a.category === 'walking')
    expect(walking?.files.map((f) => f.role)).toEqual(['walking_glb', 'walking_fbx', 'walking_armature_glb'])
    expect(walking?.files[0]?.buffer).toEqual(GLB_BYTES)
    const running = result.basicAnimations?.find((a) => a.category === 'running')
    expect(running?.files.map((f) => f.role)).toEqual(['running_glb', 'running_armature_glb'])

    // 轮询走 rigging 端点
    expect(calls.some((c) => c.url.includes('/openapi/v1/rigging/rig-done-1'))).toBe(true)
    // 下载不带认证头（签名 URL 直链）
    const downloadCall = calls.find((c) => c.url.includes('cdn.example.com/rigged.glb'))
    expect(authOf(downloadCall?.init)).toBeUndefined()
  })

  it('animate 结果：animation_glb/fbx + processed_* 角色解析', async () => {
    const TASK = 'an-done-1'
    const animateTask = {
      id: TASK,
      type: 'animate',
      status: 'SUCCEEDED',
      consumed_credits: 8,
      expires_at: 1_800_000_000_123,
      result: {
        animation_glb_url: 'https://cdn.example.com/an.glb',
        animation_fbx_url: 'https://cdn.example.com/an.fbx',
        processed_animation_fps_fbx_url: 'https://cdn.example.com/an-24.fbx',
      },
    }
    const { fetchImpl } = mockFetch([
      { test: /\/openapi\/v1\/animations$/, handler: () => jsonResp({ result: TASK }, 202) },
      { test: /\/openapi\/v1\/animations\/an-done-1$/, handler: () => jsonResp(animateTask) },
      {
        test: /^https:\/\/cdn\.example\.com\//,
        handler: (url) => (url.includes('.glb') ? bytesResp(GLB_BYTES) : bytesResp(PNG_BYTES)),
      },
    ])
    const provider = new MeshyProvider({ fetchImpl, sleep: async () => {} })

    const h = await provider.animations({ rigTaskId: 'rig-1', actionId: 92 })
    const result = await provider.pollTask(h, { intervalMs: 0 })
    expect(result.files.map((f) => f.role)).toEqual([
      'animation_glb',
      'animation_fbx',
      'processed_animation_fps_fbx',
    ])
    expect(result.expiresAtMs).toBe(1_800_000_000_123)
    expect(result.basicAnimations).toBeUndefined()
    expect(result.downloads.glb).toBe('https://cdn.example.com/an.glb')
  })
})
