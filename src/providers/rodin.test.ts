/**
 * RodinProvider 单测：全部 mock fetch（真实 Response / FormData 对象），不打真网。
 *
 * 覆盖：认证头与基址、multipart 构造（文生无图 / 图生 1 张 / 多视图 2–5 张保序、
 * 参考图先下载字节再 attach、tier 映射、quality_override 按 tier/mesh_mode 钳制、
 * TAPose / mesh_mode / HighPack addon / bbox_condition）、status→download 流转
 * （subscription_key 轮询、全 job 终态、Failed 即失败、超时、限流、GLB magic 校验、
 * preview.webp 缩略图归类）、错误枚举映射（Business 订阅门槛 / 余额不足 / 非法请求 /
 * 无权限 / 限流）、balance、bang / textureOnly 扩展方法、能力裁剪
 * （无 submitRig/submitAnimation/listMotions）与订阅门槛说明、未配置 key 抛
 * provider_not_configured。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FetchLike } from './types.js'
import {
  clampQualityOverride,
  DEFAULT_POLL_INTERVAL_MS,
  mapRodinError,
  mapRodinHttpStatus,
  normalizeTier,
  qualityOverrideRange,
  RODIN_BASE_URL,
  RODIN_SUBSCRIPTION_NOTE,
  RodinProvider,
  type RodinTaskHandle,
  type RodinTextureOnlyInput,
} from './rodin.js'

const KEY = 'test-rodin-key-123'
const UUID = 'task-uuid-1'
const SUB_KEY = 'sub-key-1'
const GLB_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03])
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const REF = (n: string) => `https://refs.example/${n}`

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bytesResp(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, { status })
}

/** 创建端点成功响应（error=null + uuid + jobs.subscription_key） */
function submitBody(uuid: string, subKey: string): Record<string, unknown> {
  return { error: null, message: 'Submitted.', uuid, jobs: { uuids: ['j1'], subscription_key: subKey } }
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

/** RequestInit.body 是 BodyInit 联合类型；JSON 端点测试中始终为 JSON 字符串 */
function bodyOf(init?: RequestInit): string {
  return typeof init?.body === 'string' ? init.body : '{}'
}

/** multipart 请求体（FormData 对象；测试可直接断言字段与文件） */
function formOf(init?: RequestInit): FormData | undefined {
  return init?.body instanceof FormData ? init.body : undefined
}

async function fileOf(form: FormData, key: string): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  const value = form.get(key)
  if (value === null) return undefined
  if (typeof value === 'string') throw new Error(`form 字段 ${key} 应为文件，实际为字符串：${value}`)
  return { name: value.name, bytes: new Uint8Array(await value.arrayBuffer()) }
}

/** 简易路由式 fetch mock：记录全部调用，未注册的 URL 直接失败 */
function mockFetch(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    const hit = routes.find((r) => r.test.test(url))
    if (!hit) throw new Error(`测试未注册的 URL：${url}`)
    return hit.handler(url, init)
  }
  return { fetchImpl, calls }
}

function handle(taskId: string, kind: RodinTaskHandle['kind'] = 'generate'): RodinTaskHandle {
  return { provider: 'rodin', taskId, kind, createdAtMs: 0 }
}

