/**
 * TripoProvider 单测：全部 mock fetch（真实 Response 对象），不打真网。
 *
 * 覆盖：认证头与未配置 key、统一入口 POST /task（type 区分任务）、text/image/
 * multiview 提交与请求体、upload/sts 上传、texture_model、绑骨三段（prerigcheck /
 * rig / retarget）、highpoly_to_lowpoly、16 个 preset 静态动作目录、balance、
 * 轮询 8 态状态机流转、失败终态映射、超时/取消、下载时序与 GLB magic 校验、
 * 下载 403 重查重试、错误映射（HTTP + code 双判定、Retry-After、Trace-ID）、
 * 统一 Gen3dProvider 接口（submitGeneration / submitRig / submitAnimation /
 * listMotions / getBalance）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isProviderError, type FetchLike } from './types.js'
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_MODEL_VERSION,
  P1_MODEL_VERSION,
  TRIPO_BASE_URL,
  TRIPO_MOTION_PRESETS,
  TripoProvider,
  type TripoTaskHandle,
  type TripoTaskType,
} from './tripo3d.js'

const KEY = 'test-tripo3d-key-123'
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function jsonResp(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
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

/** RequestInit.body 是 BodyInit 联合类型；测试中 JSON 请求始终为字符串 */
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

function handle(taskId: string, type: TripoTaskType = 'text_to_model'): TripoTaskHandle {
  return { provider: 'tripo3d', taskId, type, createdAtMs: 0 }
}

beforeEach(() => {
  process.env.TRIPO3D_API_KEY = KEY
})

afterEach(() => {
  delete process.env.TRIPO3D_API_KEY
})

describe('认证与配置', () => {
  it('submit / 轮询 / balance / upload 都带 Bearer 认证头', async () => {
    const TASK = 'auth-task-1'
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: TASK } }) },
      {
        test: /\/task\/auth-task-1$/,
        handler: () =>
          jsonResp({ code: 0, data: { task_id: TASK, status: 'success', progress: 100, output: {} } }),
      },
      { test: /\/user\/balance$/, handler: () => jsonResp({ code: 0, data: { balance: 42, frozen: 3 } }) },
      { test: /\/upload\/sts$/, handler: () => jsonResp({ code: 0, data: { image_token: 'tok-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl, sleep: async () => {} })

    await provider.textTo3d({ prompt: 'knight' })
    const submitCall = calls.find((c) => c.url.endsWith('/task'))
    expect(authOf(submitCall?.init)).toBe(`Bearer ${KEY}`)

    await provider.pollTask(handle(TASK)).catch(() => {})
    const pollCall = calls.find((c) => c.url.includes('/task/auth-task-1'))
    expect(authOf(pollCall?.init)).toBe(`Bearer ${KEY}`)

    await expect(provider.balance()).resolves.toEqual({ balance: 42, frozen: 3 })
    const balanceCall = calls.find((c) => c.url.endsWith('/user/balance'))
    expect(balanceCall?.url).toBe(`${TRIPO_BASE_URL}/user/balance`)
    expect(authOf(balanceCall?.init)).toBe(`Bearer ${KEY}`)

    await expect(provider.uploadImage(new Uint8Array([1, 2, 3]))).resolves.toBe('tok-1')
    const uploadCall = calls.find((c) => c.url.endsWith('/upload/sts'))
    expect(authOf(uploadCall?.init)).toBe(`Bearer ${KEY}`)
  })

  it('未配置 key：所有提交/轮询/余额/上传方法抛 provider_not_configured，且不发请求', async () => {
    delete process.env.TRIPO3D_API_KEY
    const fetchImpl: FetchLike = async () => {
      throw new Error('不应发起任何请求')
    }
    const provider = new TripoProvider({ fetchImpl })
    expect(provider.isConfigured()).toBe(false)
    await expect(provider.textTo3d({ prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.imageTo3d({ image: 'https://x/a.png' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(
      provider.multiviewTo3d({ images: ['https://x/f.png', 'https://x/r.png'] }),
    ).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.textureModel({ originalModelTaskId: 't-1', prompt: 'bronze' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.preRigCheck({ originalModelTaskId: 't-1' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.rigging({ originalModelTaskId: 't-1' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.retarget({ originalModelTaskId: 't-1', animation: 'preset:walk' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.highpolyToLowpoly({ originalModelTaskId: 't-1' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.uploadImage(new Uint8Array([1]))).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.balance()).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.pollTask(handle('any'))).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.submitRig({ assetUrl: 't-1' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(
      provider.submitAnimation({ rigTaskId: 't-1', actionId: 'preset:walk' }),
    ).rejects.toMatchObject({ code: 'provider_not_configured' })
  })
})

describe('提交：text_to_model', () => {
  it('统一入口 POST /task，请求体含 type / prompt / 默认 model_version，providerOptions 透传', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'text-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    const h = await provider.textTo3d({
      prompt: 'a stylized wooden chair',
      negativePrompt: 'low quality',
      seed: 42,
      providerOptions: { face_limit: 80_000, texture: false, smart_low_poly: true },
    })
    expect(h.taskId).toBe('text-1')
    expect(h.type).toBe('text_to_model')
    expect(h.provider).toBe('tripo3d')
    expect(calls[0]?.url).toBe(`${TRIPO_BASE_URL}/task`)
    const body = calls[0]?.body ?? {}
    expect(body.type).toBe('text_to_model')
    expect(body).toMatchObject({
      prompt: 'a stylized wooden chair',
      model_version: DEFAULT_MODEL_VERSION,
      negative_prompt: 'low quality',
      model_seed: 42,
      face_limit: 80_000,
      texture: false,
      smart_low_poly: true,
    })
  })

  it('model_version：显式传入 / providerOptions 覆盖（P1 低模）', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'text-2' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await provider.textTo3d({ prompt: 'knight', modelVersion: 'v2.5-20250123' })
    expect(calls[0]?.body?.model_version).toBe('v2.5-20250123')

    await provider.textTo3d({ prompt: 'lowpoly knight', providerOptions: { model_version: P1_MODEL_VERSION } })
    expect(calls[1]?.body?.model_version).toBe(P1_MODEL_VERSION)
  })

  it('本地校验：空 prompt / 超 1024 字符 / negative_prompt 超 255 抛 provider_bad_request', async () => {
    const provider = new TripoProvider({})
    await expect(provider.textTo3d({ prompt: '   ' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.textTo3d({ prompt: 'x'.repeat(1025) })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.textTo3d({ prompt: 'knight', negativePrompt: 'x'.repeat(256) })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('submit 响应缺 data.task_id 抛 provider_http_error', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: {} }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.textTo3d({ prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_http_error',
    })
  })
})

describe('提交：image_to_model / multiview_to_model', () => {
  it('image：URL → file.url；file_token → file.file_token；UUID 也按 file_token 处理', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'img-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })

    await provider.imageTo3d({ image: 'https://example.com/hero.png' })
    let body = calls[0]?.body ?? {}
    expect(body.type).toBe('image_to_model')
    expect(body.file).toEqual({ type: 'image', url: 'https://example.com/hero.png' })

    await provider.imageTo3d({ image: 'https://example.com/a.png', fileToken: 'tok-upload-1' })
    body = calls[1]?.body ?? {}
    expect(body.file).toEqual({ type: 'image', file_token: 'tok-upload-1' })

    await provider.imageTo3d({ image: 'ce85f375-3ccc-440b-b847-571588872ec2' })
    body = calls[2]?.body ?? {}
    expect(body.file).toEqual({ type: 'image', file_token: 'ce85f375-3ccc-440b-b847-571588872ec2' })
  })

  it('image：base64 / 本地路径 / 缺输入抛 provider_bad_request（官方无 base64 输入）', async () => {
    const provider = new TripoProvider({})
    await expect(provider.imageTo3d({ image: 'data:image/png;base64,AAAA' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.imageTo3d({ image: '/tmp/hero.png' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.imageTo3d({})).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('multiview：固定顺序 [front, left, back, right]，2–4 张校验', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'mv-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })

    await provider.multiviewTo3d({
      images: ['https://x/f.png', 'https://x/l.png', 'https://x/b.png', 'https://x/r.png'],
    })
    let body = calls[0]?.body ?? {}
    expect(body.type).toBe('multiview_to_model')
    expect(body.files).toEqual([
      { type: 'image', url: 'https://x/f.png' },
      { type: 'image', url: 'https://x/l.png' },
      { type: 'image', url: 'https://x/b.png' },
      { type: 'image', url: 'https://x/r.png' },
    ])

    // 2 张（front + 一个视角）允许；fileTokens 与 images 逐位对齐
    await provider.multiviewTo3d({ images: ['https://x/f.png', 'https://x/l.png'] })
    body = calls[1]?.body ?? {}
    expect((body.files as unknown[]).length).toBe(2)

    await expect(provider.multiviewTo3d({ images: ['https://x/f.png'] })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(
      provider.multiviewTo3d({ images: ['1', '2', '3', '4', '5'] }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('multiview：original_task_id 路径（免重复上传）', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'mv-2' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await provider.multiviewTo3d({ originalTaskId: 'gen-mv-task-9' })
    const body = calls[0]?.body ?? {}
    expect(body.original_task_id).toBe('gen-mv-task-9')
    expect(body.files).toBeUndefined()
  })
})

describe('uploadImage（/upload/sts 直传）', () => {
  it('multipart/form-data 上传返回 image_token；不手写 Content-Type', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/upload\/sts$/, handler: () => jsonResp({ code: 0, data: { image_token: 'tok-img-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    const token = await provider.uploadImage(new Uint8Array([1, 2, 3]), 'hero.png')
    expect(token).toBe('tok-img-1')
    const call = calls[0]
    expect(call?.url).toBe(`${TRIPO_BASE_URL}/upload/sts`)
    expect(call?.init?.body).toBeInstanceOf(FormData)
    const form = call?.init?.body as FormData
    expect(form.get('file')).toBeInstanceOf(Blob)
    // 不手写 Content-Type：fetch 自动带 multipart boundary
    const headers = call?.init?.headers as Record<string, string> | undefined
    expect(headers?.['Content-Type']).toBeUndefined()
  })

  it('upload 响应缺 image_token 抛 provider_http_error', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/upload\/sts$/, handler: () => jsonResp({ code: 0, data: {} }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.uploadImage(new Uint8Array([1]))).rejects.toMatchObject({
      code: 'provider_http_error',
    })
  })
})

describe('提交：texture_model（贴图精修）', () => {
  it('texture_prompt 三选一（text / image / images）+ style_image；默认版本 v3.0-20250812', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'tx-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })

    await provider.textureModel({
      originalModelTaskId: 'src-1',
      prompt: 'weathered bronze armor',
      styleImage: 'https://x/style.png',
    })
    let body = calls[0]?.body ?? {}
    expect(body.type).toBe('texture_model')
    expect(body).toMatchObject({
      original_model_task_id: 'src-1',
      model_version: 'v3.0-20250812',
      texture_prompt: {
        text: 'weathered bronze armor',
        style_image: { type: 'image', url: 'https://x/style.png' },
      },
    })

    await provider.textureModel({
      originalModelTaskId: 'src-1',
      images: ['https://x/ref1.png', { fileToken: 'tok-ref-2' }],
    })
    body = calls[1]?.body ?? {}
    expect(body.texture_prompt).toEqual({
      images: [
        { type: 'image', url: 'https://x/ref1.png' },
        { type: 'image', file_token: 'tok-ref-2' },
      ],
    })
  })

  it('texture_prompt 非三选一（缺 / 多选）抛 provider_bad_request', async () => {
    const provider = new TripoProvider({})
    await expect(provider.textureModel({ originalModelTaskId: 'src-1' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(
      provider.textureModel({ originalModelTaskId: 'src-1', prompt: 'a', image: 'https://x/a.png' }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(provider.textureModel({ originalModelTaskId: '', prompt: 'a' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })
})

describe('绑骨与动画（animate_prerigcheck → animate_rig → animate_retarget）', () => {
  it('preRigCheck：type=animate_prerigcheck + original_model_task_id', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'pre-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    const h = await provider.preRigCheck({ originalModelTaskId: 'src-1' })
    expect(h.type).toBe('animate_prerigcheck')
    expect(calls[0]?.body).toEqual({ type: 'animate_prerigcheck', original_model_task_id: 'src-1' })
  })

  it('rigging：默认 biped + 默认版本 v2.5-20260210 + spec 透传 + out_format', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'rig-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await provider.rigging({
      originalModelTaskId: 'src-1',
      outFormat: 'fbx',
      providerOptions: { spec: 'mixamo' },
    })
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({
      type: 'animate_rig',
      original_model_task_id: 'src-1',
      rig_type: 'biped',
      out_format: 'fbx',
      model_version: 'v2.5-20260210',
      spec: 'mixamo',
    })
  })

  it('rigging 本地校验：外部模型 URL / 空 id / 非法 rig_type 抛 provider_bad_request', async () => {
    const provider = new TripoProvider({})
    await expect(provider.rigging({ originalModelTaskId: 'https://x/c.glb' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.rigging({ originalModelTaskId: '' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.rigging({ originalModelTaskId: 'src-1', rigType: 'unicorn' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('retarget：单 preset 与 animations 数组（≤5）；非法预设 / 二选一冲突抛 provider_bad_request', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'an-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })

    await provider.retarget({ originalModelTaskId: 'rig-1', animation: 'preset:walk' })
    let body = calls[0]?.body ?? {}
    expect(body).toMatchObject({ type: 'animate_retarget', original_model_task_id: 'rig-1', animation: 'preset:walk' })

    await provider.retarget({
      originalModelTaskId: 'rig-1',
      animations: ['preset:run', 'preset:jump', 'preset:quadruped:walk'],
      providerOptions: { bake_animation: false, animate_in_place: true },
    })
    body = calls[1]?.body ?? {}
    expect(body.animations).toEqual(['preset:run', 'preset:jump', 'preset:quadruped:walk'])
    expect(body.bake_animation).toBe(false)
    expect(body.animate_in_place).toBe(true)

    await expect(
      provider.retarget({ originalModelTaskId: 'rig-1', animation: 'preset:walk', animations: ['preset:run'] }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(provider.retarget({ originalModelTaskId: 'rig-1' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(
      provider.retarget({ originalModelTaskId: 'rig-1', animation: 'walk' }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.retarget({ originalModelTaskId: 'rig-1', animations: Array.from({ length: 6 }, (_, i) => `preset:x${i}`) }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })
})

describe('提交：highpoly_to_lowpoly（智能低模）', () => {
  it('默认版本 P-v2.0-20251225 + face_limit 校验 + 透传', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'lp-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await provider.highpolyToLowpoly({ originalModelTaskId: 'src-1', faceLimit: 5000, quad: true })
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({
      type: 'highpoly_to_lowpoly',
      original_model_task_id: 'src-1',
      model_version: 'P-v2.0-20251225',
      face_limit: 5000,
      quad: true,
    })

    await expect(
      provider.highpolyToLowpoly({ originalModelTaskId: 'src-1', faceLimit: 499 }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.highpolyToLowpoly({ originalModelTaskId: 'src-1', faceLimit: 20_001 }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })
})

describe('listMotions（16 个 preset 静态目录）', () => {
  it('全部 16 条映射；id 即 preset:*；rigType 与骨架枚举对齐', async () => {
    const provider = new TripoProvider()
    const motions = await provider.listMotions()
    expect(motions.length).toBe(TRIPO_MOTION_PRESETS.length)
    expect(motions.length).toBe(16)
    for (const m of motions) {
      expect(String(m.id)).toMatch(/^preset:/)
      expect(typeof m.label).toBe('string')
      expect(m.isFree).toBe(false)
    }
    expect(motions[0]).toMatchObject({ id: 'preset:idle', label: 'Idle', category: 'Biped', rigType: 'biped' })
    expect(motions.find((m) => m.id === 'preset:quadruped:walk')?.rigType).toBe('quadruped')
    expect(motions.find((m) => m.id === 'preset:aquatic:march')?.rigType).toBe('aquatic')
    expect(new Set(motions.map((m) => m.id)).size).toBe(16)
  })

  it('query / category / rigType 过滤', async () => {
    const provider = new TripoProvider()
    const walk = await provider.listMotions({ query: 'walk', category: 'Biped' })
    expect(walk.map((m) => m.id)).toEqual(['preset:walk'])
    const quadrupeds = await provider.listMotions({ rigType: 'quadruped' })
    expect(quadrupeds.map((m) => m.id)).toEqual(['preset:quadruped:walk'])
    const none = await provider.listMotions({ query: 'zzz-no-such-motion' })
    expect(none).toEqual([])
  })
})

describe('balance', () => {
  it('返回余额与冻结积分', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/user\/balance$/, handler: () => jsonResp({ code: 0, data: { balance: 123.5, frozen: 20 } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.balance()).resolves.toEqual({ balance: 123.5, frozen: 20 })
    expect(calls[0]?.url).toBe(`${TRIPO_BASE_URL}/user/balance`)
  })

  it('响应缺 balance 字段抛 provider_http_error', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/user\/balance$/, handler: () => jsonResp({ code: 0, data: { frozen: 0 } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.balance()).rejects.toMatchObject({ code: 'provider_http_error' })
  })
})

describe('轮询（8 态状态机）', () => {
  it('queued → running → success：查询成功立即下载并校验 GLB magic', async () => {
    const TASK = 'poll-ok-1'
    let pollCount = 0
    const { fetchImpl, calls } = mockFetch([
      {
        test: /\/task\/poll-ok-1$/,
        handler: () => {
          pollCount += 1
          if (pollCount < 3) {
            return jsonResp({
              code: 0,
              data: {
                task_id: TASK,
                type: 'text_to_model',
                status: pollCount === 1 ? 'queued' : 'running',
                progress: pollCount === 1 ? 0 : 60,
                queuing_num: pollCount === 1 ? 3 : -1,
              },
            })
          }
          return jsonResp({
            code: 0,
            data: {
              task_id: TASK,
              type: 'text_to_model',
              status: 'success',
              progress: 100,
              output: {
                model: 'https://cdn.example.com/m.glb',
                base_model: 'https://cdn.example.com/base.glb',
                pbr_model: 'https://cdn.example.com/pbr.glb',
                rendered_image: 'https://cdn.example.com/prev.png',
              },
              consumed_credit: 20,
              queuing_num: -1,
              running_left_time: -1,
              create_time: 1_700_000_000,
            },
          })
        },
      },
      {
        test: /^https:\/\/cdn\.example\.com\//,
        handler: (url) => (url.endsWith('.png') ? bytesResp(PNG_BYTES) : bytesResp(GLB_BYTES)),
      },
    ])
    const provider = new TripoProvider({ fetchImpl, sleep: async () => {} })

    const result = await provider.pollTask(handle(TASK, 'text_to_model'), { intervalMs: 0 })
    expect(result.status).toBe('succeeded')
    expect(result.taskId).toBe(TASK)
    expect(result.type).toBe('text_to_model')
    expect(result.files.map((f) => f.role)).toEqual(['model', 'base_model', 'pbr_model', 'rendered_image'])
    expect(result.files[0]?.format).toBe('glb')
    expect(result.files[0]?.buffer).toEqual(GLB_BYTES)
    expect(result.files[3]?.format).toBe('png')
    expect(result.consumedCredit).toBe(20)
    expect(result.progress).toBe(100)
    expect((result.raw as { status: string }).status).toBe('success')
    expect(pollCount).toBe(3)

    // 契约形状投影：downloads 只含 URL（model 优先作 glb，rendered_image 作预览）
    expect(result.downloads).toEqual({
      glb: 'https://cdn.example.com/m.glb',
      previewImage: 'https://cdn.example.com/prev.png',
    })
    // 时序：最后一次轮询成功之后才发起下载
    const pollCalls = calls.filter((c) => c.url.includes(`/task/${TASK}`))
    const dlCalls = calls.filter((c) => c.url.includes('cdn.example.com'))
    expect(pollCalls.length).toBe(3)
    expect(dlCalls.length).toBe(4)
    // 下载是签名 URL 直链，不带认证头
    expect(authOf(dlCalls[0]?.init)).toBeUndefined()
  })

  it('失败终态 failed：error_code 2010 → provider_insufficient_credits，不再继续轮询', async () => {
    const TASK = 'poll-fail-1'
    const pollHandler = vi.fn(() =>
      jsonResp({
        code: 0,
        data: {
          task_id: TASK,
          status: 'failed',
          error_code: 2010,
          error_message: 'insufficient credits',
        },
      }),
    )
    const { fetchImpl } = mockFetch([{ test: /\/task\/poll-fail-1$/, handler: pollHandler }])
    const provider = new TripoProvider({ fetchImpl, sleep: async () => {} })

    const error = await provider.pollTask(handle(TASK)).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'provider_insufficient_credits', taskStatus: 'failed' })
    expect(isProviderError(error)).toBe(true)
    expect((error as Error).message).toContain('error_code=2010')
    expect(pollHandler).toHaveBeenCalledTimes(1) // 立即抛，不再轮询
  })

  const terminalStates: Array<{ status: string; code: string; retryable?: boolean }> = [
    { status: 'banned', code: 'provider_bad_request', retryable: false },
    { status: 'expired', code: 'provider_http_error', retryable: false },
    { status: 'cancelled', code: 'provider_http_error', retryable: false },
    { status: 'unknown', code: 'provider_http_error', retryable: true },
  ]
  for (const t of terminalStates) {
    it(`终态 ${t.status} → ${t.code}`, async () => {
      const { fetchImpl } = mockFetch([
        {
          test: /\/task\/term-1$/,
          handler: () => jsonResp({ code: 0, data: { task_id: 'term-1', status: t.status } }),
        },
      ])
      const provider = new TripoProvider({ fetchImpl, sleep: async () => {} })
      await expect(provider.pollTask(handle('term-1'))).rejects.toMatchObject({
        code: t.code,
        taskStatus: t.status,
        retryable: t.retryable,
      })
    })
  }

  it('超时：轮询超过 timeoutMs 抛 provider_timeout', async () => {
    const { fetchImpl } = mockFetch([
      {
        test: /\/task\/slow-1$/,
        handler: () => jsonResp({ code: 0, data: { task_id: 'slow-1', status: 'running' } }),
      },
    ])
    const provider = new TripoProvider({ fetchImpl, sleep: async () => {} })
    await expect(provider.pollTask(handle('slow-1'), { timeoutMs: 50 })).rejects.toMatchObject({
      code: 'provider_timeout',
      taskId: 'slow-1',
      retryable: true,
    })
  })

  it('默认轮询间隔 2s（官方建议；可注入覆盖）', async () => {
    const TASK = 'poll-interval-1'
    const makeRoutes = () => [
      {
        test: /\/task\/poll-interval-1$/,
        handler: () =>
          jsonResp({
            code: 0,
            data: { task_id: TASK, status: 'running', progress: 10 },
          }),
      },
    ]

    const sleepA = vi.fn(async (_ms: number) => {})
    const providerA = new TripoProvider({ fetchImpl: mockFetch(makeRoutes()).fetchImpl, sleep: sleepA })
    await providerA.pollTask(handle(TASK), { timeoutMs: 50 }).catch(() => {})
    expect(sleepA.mock.calls[0]?.[0]).toBe(DEFAULT_POLL_INTERVAL_MS)

    const sleepB = vi.fn(async (_ms: number) => {})
    const providerB = new TripoProvider({ fetchImpl: mockFetch(makeRoutes()).fetchImpl, sleep: sleepB })
    await providerB.pollTask(handle(TASK), { intervalMs: 123, timeoutMs: 50 }).catch(() => {})
    expect(sleepB.mock.calls[0]?.[0]).toBe(123)
  })

  it('轮询支持 AbortSignal 取消（AbortError）', async () => {
    const { fetchImpl } = mockFetch([
      {
        test: /\/task\/abort-1$/,
        handler: () => jsonResp({ code: 0, data: { task_id: 'abort-1', status: 'running' } }),
      },
    ])
    let release: (() => void) | undefined
    const sleep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = () => resolve()
        }),
    )
    const provider = new TripoProvider({ fetchImpl, sleep })
    const controller = new AbortController()
    const pending = provider.pollTask(handle('abort-1'), { signal: controller.signal })
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled())
    controller.abort()
    release?.()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('prerigcheck 成功：解析 rigInfo（riggable + rig_type），无资产不抛空', async () => {
    const TASK = 'pre-done-1'
    const { fetchImpl } = mockFetch([
      {
        test: /\/task\/pre-done-1$/,
        handler: () =>
          jsonResp({
            code: 0,
            data: {
              task_id: TASK,
              type: 'animate_prerigcheck',
              status: 'success',
              progress: 100,
              output: { riggable: true, rig_type: 'biped' },
            },
          }),
      },
    ])
    const provider = new TripoProvider({ fetchImpl, sleep: async () => {} })
    const result = await provider.pollTask(handle(TASK, 'animate_prerigcheck'))
    expect(result.status).toBe('succeeded')
    expect(result.rigInfo).toEqual({ riggable: true, rigType: 'biped' })
    expect(result.files).toEqual([])
    expect(result.downloads).toEqual({})
  })

  it('轮询 GET 失败映射到契约错误码（含 taskId）', async () => {
    const { fetchImpl } = mockFetch([
      {
        test: /\/task\/http-404$/,
        handler: () => jsonResp({ code: 2001, message: 'task not found' }, 404),
      },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.pollTask(handle('http-404'))).rejects.toMatchObject({
      code: 'provider_bad_request',
      httpStatus: 404,
      taskId: 'http-404',
    })
  })
})

describe('下载与时序', () => {
  const succeedWith = (output: Record<string, unknown>) => ({
    test: /\/task\/dl-1$/,
    handler: () => jsonResp({ code: 0, data: { task_id: 'dl-1', status: 'success', progress: 100, output } }),
  })

  it('GLB magic 校验失败抛 provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([
      succeedWith({ model: 'https://cdn.example.com/bad.glb' }),
      {
        test: /^https:\/\/cdn\.example\.com\//,
        handler: () => bytesResp(new Uint8Array([0x01, 0x02, 0x03, 0x04])),
      },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-1'))).rejects.toMatchObject({
      code: 'provider_empty_download',
    })
  })

  it('空内容抛 provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([
      succeedWith({ model: 'https://cdn.example.com/empty.glb' }),
      { test: /^https:\/\/cdn\.example\.com\//, handler: () => bytesResp(new Uint8Array(0)) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-1'))).rejects.toMatchObject({
      code: 'provider_empty_download',
    })
  })

  it('任务成功但无任何资产抛 provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([succeedWith({})])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-1'))).rejects.toMatchObject({
      code: 'provider_empty_download',
    })
  })

  it('下载 403：重查任务取新链接重试一次成功；downloads/modelUrls 以新链接为准', async () => {
    const TASK = 'dl-403-1'
    let pollCount = 0
    const { fetchImpl, calls } = mockFetch([
      {
        test: /\/task\/dl-403-1$/,
        handler: () => {
          pollCount += 1
          return jsonResp({
            code: 0,
            data: {
              task_id: TASK,
              status: 'success',
              progress: 100,
              output: {
                model: pollCount === 1 ? 'https://cdn.example.com/old.glb' : 'https://cdn.example.com/fresh.glb',
              },
            },
          })
        },
      },
      {
        test: /\/cdn\.example\.com\/old\.glb$/,
        handler: () => jsonResp({ message: 'expired' }, 403),
      },
      {
        test: /\/cdn\.example\.com\/fresh\.glb$/,
        handler: () => bytesResp(GLB_BYTES),
      },
    ])
    const provider = new TripoProvider({ fetchImpl, sleep: async () => {} })
    const result = await provider.pollTask(handle(TASK, 'text_to_model'))
    expect(pollCount).toBe(2) // 查询成功 + 403 后重查一次
    expect(result.files[0]?.url).toBe('https://cdn.example.com/fresh.glb')
    expect(result.files[0]?.buffer).toEqual(GLB_BYTES)
    expect(result.downloads.glb).toBe('https://cdn.example.com/fresh.glb')
    expect(result.modelUrls.model).toBe('https://cdn.example.com/fresh.glb')
    const downloadCalls = calls.filter((c) => c.url.includes('cdn.example.com'))
    expect(downloadCalls.map((c) => c.url)).toEqual([
      'https://cdn.example.com/old.glb',
      'https://cdn.example.com/fresh.glb',
    ])
  })

  it('下载 403 且重查后链接未更新 → provider_http_error', async () => {
    const { fetchImpl } = mockFetch([
      {
        test: /\/task\/dl-403-2$/,
        handler: () =>
          jsonResp({
            code: 0,
            data: {
              task_id: 'dl-403-2',
              status: 'success',
              progress: 100,
              output: { model: 'https://cdn.example.com/stuck.glb' },
            },
          }),
      },
      {
        test: /\/cdn\.example\.com\/stuck\.glb$/,
        handler: () => jsonResp({ message: 'expired' }, 403),
      },
    ])
    const provider = new TripoProvider({ fetchImpl })
    const error = await provider.pollTask(handle('dl-403-2')).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'provider_http_error' })
    expect((error as Error).message).toContain('链接未更新')
  })

  it('下载 403 且重查任务状态异常 → provider_http_error', async () => {
    let pollCount = 0
    const { fetchImpl } = mockFetch([
      {
        test: /\/task\/dl-403-3$/,
        handler: () => {
          pollCount += 1
          return jsonResp({
            code: 0,
            data: {
              task_id: 'dl-403-3',
              status: pollCount === 1 ? 'success' : 'failed',
              error_code: pollCount === 1 ? undefined : 1001,
              progress: 100,
              output: { model: 'https://cdn.example.com/gone.glb' },
            },
          })
        },
      },
      {
        test: /\/cdn\.example\.com\/gone\.glb$/,
        handler: () => jsonResp({ message: 'expired' }, 403),
      },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.pollTask(handle('dl-403-3'))).rejects.toMatchObject({
      code: 'provider_http_error',
    })
  })
})

describe('错误映射（HTTP + code 双判定）', () => {
  const cases: Array<{
    status: number
    code?: number
    expected: string
    retryable?: boolean
    headers?: Record<string, string>
  }> = [
    { status: 401, code: 1002, expected: 'provider_unauthorized', retryable: false },
    { status: 403, code: 1005, expected: 'provider_unauthorized', retryable: false },
    { status: 403, code: 2010, expected: 'provider_insufficient_credits', retryable: false },
    { status: 429, code: 2000, expected: 'provider_queue_full', retryable: true, headers: { 'retry-after': '30' } },
    { status: 429, code: 1007, expected: 'provider_rate_limited', retryable: true },
    { status: 500, code: 1000, expected: 'provider_http_error', retryable: true },
    { status: 404, code: 2001, expected: 'provider_bad_request', retryable: false },
    { status: 400, code: 2009, expected: 'provider_bad_request', retryable: false },
    // HTTP 200 但业务 code ≠ 0（统一包装失败）
    { status: 200, code: 2019, expected: 'provider_bad_request', retryable: false },
  ]

  for (const c of cases) {
    it(`submit HTTP ${c.status} + code ${c.code} → ${c.expected}`, async () => {
      const { fetchImpl } = mockFetch([
        {
          test: /\/task$/,
          handler: () =>
            jsonResp(
              { code: c.code, message: 'api error', suggestion: 'fix it' },
              c.status,
              c.headers,
            ),
        },
      ])
      const provider = new TripoProvider({ fetchImpl })
      const error = await provider.textTo3d({ prompt: 'knight' }).catch((e: unknown) => e)
      expect(error).toMatchObject({ code: c.expected, httpStatus: c.status })
      expect(isProviderError(error)).toBe(true)
      if (c.retryable !== undefined) expect(error).toMatchObject({ retryable: c.retryable })
      expect((error as Error).message).toContain(`code=${c.code}`)
      expect((error as Error).message).toContain('fix it')
      if (c.headers?.['retry-after'] !== undefined) {
        expect(error).toMatchObject({ retryAfterSec: 30 })
      }
    })
  }

  it('无 code 时按 HTTP 状态兜底映射（401 → provider_unauthorized）', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ message: 'bad' }, 401) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.textTo3d({ prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_unauthorized',
      httpStatus: 401,
    })
  })

  it('X-Tripo-Trace-ID 与 suggestion 进错误信息（排障用）', async () => {
    const { fetchImpl } = mockFetch([
      {
        test: /\/task$/,
        handler: () =>
          jsonResp(
            { code: 1002, message: 'auth failed', suggestion: 'check key' },
            401,
            { 'x-tripo-trace-id': 'trace-abc-123' },
          ),
      },
    ])
    const provider = new TripoProvider({ fetchImpl })
    const error = await provider.textTo3d({ prompt: 'knight' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ traceId: 'trace-abc-123' })
    expect((error as Error).message).toContain('trace-abc-123')
    expect((error as Error).message).toContain('check key')
  })

  it('网络错误（fetch 抛异常）→ provider_http_error 可重试', async () => {
    const provider = new TripoProvider({
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      },
    })
    const error = await provider.textTo3d({ prompt: 'knight' }).catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'provider_http_error', retryable: true })
    expect((error as Error).message).toContain('fetch failed')
  })
})

describe('统一 Gen3dProvider 接口', () => {
  it('submitGeneration：text / image / views 模式映射 + negativePrompt / seed 入请求体', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'u-1' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })

    const text = await provider.submitGeneration({
      mode: 'text',
      prompt: 'a knight',
      negativePrompt: 'ugly',
      seed: 7,
      providerOptions: { face_limit: 50_000 },
    })
    expect(text.type).toBe('text_to_model')
    let body = calls[0]?.body ?? {}
    expect(body).toMatchObject({
      type: 'text_to_model',
      prompt: 'a knight',
      negative_prompt: 'ugly',
      model_seed: 7,
      face_limit: 50_000,
    })

    const image = await provider.submitGeneration({
      mode: 'image',
      prompt: 'p',
      imageUrls: ['https://x/hero.png'],
    })
    expect(image.type).toBe('image_to_model')
    body = calls[1]?.body ?? {}
    expect(body.file).toEqual({ type: 'image', url: 'https://x/hero.png' })

    // file_token 经 providerOptions 显式传入（工具层先 uploadImage）
    await provider.submitGeneration({
      mode: 'image',
      prompt: 'p',
      providerOptions: { file_token: 'tok-uploaded-9' },
    })
    body = calls[2]?.body ?? {}
    expect(body.file).toEqual({ type: 'image', file_token: 'tok-uploaded-9' })

    const views = await provider.submitGeneration({
      mode: 'views',
      prompt: 'p',
      imageUrls: ['https://x/f.png', 'https://x/l.png'],
    })
    expect(views.type).toBe('multiview_to_model')
    body = calls[3]?.body ?? {}
    expect(body.files).toEqual([
      { type: 'image', url: 'https://x/f.png' },
      { type: 'image', url: 'https://x/l.png' },
    ])
  })

  it('submitRig：assetUrl 承载原模型任务 id + skeletonType → rig_type', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'u-rig' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    const h = await provider.submitRig({ assetUrl: 'src-task-1', skeletonType: 'quadruped' })
    expect(h.type).toBe('animate_rig')
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({
      type: 'animate_rig',
      original_model_task_id: 'src-task-1',
      rig_type: 'quadruped',
    })
    // providerOptions.original_model_task_id 优先
    await provider.submitRig({ assetUrl: 'ignored', providerOptions: { original_model_task_id: 'real-1' } })
    const body2 = calls[1]?.body ?? {}
    expect(body2.original_model_task_id).toBe('real-1')
  })

  it('submitAnimation：actionId preset 字符串 → animation；animations 经 providerOptions', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/task$/, handler: () => jsonResp({ code: 0, data: { task_id: 'u-an' } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    const h = await provider.submitAnimation({ rigTaskId: 'rig-u', actionId: 'preset:walk' })
    expect(h.type).toBe('animate_retarget')
    const body = calls[0]?.body ?? {}
    expect(body).toMatchObject({ type: 'animate_retarget', original_model_task_id: 'rig-u', animation: 'preset:walk' })

    await provider.submitAnimation({
      rigTaskId: 'rig-u',
      actionId: '',
      providerOptions: { animations: ['preset:jump', 'preset:turn'] },
    })
    const body2 = calls[1]?.body ?? {}
    expect(body2.animations).toEqual(['preset:jump', 'preset:turn'])
    expect(body2.animation).toBeUndefined() // 数组路径不写入单动作

    // animation 与 animations 二选一：同时给出是调用方错误
    await expect(
      provider.submitAnimation({
        rigTaskId: 'rig-u',
        actionId: 'preset:run',
        providerOptions: { animations: ['preset:jump'] },
      }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })

    // 数字 actionId 不是 Tripo3D 的动作形态（必须 preset:* 字符串）
    await expect(
      provider.submitAnimation({ rigTaskId: 'rig-u', actionId: 92 }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('getBalance：返回 BalanceInfo（含 raw）', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/user\/balance$/, handler: () => jsonResp({ code: 0, data: { balance: 7, frozen: 1 } }) },
    ])
    const provider = new TripoProvider({ fetchImpl })
    await expect(provider.getBalance()).resolves.toEqual({
      balance: 7,
      raw: { balance: 7, frozen: 1 },
    })
  })

  it('listMotions：契约形状映射（id / label / category / rigType / isFree）', async () => {
    const provider = new TripoProvider()
    const motions = await provider.listMotions()
    expect(motions[0]).toEqual({
      id: 'preset:idle',
      label: 'Idle',
      category: 'Biped',
      rigType: 'biped',
      isFree: false,
    })
  })
})