/** 文生提交并取回 multipart 表单（提交成功路径的便捷封装） */
async function submitTextForm(providerOptions: Record<string, unknown>): Promise<FormData> {
  const { fetchImpl, calls } = mockFetch([
    { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
  ])
  const provider = new RodinProvider({ fetchImpl })
  await provider.submitGeneration({ mode: 'text', prompt: 'knight', providerOptions })
  return formOf(calls.find((c) => c.url.endsWith('/api/v2/rodin'))?.init)!
}

beforeEach(() => {
  process.env.RODIN_API_KEY = KEY
})

afterEach(() => {
  delete process.env.RODIN_API_KEY
})

describe('认证与配置', () => {
  it('submit / 轮询 / 下载 / 余额均带 Bearer 认证头且基址正确', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /\/api\/v2\/status$/, handler: () => jsonResp({ jobs: [{ uuid: 'j1', status: 'Done' }] }) },
      {
        test: /\/api\/v2\/download$/,
        handler: () => jsonResp({ error: 'OK', list: [{ url: 'https://dl.example/m.glb', name: 'm.glb' }] }),
      },
      { test: /\/api\/v2\/check_balance$/, handler: () => jsonResp({ balance: 12 }) },
      { test: /https:\/\/refs\.example\//, handler: () => bytesResp(PNG_BYTES) },
      { test: /https:\/\/dl\.example\//, handler: () => bytesResp(GLB_BYTES) },
    ])
    const provider = new RodinProvider({ fetchImpl, sleep: async () => {} })

    await provider.submitGeneration({ mode: 'image', imageUrls: [REF('a.png')], prompt: '' })
    const submit = calls.find((c) => c.url.endsWith('/api/v2/rodin'))
    expect(submit?.url).toBe(`${RODIN_BASE_URL}/rodin`)
    expect(authOf(submit?.init)).toBe(`Bearer ${KEY}`)

    await provider.pollTask(handle(UUID))
    const statusCall = calls.find((c) => c.url.endsWith('/api/v2/status'))
    expect(statusCall?.url).toBe(`${RODIN_BASE_URL}/status`)
    expect(authOf(statusCall?.init)).toBe(`Bearer ${KEY}`)
    const dlCall = calls.find((c) => c.url.endsWith('/api/v2/download'))
    expect(dlCall?.url).toBe(`${RODIN_BASE_URL}/download`)
    expect(authOf(dlCall?.init)).toBe(`Bearer ${KEY}`)

    await expect(provider.getBalance()).resolves.toEqual({ balance: 12, raw: { balance: 12 } })
    const balCall = calls.find((c) => c.url.endsWith('/check_balance'))
    expect(balCall?.url).toBe(`${RODIN_BASE_URL}/check_balance`)
    expect(authOf(balCall?.init)).toBe(`Bearer ${KEY}`)
  })

  it('未配置 key：所有方法抛 provider_not_configured，且不发请求', async () => {
    delete process.env.RODIN_API_KEY
    const fetchImpl: FetchLike = async () => {
      throw new Error('不应发起任何请求')
    }
    const provider = new RodinProvider({ fetchImpl })
    expect(provider.isConfigured()).toBe(false)
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'knight' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.submitGeneration({ mode: 'image', imageUrls: [REF('a.png')], prompt: '' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(
      provider.submitGeneration({ mode: 'views', imageUrls: [REF('a.png'), REF('b.png')], prompt: '' }),
    ).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.submitRodin({ mode: 'text', prompt: 'x' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.bang({ assetId: 'u' })).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(
      provider.textureOnly({ imageBytes: PNG_BYTES, modelBytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.pollTask(handle('any'))).rejects.toMatchObject({ code: 'provider_not_configured' })
    await expect(provider.getBalance()).rejects.toMatchObject({ code: 'provider_not_configured' })
  })

  it('isConfigured 反映 RODIN_API_KEY 是否配置', () => {
    const provider = new RodinProvider({ fetchImpl: async () => new Response() })
    expect(provider.isConfigured()).toBe(true)
    delete process.env.RODIN_API_KEY
    expect(provider.isConfigured()).toBe(false)
  })
})

describe('multipart 构造', () => {
  it('文生 3D：无 images 字段、prompt 必填、tier 默认 Regular、不手动设置 Content-Type', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    const result = await provider.submitGeneration({ mode: 'text', prompt: 'a robot' })
    expect(result).toMatchObject({ provider: 'rodin', taskId: UUID, kind: 'generate' })
    const init = calls.find((c) => c.url.endsWith('/api/v2/rodin'))?.init
    const form = formOf(init)
    expect(form).toBeInstanceOf(FormData)
    expect(form!.has('images')).toBe(false)
    expect(form!.get('prompt')).toBe('a robot')
    expect(form!.get('tier')).toBe('Regular')
    // multipart 边界由 fetch 自动生成：不得手动设置 Content-Type
    const headers = init?.headers as Record<string, string> | undefined
    expect(headers).not.toHaveProperty('Content-Type')
    expect(headers?.Authorization).toBe(`Bearer ${KEY}`)
  })

  it('图生 3D：参考图先下载字节再作为 images 文件 attach（文件名取自 URL、prompt 可选）', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /https:\/\/refs\.example\/front\.png/, handler: () => bytesResp(PNG_BYTES) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    await provider.submitGeneration({
      mode: 'image',
      imageUrls: ['https://refs.example/front.png'],
      prompt: 'sword',
      providerOptions: { tier: 'Gen-2' },
    })
    // 参考图下载先于提交请求
    expect(calls[0]?.url).toBe('https://refs.example/front.png')
    const form = formOf(calls.find((c) => c.url.endsWith('/api/v2/rodin'))?.init)!
    const img = await fileOf(form, 'images')
    expect(img).toMatchObject({ name: 'front.png' })
    expect(img!.bytes).toEqual(PNG_BYTES)
    expect(form.get('prompt')).toBe('sword')
    expect(form.get('tier')).toBe('Gen-2')
    expect(form.getAll('images')).toHaveLength(1)
  })

  it('多视图 2–5 张：保序 attach（第一张用于材质生成）', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /https:\/\/refs\.example\//, handler: () => bytesResp(PNG_BYTES) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    await provider.submitGeneration({ mode: 'views', imageUrls: [REF('a.png'), REF('b.png'), REF('c.png')], prompt: '' })
    const form = formOf(calls.find((c) => c.url.endsWith('/api/v2/rodin'))?.init)!
    const names = form.getAll('images').map((f) => (f as File).name)
    expect(names).toEqual(['a.png', 'b.png', 'c.png'])
  })

  it('超过 5 张参考图 → provider_bad_request，且不发任何请求', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('不应发起任何请求')
    }
    const provider = new RodinProvider({ fetchImpl })
    const urls = Array.from({ length: 6 }, (_, i) => REF(`v${i}.png`))
    await expect(provider.submitGeneration({ mode: 'views', imageUrls: urls, prompt: '' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('模式与图片数校验：text 带图 / image 无图或多图 / views 1 张 / 文生缺 prompt → provider_bad_request', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('不应发起任何请求')
    }
    const provider = new RodinProvider({ fetchImpl })
    await expect(
      provider.submitGeneration({ mode: 'text', prompt: 'x', imageUrls: [REF('a.png')] }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(provider.submitGeneration({ mode: 'text', prompt: '  ' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.submitGeneration({ mode: 'image', imageUrls: [], prompt: '' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(
      provider.submitGeneration({ mode: 'image', imageUrls: [REF('a.png'), REF('b.png')], prompt: '' }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(provider.submitGeneration({ mode: 'views', imageUrls: [REF('a.png')], prompt: '' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('providerOptions 透传：TAPose / mesh_mode / addons / material / bbox_condition / 未知键忽略', async () => {
    const form = await submitTextForm({
      tier: 'Gen-2',
      TAPose: true,
      mesh_mode: 'Raw',
      addons: ['HighPack'],
      material: 'All',
      quality: 'high',
      seed: 42,
      bbox_condition: [100, 200, 300],
      use_original_alpha: true,
      unknown_key: 'ignored',
    })
    expect(form.get('tier')).toBe('Gen-2')
    expect(form.get('TAPose')).toBe('true')
    expect(form.get('mesh_mode')).toBe('Raw')
    expect(form.getAll('addons')).toEqual(['HighPack'])
    expect(form.get('material')).toBe('All')
    expect(form.get('quality')).toBe('high')
    expect(form.get('bbox_condition')).toBe('[100,200,300]')
    expect(form.get('use_original_alpha')).toBe('true')
    expect(form.get('unknown_key')).toBeNull()
    // seed 走 GenerationRequest.seed 契约字段，不经 providerOptions
    expect(form.get('seed')).toBeNull()
  })

  it('quality_override 按 tier/mesh_mode 钳制；Sketch 档剥离', async () => {
    // Gen-2 缺省 Quad：上限 200k → 钳到 200000
    const quad = await submitTextForm({ tier: 'Gen-2', quality_override: 500_000 })
    expect(quad.get('quality_override')).toBe('200000')
    // Gen-2 + Raw：500 – 1M，500k 原样
    const raw = await submitTextForm({ tier: 'Gen-2', mesh_mode: 'Raw', quality_override: 500_000 })
    expect(raw.get('quality_override')).toBe('500000')
    // Gen-2.5-High + Raw：上限 2M
    const hi = await submitTextForm({ tier: 'Gen-2.5-High', mesh_mode: 'Raw', quality_override: 9_999_999 })
    expect(hi.get('quality_override')).toBe('2000000')
    // Gen-2.5-Extreme-Low + Raw：上限 1M
    const low = await submitTextForm({ tier: 'Gen-2.5-Extreme-Low', mesh_mode: 'Raw', quality_override: 9_999_999 })
    expect(low.get('quality_override')).toBe('1000000')
    // Gen-1&1.5（Regular）：2k – 200k
    const gen1 = await submitTextForm({ tier: 'Regular', quality_override: 9_999_999 })
    expect(gen1.get('quality_override')).toBe('200000')
    // Sketch：官方不生效 → 剥离
    const sketch = await submitTextForm({ tier: 'Sketch', quality_override: 100_000 })
    expect(sketch.get('quality_override')).toBeNull()
    expect(sketch.get('quality')).toBeNull()
  })

  it('addons 仅 HighPack；Gen-1&1.5+Raw 官方强制为空剥离；非法 addon → provider_bad_request', async () => {
    const gen2 = await submitTextForm({ tier: 'Gen-2', addons: ['HighPack', 'HighPack'] })
    expect(gen2.getAll('addons')).toEqual(['HighPack', 'HighPack'])
    const gen1Raw = await submitTextForm({ tier: 'Regular', mesh_mode: 'Raw', addons: ['HighPack'] })
    expect(gen1Raw.has('addons')).toBe(false)
    await expect(submitTextForm({ tier: 'Gen-2', addons: ['LowPack'] })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('非法值校验：未知 tier / 非法 quality / 非法 mesh_mode → provider_bad_request', async () => {
    await expect(submitTextForm({ tier: 'Gen-9' })).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(submitTextForm({ quality: 'ultra' })).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(submitTextForm({ mesh_mode: 'Tri' })).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('seed 越界 / 非整数 → provider_bad_request（契约字段路径）', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'x', seed: 70_000 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'x', seed: -1 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'x', seed: 1.5 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('参考图下载失败：HTTP 404 → provider_http_error；空内容 → provider_bad_request', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /missing\.png/, handler: () => new Response('not found', { status: 404 }) },
      { test: /empty\.png/, handler: () => bytesResp(new Uint8Array(0)) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    await expect(
      provider.submitGeneration({ mode: 'image', imageUrls: [REF('missing.png')], prompt: '' }),
    ).rejects.toMatchObject({ code: 'provider_http_error' })
    await expect(
      provider.submitGeneration({ mode: 'image', imageUrls: [REF('empty.png')], prompt: '' }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })
})

describe('status → download 流转', () => {
  it('全 job 终态后 download 并校验 GLB magic；downloads 投影含 preview.webp 缩略图；轮询间隔 5s', async () => {
    let poll = 0
    const sleep = vi.fn(async () => {})
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      {
        test: /\/api\/v2\/status$/,
        handler: () => {
          poll += 1
          return jsonResp({ jobs: [{ uuid: 'j1', status: poll < 2 ? 'Generating' : 'Done' }] })
        },
      },
      {
        test: /\/api\/v2\/download$/,
        handler: () =>
          jsonResp({
            error: 'OK',
            list: [
              { url: 'https://dl.example/model.glb', name: 'model.glb' },
              { url: 'https://dl.example/preview.webp', name: 'preview.webp' },
              { url: 'https://dl.example/char.fbx', name: 'char.fbx' },
              { url: 'https://dl.example/basecolor.png', name: 'basecolor.png' },
            ],
          }),
      },
      { test: /model\.glb$/, handler: () => bytesResp(GLB_BYTES) },
      { test: /preview\.webp$/, handler: () => bytesResp(PNG_BYTES) },
      { test: /char\.fbx$/, handler: () => bytesResp(new Uint8Array([1, 2, 3])) },
      { test: /basecolor\.png$/, handler: () => bytesResp(PNG_BYTES) },
    ])
    const provider = new RodinProvider({ fetchImpl, sleep })
    const result = await provider.pollTask(await provider.submitGeneration({ mode: 'text', prompt: 'knight' }))

    expect(result).toMatchObject({
      provider: 'rodin',
      taskId: UUID,
      kind: 'generate',
      status: 'succeeded',
      downloads: {
        glb: 'https://dl.example/model.glb',
        fbx: 'https://dl.example/char.fbx',
        previewImage: 'https://dl.example/preview.webp',
        textureUrls: ['https://dl.example/basecolor.png'],
      },
    })
    expect(result.files).toHaveLength(4)
    expect(result.files[0]).toMatchObject({ name: 'model.glb', url: 'https://dl.example/model.glb' })
    expect(result.raw).toMatchObject({ error: 'OK' })
    expect(poll).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(DEFAULT_POLL_INTERVAL_MS)
    // status 请求体带 subscription_key；download 请求体带任务 uuid（非 job uuid）
    const statusCall = calls.find((c) => c.url.endsWith('/api/v2/status'))
    expect(JSON.parse(bodyOf(statusCall?.init))).toEqual({ subscription_key: SUB_KEY })
    const dlCall = calls.find((c) => c.url.endsWith('/api/v2/download'))
    expect(JSON.parse(bodyOf(dlCall?.init))).toEqual({ task_uuid: UUID })
  })

  it('任一 job Failed → provider_http_error（消息含 status=Failed 上下文）', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /\/api\/v2\/status$/, handler: () => jsonResp({ jobs: [{ uuid: 'j1', status: 'Failed' }] }) },
    ])
    const provider = new RodinProvider({ fetchImpl, sleep: async () => {} })
    await expect(provider.pollTask(await provider.submitGeneration({ mode: 'text', prompt: 'x' }))).rejects.toMatchObject(
      {
        code: 'provider_http_error',
        message: expect.stringContaining('status=Failed'),
        retryable: false,
      },
    )
  })

  it('轮询被限流（status 429）→ provider_rate_limited', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /\/api\/v2\/status$/, handler: () => new Response('{}', { status: 429 }) },
    ])
    const provider = new RodinProvider({ fetchImpl, sleep: async () => {} })
    await expect(provider.pollTask(await provider.submitGeneration({ mode: 'text', prompt: 'x' }))).rejects.toMatchObject(
      {
        code: 'provider_rate_limited',
      },
    )
  })

  it('轮询超时 → provider_timeout', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /\/api\/v2\/status$/, handler: () => jsonResp({ jobs: [{ uuid: 'j1', status: 'Waiting' }] }) },
    ])
    const provider = new RodinProvider({ fetchImpl, sleep: async () => {} })
    await expect(
      provider.pollTask(await provider.submitGeneration({ mode: 'text', prompt: 'x' }), { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'provider_timeout' })
  })

  it('下载列表为空 → provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /\/api\/v2\/status$/, handler: () => jsonResp({ jobs: [{ uuid: 'j1', status: 'Done' }] }) },
      { test: /\/api\/v2\/download$/, handler: () => jsonResp({ error: 'OK', list: [] }) },
    ])
    const provider = new RodinProvider({ fetchImpl, sleep: async () => {} })
    await expect(provider.pollTask(await provider.submitGeneration({ mode: 'text', prompt: 'x' }))).rejects.toMatchObject(
      {
        code: 'provider_empty_download',
      },
    )
  })

  it('GLB magic 校验失败 → provider_empty_download', async () => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
      { test: /\/api\/v2\/status$/, handler: () => jsonResp({ jobs: [{ uuid: 'j1', status: 'Done' }] }) },
      {
        test: /\/api\/v2\/download$/,
        handler: () => jsonResp({ error: 'OK', list: [{ url: 'https://dl.example/bad.glb', name: 'bad.glb' }] }),
      },
      { test: /bad\.glb$/, handler: () => bytesResp(new Uint8Array([1, 2, 3, 4])) },
    ])
    const provider = new RodinProvider({ fetchImpl, sleep: async () => {} })
    await expect(provider.pollTask(await provider.submitGeneration({ mode: 'text', prompt: 'x' }))).rejects.toMatchObject(
      {
        code: 'provider_empty_download',
      },
    )
  })
})

describe('错误映射', () => {
  it.each([
    ['NO_ACTIVE_SUBSCRIPTION', 'provider_insufficient_credits'],
    ['SUBSCRIPTION_PLAN_TOO_LOW', 'provider_insufficient_credits'],
    ['INSUFFICIENT_FUND', 'provider_insufficient_credits'],
    ['INVALID_REQUEST', 'provider_bad_request'],
    ['PERMISSION_DENIED', 'provider_unauthorized'],
    ['USER_NOT_FOUND', 'provider_unauthorized'],
    ['GROUP_NOT_FOUND', 'provider_unauthorized'],
    ['UNKNOWN', 'provider_http_error'],
  ] as const)('创建响应 error=%s → %s', async (error, code) => {
    const { fetchImpl } = mockFetch([
      { test: /\/api\/v2\/rodin$/, handler: () => jsonResp({ error, message: 'detail-msg' }, 201) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'x' })).rejects.toMatchObject({ code })
  })

  it('订阅门槛错误消息注明 Business 订阅门槛', async () => {
    const { fetchImpl } = mockFetch([
      {
        test: /\/api\/v2\/rodin$/,
        handler: () =>
          jsonResp({ error: 'SUBSCRIPTION_PLAN_TOO_LOW', message: 'Business subscription is required' }, 201),
      },
    ])
    const provider = new RodinProvider({ fetchImpl })
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'x' })).rejects.toMatchObject({
      code: 'provider_insufficient_credits',
      message: expect.stringContaining('Business'),
      retryable: false,
    })
  })

  it('HTTP 状态兜底：429 → rate_limited 可重试、401 → unauthorized、500 → http_error 可重试', async () => {
    const cases: Array<[status: number, code: string, retryable: boolean]> = [
      [429, 'provider_rate_limited', true],
      [401, 'provider_unauthorized', false],
      [500, 'provider_http_error', true],
    ]
    for (const [status, code, retryable] of cases) {
      const { fetchImpl } = mockFetch([
        { test: /\/api\/v2\/rodin$/, handler: () => new Response('oops', { status }) },
      ])
      const provider = new RodinProvider({ fetchImpl })
      await expect(provider.submitGeneration({ mode: 'text', prompt: 'x' })).rejects.toMatchObject({
        code,
        retryable,
      })
    }
  })
})

describe('balance', () => {
  it('getBalance 返回剩余积分与原始响应', async () => {
    const { fetchImpl } = mockFetch([{ test: /\/check_balance$/, handler: () => jsonResp({ balance: 12 }) }])
    const provider = new RodinProvider({ fetchImpl })
    await expect(provider.getBalance()).resolves.toEqual({ balance: 12, raw: { balance: 12 } })
  })

  it('响应缺 balance 字段 → provider_http_error', async () => {
    const { fetchImpl } = mockFetch([{ test: /\/check_balance$/, handler: () => jsonResp({}) }])
    const provider = new RodinProvider({ fetchImpl })
    await expect(provider.getBalance()).rejects.toMatchObject({ code: 'provider_http_error' })
  })
})

describe('bang 扩展方法（模型拆分，0.5 credit/次）', () => {
  it('asset_id 模式：表单字段正确且无文件', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/bang$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    const result = await provider.bang({ assetId: UUID })
    expect(result).toMatchObject({ provider: 'rodin', taskId: UUID, kind: 'bang' })
    const form = formOf(calls.find((c) => c.url.endsWith('/api/v2/bang'))?.init)!
    expect(form.get('asset_id')).toBe(UUID)
    expect(form.get('strength')).toBe('5')
    expect(form.get('geometry_file_format')).toBe('glb')
    expect(form.get('material')).toBe('PBR')
    expect(form.get('resolution')).toBe('Basic')
    expect(form.has('model')).toBe(false)
  })

  it('自定义模型模式：model/image 文件字节 + prompt + 自定义参数', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/bang$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    await provider.bang({
      modelBytes: new Uint8Array([1, 2, 3]),
      modelName: 'char.obj',
      imageBytes: PNG_BYTES,
      imageName: 'ref.png',
      prompt: 'split it',
      strength: 8,
      geometryFileFormat: 'obj',
      material: 'All',
      resolution: 'High',
    })
    const form = formOf(calls.find((c) => c.url.endsWith('/api/v2/bang'))?.init)!
    expect(form.has('asset_id')).toBe(false)
    const model = await fileOf(form, 'model')
    expect(model).toMatchObject({ name: 'char.obj' })
    expect(model!.bytes).toEqual(new Uint8Array([1, 2, 3]))
    const image = await fileOf(form, 'image')
    expect(image).toMatchObject({ name: 'ref.png' })
    expect(image!.bytes).toEqual(PNG_BYTES)
    expect(form.get('prompt')).toBe('split it')
    expect(form.get('strength')).toBe('8')
    expect(form.get('geometry_file_format')).toBe('obj')
    expect(form.get('material')).toBe('All')
    expect(form.get('resolution')).toBe('High')
  })

  it('asset_id 与 model 互斥；strength 越界 → provider_bad_request', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('不应发起任何请求')
    }
    const provider = new RodinProvider({ fetchImpl })
    await expect(provider.bang({})).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.bang({ assetId: 'u', modelBytes: new Uint8Array([1]) }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(provider.bang({ assetId: 'u', strength: 1 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.bang({ assetId: 'u', strength: 13 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })
})

describe('textureOnly 扩展方法（重贴图，0.5 credit/次）', () => {
  it('image + model 文件与参数进表单；句柄 kind 为 texture-only', async () => {
    const { fetchImpl, calls } = mockFetch([
      { test: /\/api\/v2\/rodin_texture_only$/, handler: () => jsonResp(submitBody(UUID, SUB_KEY), 201) },
    ])
    const provider = new RodinProvider({ fetchImpl })
    const result = await provider.textureOnly({
      imageBytes: PNG_BYTES,
      imageName: 'ref.png',
      modelBytes: new Uint8Array([9, 9]),
      modelName: 'low.obj',
      prompt: 'texture it',
      seed: 42,
      referenceScale: 1.5,
      geometryFileFormat: 'obj',
      material: 'Shaded',
      resolution: 'High',
    })
    expect(result).toMatchObject({ provider: 'rodin', taskId: UUID, kind: 'texture-only' })
    const form = formOf(calls.find((c) => c.url.endsWith('/rodin_texture_only'))?.init)!
    const image = await fileOf(form, 'image')
    expect(image).toMatchObject({ name: 'ref.png' })
    expect(image!.bytes).toEqual(PNG_BYTES)
    const model = await fileOf(form, 'model')
    expect(model).toMatchObject({ name: 'low.obj' })
    expect(model!.bytes).toEqual(new Uint8Array([9, 9]))
    expect(form.get('prompt')).toBe('texture it')
    expect(form.get('seed')).toBe('42')
    expect(form.get('reference_scale')).toBe('1.5')
    expect(form.get('geometry_file_format')).toBe('obj')
    expect(form.get('material')).toBe('Shaded')
    expect(form.get('resolution')).toBe('High')
  })

  it('model >10MB / 缺 image / 缺 model / seed 越界 → provider_bad_request', async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error('不应发起任何请求')
    }
    const provider = new RodinProvider({ fetchImpl })
    await expect(
      provider.textureOnly({ imageBytes: PNG_BYTES, modelBytes: new Uint8Array(10 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.textureOnly({ modelBytes: new Uint8Array([1]) } as RodinTextureOnlyInput),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.textureOnly({ imageBytes: PNG_BYTES } as RodinTextureOnlyInput),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.textureOnly({ imageBytes: PNG_BYTES, modelBytes: new Uint8Array([1]), seed: 70_000 }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })
})

describe('能力裁剪与订阅说明', () => {
  it('不暴露 submitRig / submitAnimation / listMotions（官方无此能力）', () => {
    const provider = new RodinProvider({ fetchImpl: async () => new Response() })
    expect('submitRig' in provider).toBe(false)
    expect('submitAnimation' in provider).toBe(false)
    expect('listMotions' in provider).toBe(false)
  })

  it('subscriptionNote / RODIN_SUBSCRIPTION_NOTE 说明 Business 订阅门槛', () => {
    const provider = new RodinProvider({ fetchImpl: async () => new Response() })
    expect(provider.subscriptionNote()).toContain('Business')
    expect(RODIN_SUBSCRIPTION_NOTE).toContain('Business')
    expect(RODIN_SUBSCRIPTION_NOTE).toContain('RODIN_API_KEY')
  })
})

describe('工具函数', () => {
  it('normalizeTier：缺省 Regular；未知值抛 provider_bad_request', () => {
    expect(normalizeTier(undefined)).toBe('Regular')
    expect(normalizeTier('Gen-2.5-Medium')).toBe('Gen-2.5-Medium')
    expect(normalizeTier('')).toBe('Regular')
    expect(() => normalizeTier('Gen-9')).toThrowError(expect.objectContaining({ code: 'provider_bad_request' }))
  })

  it('qualityOverrideRange 覆盖官方各 tier/mesh_mode 组合', () => {
    expect(qualityOverrideRange('Regular', undefined)).toEqual({ min: 2_000, max: 200_000 })
    expect(qualityOverrideRange('Gen-2', undefined)).toEqual({ min: 1_000, max: 200_000 })
    expect(qualityOverrideRange('Gen-2', 'Raw')).toEqual({ min: 500, max: 1_000_000 })
    expect(qualityOverrideRange('Gen-2', 'Quad')).toEqual({ min: 1_000, max: 200_000 })
    expect(qualityOverrideRange('Gen-2.5-Medium', undefined)).toEqual({ min: 500, max: 1_000_000 })
    expect(qualityOverrideRange('Gen-2.5-Medium', 'Quad')).toEqual({ min: 1_000, max: 200_000 })
    expect(qualityOverrideRange('Gen-2.5-High', 'Raw')).toEqual({ min: 20_000, max: 2_000_000 })
    expect(qualityOverrideRange('Gen-2.5-Extreme-High', 'Raw')).toEqual({ min: 20_000, max: 2_000_000 })
    expect(qualityOverrideRange('Gen-2.5-Extreme-Low', 'Raw')).toEqual({ min: 500, max: 1_000_000 })
  })

  it('clampQualityOverride：按范围钳制；Sketch 档剥离；非有限数值抛错', () => {
    expect(clampQualityOverride('Gen-2', 'Quad', 500_000)).toBe(200_000)
    expect(clampQualityOverride('Gen-2', 'Raw', 500_000)).toBe(500_000)
    expect(clampQualityOverride('Gen-2.5-High', 'Raw', 9_999_999)).toBe(2_000_000)
    expect(clampQualityOverride('Regular', undefined, 100)).toBe(2_000)
    expect(clampQualityOverride('Regular', undefined, 1_000_000)).toBe(200_000)
    expect(clampQualityOverride('Sketch', undefined, 100_000)).toBeUndefined()
    expect(() => clampQualityOverride('Gen-2', 'Raw', Number.NaN)).toThrowError(
      expect.objectContaining({ code: 'provider_bad_request' }),
    )
  })

  it('mapRodinError：枚举 → 契约错误码（订阅门槛消息含 Business）', () => {
    expect(mapRodinError('SUBSCRIPTION_PLAN_TOO_LOW', 'Business subscription is required').code).toBe(
      'provider_insufficient_credits',
    )
    expect(mapRodinError('SUBSCRIPTION_PLAN_TOO_LOW', 'x').message).toContain('Business')
    expect(mapRodinError('NO_ACTIVE_SUBSCRIPTION', 'x').code).toBe('provider_insufficient_credits')
    expect(mapRodinError('INSUFFICIENT_FUND', 'x').code).toBe('provider_insufficient_credits')
    expect(mapRodinError('INVALID_REQUEST', 'x').code).toBe('provider_bad_request')
    expect(mapRodinError('PERMISSION_DENIED', 'x').code).toBe('provider_unauthorized')
    expect(mapRodinError('USER_NOT_FOUND', 'x').code).toBe('provider_unauthorized')
    expect(mapRodinError('GROUP_NOT_FOUND', 'x').code).toBe('provider_unauthorized')
    expect(mapRodinError('UNKNOWN', 'x').code).toBe('provider_http_error')
  })

  it('mapRodinHttpStatus：429 限流可重试、401 未授权、5xx 可重试', () => {
    expect(mapRodinHttpStatus(429, 'throttle')).toMatchObject({ code: 'provider_rate_limited', retryable: true })
    expect(mapRodinHttpStatus(401, 'unauth')).toMatchObject({ code: 'provider_unauthorized', retryable: false })
    expect(mapRodinHttpStatus(403, 'forbidden')).toMatchObject({ code: 'provider_unauthorized' })
    expect(mapRodinHttpStatus(500, 'boom')).toMatchObject({ code: 'provider_http_error', retryable: true })
    expect(mapRodinHttpStatus(400, 'bad')).toMatchObject({ code: 'provider_bad_request' })
  })
})
