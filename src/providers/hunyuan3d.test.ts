/**
 * Hunyuan3D provider 直连实现单测（vitest，全 mock fetch，不打真网）。
 *
 * 签名断言基准：固定输入经 Node crypto 与 Python hmac 两个独立实现交叉验证一致
 * （见实现期开发记录），故直接硬编码期望值，保证稳定输入输出。
 *
 * 公共契约以 src/providers/types.ts（基础设施分工正式版）为准：
 * - TaskHandle 只含 { provider, taskId }，轮询路径由 provider 进程内任务表记录，
 *   因此测试中的 handle 一律先经 submit* 方法获得（不可手工拼造）；
 * - TaskResult 为 { status, downloads, ... }，downloads 为下载物映射。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readHunyuanSecretId, readHunyuanSecretKey, readProviderKey } from '../config.js'
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  HUNYUAN_MOTION_TYPES,
  HUNYUAN3D_PROVIDER_ID,
  TC3_ENDPOINT,
  TC3_REGION,
  TC3_SERVICE,
  TC3_VERSION,
  TOKENHUB_QUERY_URL,
  TOKENHUB_SUBMIT_URL,
  buildAuthorizationHeader,
  buildCanonicalRequest,
  buildStringToSign,
  computeSignature,
  deriveSigningKey,
  mapTc3Error,
  mapTokenHubHttpError,
  sha256Hex,
  signTc3Request,
  tc3DateOf,
} from './hunyuan3d.js'
import { Hunyuan3dProvider } from './hunyuan3d.js'

// 凭证读取统一走 src/config.ts（mock 掉，确保用例不依赖真实环境变量 / 凭证文件）
vi.mock('../config.js', () => ({
  readProviderKey: vi.fn(),
  readHunyuanSecretId: vi.fn(),
  readHunyuanSecretKey: vi.fn(),
}))

const mockedReadProviderKey = vi.mocked(readProviderKey)
const mockedReadSecretId = vi.mocked(readHunyuanSecretId)
const mockedReadSecretKey = vi.mocked(readHunyuanSecretKey)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * 每次调用都返回新 Response 的 mock 工厂（Response body 只能消费一次，
 * 同一 mock 多次调用时必须新建实例，否则后续 json() 读到空流）。
 */
function fetchResponder(body: unknown, status = 200): () => Promise<Response> {
  return () => Promise.resolve(jsonResponse(body, status))
}

function errorCodeOf(e: unknown): { code: string; message: string; httpStatus?: number; retryable?: boolean } {
  const err = e as { code?: string; message?: string; httpStatus?: number; retryable?: boolean }
  return { code: err.code ?? '', message: err.message ?? '', httpStatus: err.httpStatus, retryable: err.retryable }
}

/** 测试用固定 TC3 签名输入（与实现期交叉验证的向量一致） */
const SIGN_FIXTURE = {
  secretId: 'AKIDTEST1234567890',
  secretKey: 'TESTKEYabcdef123456',
  service: TC3_SERVICE,
  host: 'ai3d.tencentcloudapi.com',
  payload: '{"Model":"3.1","Prompt":"一只小狗"}',
  timestamp: 1_774_806_931,
  date: '2026-03-29',
  payloadHash: '8fc0e261816a4559cc56228385af16942ad0a12e1e2158d2002ae88d8313f5db',
  canonicalRequestHash: '0d8dc86efb1d15fd677be98cd2e7ef1449765271ca88161c2a16385442f43cfe',
  signature: '8c3c5c492daa8dc1fc40958c4b20a98280893c6af629eb1fb05b533a3b38f557',
  authorization:
    'TC3-HMAC-SHA256 Credential=AKIDTEST1234567890/2026-03-29/ai3d/tc3_request, SignedHeaders=content-type;host, Signature=8c3c5c492daa8dc1fc40958c4b20a98280893c6af629eb1fb05b533a3b38f557',
}

describe('TC3-HMAC-SHA256 签名（稳定输入输出）', () => {
  it('sha256Hex / tc3DateOf', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(tc3DateOf(SIGN_FIXTURE.timestamp)).toBe(SIGN_FIXTURE.date)
  })

  it('buildCanonicalRequest 规范请求', () => {
    const { canonicalRequest, signedHeaders } = buildCanonicalRequest({
      method: 'POST',
      uri: '/',
      query: '',
      contentType: 'application/json; charset=utf-8',
      host: SIGN_FIXTURE.host,
      payloadHash: SIGN_FIXTURE.payloadHash,
    })
    expect(signedHeaders).toBe('content-type;host')
    expect(canonicalRequest).toBe(
      [
        'POST',
        '/',
        '',
        'content-type:application/json; charset=utf-8\nhost:ai3d.tencentcloudapi.com\n',
        'content-type;host',
        SIGN_FIXTURE.payloadHash,
      ].join('\n'),
    )
  })

  it('buildStringToSign / deriveSigningKey / computeSignature 链路', () => {
    const { canonicalRequest } = buildCanonicalRequest({
      method: 'POST',
      uri: '/',
      query: '',
      contentType: 'application/json; charset=utf-8',
      host: SIGN_FIXTURE.host,
      payloadHash: SIGN_FIXTURE.payloadHash,
    })
    const stringToSign = buildStringToSign(SIGN_FIXTURE.timestamp, SIGN_FIXTURE.date, SIGN_FIXTURE.service, canonicalRequest)
    expect(stringToSign).toBe(
      `TC3-HMAC-SHA256\n${SIGN_FIXTURE.timestamp}\n${SIGN_FIXTURE.date}/${SIGN_FIXTURE.service}/tc3_request\n${SIGN_FIXTURE.canonicalRequestHash}`,
    )
    const key = deriveSigningKey(SIGN_FIXTURE.secretKey, SIGN_FIXTURE.date, SIGN_FIXTURE.service)
    expect(computeSignature(key, stringToSign)).toBe(SIGN_FIXTURE.signature)
  })

  it('signTc3Request 完整签名（固定输入 → 固定输出）', () => {
    const result = signTc3Request({
      secretId: SIGN_FIXTURE.secretId,
      secretKey: SIGN_FIXTURE.secretKey,
      service: SIGN_FIXTURE.service,
      host: SIGN_FIXTURE.host,
      payload: SIGN_FIXTURE.payload,
      timestamp: SIGN_FIXTURE.timestamp,
    })
    expect(result.date).toBe(SIGN_FIXTURE.date)
    expect(result.contentType).toBe('application/json; charset=utf-8')
    expect(result.authorization).toBe(SIGN_FIXTURE.authorization)
  })

  it('buildAuthorizationHeader 组装', () => {
    const header = buildAuthorizationHeader({
      secretId: SIGN_FIXTURE.secretId,
      date: SIGN_FIXTURE.date,
      service: SIGN_FIXTURE.service,
      signedHeaders: 'content-type;host',
      signature: SIGN_FIXTURE.signature,
    })
    expect(header).toBe(SIGN_FIXTURE.authorization)
  })
})

describe('凭证配置', () => {
  beforeEach(() => {
    mockedReadProviderKey.mockReturnValue(undefined)
    mockedReadSecretId.mockReturnValue(undefined)
    mockedReadSecretKey.mockReturnValue(undefined)
  })

  it('未配置任何凭证 → isConfigured false，生成 / 后处理均抛 provider_not_configured', async () => {
    const provider = new Hunyuan3dProvider()
    expect(provider.isConfigured()).toBe(false)
    expect(provider.id).toBe('hunyuan3d')
    await expect(provider.submitGeneration({ mode: 'text', prompt: '一只小狗' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.submitRig({ assetUrl: 'https://x/f.fbx' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.submitMotionJob({ prompt: '走路' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
    await expect(provider.submitSmartTopology({ fileUrl: 'https://x/m.glb', fileType: 'GLB' })).rejects.toMatchObject({
      code: 'provider_not_configured',
    })
  })

  it('凭证经 src/config.ts 读取（readProviderKey / readHunyuanSecretId / readHunyuanSecretKey）', () => {
    mockedReadProviderKey.mockReturnValue('env-tokenhub-key')
    mockedReadSecretId.mockReturnValue('env-secret-id')
    mockedReadSecretKey.mockReturnValue('env-secret-key')
    const provider = new Hunyuan3dProvider()
    expect(provider.isConfigured()).toBe(true)
    expect(mockedReadProviderKey).toHaveBeenCalledWith('hunyuan3d')
    expect(mockedReadSecretId).toHaveBeenCalled()
    expect(mockedReadSecretKey).toHaveBeenCalled()
  })

  it('仅 TokenHub key → 配置可用', () => {
    const provider = new Hunyuan3dProvider({ tokenHubApiKey: 'k' })
    expect(provider.isConfigured()).toBe(true)
  })

  it('仅 TC3 凭证 → 配置可用；生成类回退 TC3 路径', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ Response: { JobId: 'j1', RequestId: 'r1' } }))
    const provider = new Hunyuan3dProvider({ tc3SecretId: 'sid', tc3SecretKey: 'skey', fetchImpl: fetchMock as never })
    expect(provider.isConfigured()).toBe(true)
    const handle = await provider.submitGeneration({ mode: 'text', prompt: '一只小狗' })
    expect(handle).toEqual({ taskId: 'j1', provider: 'hunyuan3d' })
    expect(fetchMock).toHaveBeenCalledWith(
      TC3_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-TC-Action': 'SubmitHunyuanTo3DProJob' }),
      }),
    )
  })
})

describe('TokenHub 提交（路径 A）', () => {
  const fetchMock = vi.fn()
  let provider: Hunyuan3dProvider

  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockImplementation(fetchResponder({ id: 'task-1', status: 'queued', object: '3d_job' }))
    provider = new Hunyuan3dProvider({ tokenHubApiKey: 'test-key', fetchImpl: fetchMock as never })
  })

  it('文生 3D：URL / Bearer 头 / body 正确，返回公共契约 TaskHandle', async () => {
    const handle = await provider.submitGeneration({ mode: 'text', prompt: '一只小狗' })
    expect(handle).toEqual({ taskId: 'task-1', provider: 'hunyuan3d' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(TOKENHUB_SUBMIT_URL)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'hy-3d-3.0', prompt: '一只小狗' })
  })

  it('文生缺 prompt → provider_bad_request', async () => {
    await expect(provider.submitGeneration({ mode: 'text', prompt: '' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('图生 3D：imageUrls[0] → image_url', async () => {
    await provider.submitGeneration({ mode: 'image', prompt: '', imageUrls: ['https://cdn/a.png'] })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ model: 'hy-3d-3.0', image_url: 'https://cdn/a.png' })
  })

  it('图生 3D：providerOptions.imageBase64 走 image_base64', async () => {
    await provider.submitGeneration({
      mode: 'image',
      prompt: '',
      providerOptions: { imageBase64: 'AAAA' },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ model: 'hy-3d-3.0', image_base64: 'AAAA' })
  })

  it('图生缺图 → provider_bad_request', async () => {
    await expect(provider.submitGeneration({ mode: 'image', prompt: '' })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
  })

  it('多视图：默认按官方视角名序列分配（3 视图 → left/right/back）', async () => {
    await provider.submitGeneration({
      mode: 'views',
      prompt: '',
      imageUrls: ['https://cdn/v1.png', 'https://cdn/v2.png', 'https://cdn/v3.png'],
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { multi_view_images: { name: string; image_url: string }[] }
    expect(body.multi_view_images).toEqual([
      { name: 'left', image_url: 'https://cdn/v1.png' },
      { name: 'right', image_url: 'https://cdn/v2.png' },
      { name: 'back', image_url: 'https://cdn/v3.png' },
    ])
  })

  it('多视图 3.1 八视图：7 张图按全集序列分配，viewNames 可显式覆盖', async () => {
    const urls = Array.from({ length: 7 }, (_, i) => `https://cdn/v${i + 1}.png`)
    await provider.submitGeneration({
      mode: 'views',
      prompt: '',
      imageUrls: urls,
      providerOptions: { model: 'hy-3d-3.1' },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body)) as { model: string; multi_view_images: { name: string }[] }
    expect(body.model).toBe('hy-3d-3.1')
    expect(body.multi_view_images.map((v) => v.name)).toEqual([
      'left',
      'right',
      'back',
      'top',
      'bottom',
      'left_front',
      'right_front',
    ])

    // 显式 viewNames（如官方新增第 8 视角名时由调用方提供）
    await provider.submitGeneration({
      mode: 'views',
      prompt: '',
      imageUrls: [...urls, 'https://cdn/v8.png'],
      providerOptions: {
        model: 'hy-3d-3.1',
        viewNames: ['left', 'right', 'back', 'top', 'bottom', 'left_front', 'right_front', 'left'],
      },
    })
  })

  it('多视图图片数超过可用视角名 → provider_bad_request；3.0 不允许 3.1 专属视角', async () => {
    await expect(
      provider.submitGeneration({
        mode: 'views',
        prompt: '',
        imageUrls: Array.from({ length: 8 }, () => 'https://cdn/v.png'),
      }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.submitGeneration({
        mode: 'views',
        prompt: '',
        imageUrls: ['https://cdn/v.png', 'https://cdn/v.png', 'https://cdn/v.png'],
        providerOptions: { viewNames: ['top', 'left', 'right'] },
      }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('未知模型 → provider_bad_request', async () => {
    await expect(
      provider.submitGeneration({ mode: 'text', prompt: 'x', providerOptions: { model: 'hy-3d-9.9' } }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('HTTP 401 → provider_unauthorized', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid api key' } }, 401))
    const e = errorCodeOf(await provider.submitGeneration({ mode: 'text', prompt: 'x' }).catch((err) => err))
    expect(e.code).toBe('provider_unauthorized')
    expect(e.httpStatus).toBe(401)
  })

  it('HTTP 429 → provider_rate_limited（可重试）', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'too many requests' } }, 429))
    const e = errorCodeOf(await provider.submitGeneration({ mode: 'text', prompt: 'x' }).catch((err) => err))
    expect(e.code).toBe('provider_rate_limited')
    expect(e.retryable).toBe(true)
  })

  it('HTTP 500 → provider_http_error（可重试）', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(jsonResponse({}, 500))
    const e = errorCodeOf(await provider.submitGeneration({ mode: 'text', prompt: 'x' }).catch((err) => err))
    expect(e.code).toBe('provider_http_error')
    expect(e.retryable).toBe(true)
  })

  it('提交响应缺 id → provider_http_error', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue(jsonResponse({ status: 'queued' }))
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'x' })).rejects.toMatchObject({
      code: 'provider_http_error',
    })
  })

  it('fetch 网络错误 → provider_http_error（可重试）', async () => {
    fetchMock.mockReset()
    fetchMock.mockRejectedValue(new TypeError('fetch failed'))
    const e = errorCodeOf(await provider.submitGeneration({ mode: 'text', prompt: 'x' }).catch((err) => err))
    expect(e.code).toBe('provider_http_error')
    expect(e.retryable).toBe(true)
  })

  it('高级参数（providerOptions 透传，小写下划线 wire 格式）', async () => {
    await provider.submitGeneration({
      mode: 'text',
      prompt: 'x',
      providerOptions: {
        model: 'hy-3d-3.1',
        generateType: 'LowPoly',
        enablePbr: true,
        faceCount: 300_000,
        polygonType: 'quadrilateral',
        resultFormat: 'FBX',
      },
    })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'hy-3d-3.1',
      prompt: 'x',
      generate_type: 'LowPoly',
      enable_pbr: true,
      face_count: 300_000,
      polygon_type: 'quadrilateral',
      result_format: 'FBX',
    })
  })
})

describe('TokenHub 轮询（路径 A）', () => {
  const fetchMock = vi.fn()
  let provider: Hunyuan3dProvider

  beforeEach(() => {
    fetchMock.mockReset()
    provider = new Hunyuan3dProvider({
      tokenHubApiKey: 'test-key',
      fetchImpl: fetchMock as never,
      pollIntervalMs: 1,
    })
  })

  it('queued → in_progress → completed：多次轮询，downloads 映射 Type/Url/PreviewImageUrl', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', status: 'queued' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'queued', request_id: 'q1' }))
      .mockResolvedValueOnce(jsonResponse({ status: 'in_progress', request_id: 'q1' }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'completed',
          data: [
            { type: 'obj', url: 'https://cdn/a.obj', preview_image_url: 'https://cdn/a.png' },
            { type: 'glb', url: 'https://cdn/a.glb', preview_image_url: 'https://cdn/a.png' },
          ],
        }),
      )
    const handle = await provider.submitGeneration({ mode: 'text', prompt: '一只小狗' })
    const result = await provider.pollTask(handle)
    // submit 1 次 + 查询 3 次
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      TOKENHUB_QUERY_URL,
      expect.objectContaining({ body: JSON.stringify({ model: 'hy-3d-3.0', id: 'task-1' }) }),
    )
    expect(result.status).toBe('succeeded')
    // 主模型槽 glb 优先（obj 兜底），预览图进 previewImage
    expect(result.downloads.glb).toBe('https://cdn/a.glb')
    expect(result.downloads.previewImage).toBe('https://cdn/a.png')
  })

  it('completed 但无结果文件 → provider_http_error', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', status: 'queued' }))
      .mockResolvedValue(jsonResponse({ status: 'completed', data: [] }))
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle)).rejects.toMatchObject({ code: 'provider_http_error' })
  })

  it('error 字段 → 立即抛（不再轮询）', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', status: 'queued' }))
      .mockResolvedValue(jsonResponse({ status: 'in_progress', error: { message: 'job failed: bad prompt' } }))
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle)).rejects.toMatchObject({ code: 'provider_http_error' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('查询 HTTP 429 → provider_rate_limited', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', status: 'queued' }))
      .mockResolvedValue(jsonResponse({ error: { message: 'rate limited' } }, 429))
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle)).rejects.toMatchObject({ code: 'provider_rate_limited' })
  })

  it('默认轮询参数为 5s / 10min', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(5_000)
    expect(DEFAULT_POLL_TIMEOUT_MS).toBe(10 * 60_000)
  })

  it('轮询超时（真实任务）：provider_timeout 且停止轮询', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'task-1', status: 'queued' }))
    fetchMock.mockImplementation(fetchResponder({ status: 'in_progress' }))
    const slow = new Hunyuan3dProvider({
      tokenHubApiKey: 'test-key',
      fetchImpl: fetchMock as never,
      pollIntervalMs: 5,
      pollTimeoutMs: 40,
    })
    const handle = await slow.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(slow.pollTask(handle)).rejects.toMatchObject({ code: 'provider_timeout' })
    // 40ms / 5ms 间隔 → 约 8~9 次查询后超时；确认没有无限轮询
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(12)
  })

  it('调用方 signal 中止 → 抛 AbortError', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', status: 'queued' }))
      .mockResolvedValue(jsonResponse({ status: 'in_progress' }))
    const controller = new AbortController()
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    const poll = provider.pollTask(handle, { signal: controller.signal })
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))
    controller.abort()
    await expect(poll).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('provider.abort(taskId) 任务级取消 → 抛 AbortError', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ id: 'task-1', status: 'queued' }))
      .mockResolvedValue(jsonResponse({ status: 'in_progress' }))
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    const poll = provider.pollTask(handle)
    await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2))
    provider.abort(handle, 'user cancelled')
    await expect(poll).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('腾讯云 API 3.0（路径 B：TC3 签名 + 后处理）', () => {
  const fetchMock = vi.fn()
  let provider: Hunyuan3dProvider

  function tc3Response(body: unknown): Response {
    return jsonResponse({ Response: body })
  }

  beforeEach(() => {
    fetchMock.mockReset()
    provider = new Hunyuan3dProvider({
      // 不传 tokenHubApiKey —— 生成类提交按"TokenHub 优先"，传了会绕过 TC3 路径
      tc3SecretId: 'sid',
      tc3SecretKey: 'skey',
      fetchImpl: fetchMock as never,
      pollIntervalMs: 1,
    })
  })

  it('生成提交：请求头含 TC3 公共参数与签名，body 为 PascalCase 业务参数', async () => {
    fetchMock.mockResolvedValue(tc3Response({ JobId: 'job-1', RequestId: 'req-1' }))
    const handle = await provider.submitGeneration({
      mode: 'text',
      prompt: '一只小狗',
      providerOptions: { model: 'hy-3d-3.1', enablePbr: true },
    })
    expect(handle).toEqual({ taskId: 'job-1', provider: 'hunyuan3d' })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(TC3_ENDPOINT)
    const headers = init.headers as Record<string, string>
    expect(headers['X-TC-Action']).toBe('SubmitHunyuanTo3DProJob')
    expect(headers['X-TC-Version']).toBe(TC3_VERSION)
    expect(headers['X-TC-Region']).toBe(TC3_REGION)
    expect(headers['X-TC-Signature-Version']).toBe('TC3-HMAC-SHA256')
    expect(Number(headers['X-TC-Timestamp'])).toBeGreaterThan(1_700_000_000)
    expect(headers.Authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=sid\/\d{4}-\d{2}-\d{2}\/ai3d\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
    )
    expect(headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse(String(init.body))).toEqual({ Model: '3.1', Prompt: '一只小狗', EnablePBR: true })
  })

  it('生成提交响应缺 JobId → provider_http_error', async () => {
    fetchMock.mockResolvedValue(tc3Response({ RequestId: 'req-1' }))
    await expect(provider.submitGeneration({ mode: 'text', prompt: 'x' })).rejects.toMatchObject({
      code: 'provider_http_error',
    })
  })

  it('自动绑骨（契约 submitRig）：SubmitAutoRiggingJob + MotionType 预设动作', async () => {
    fetchMock.mockResolvedValue(tc3Response({ JobId: 'rig-1' }))
    const handle = await provider.submitRig({
      assetUrl: 'https://cdn/char.fbx',
      providerOptions: { motionType: 23 },
    })
    expect(handle).toEqual({ taskId: 'rig-1', provider: 'hunyuan3d' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-TC-Action']).toBe('SubmitAutoRiggingJob')
    expect(JSON.parse(String(init.body))).toEqual({
      File3D: { Url: 'https://cdn/char.fbx', Type: 'FBX' },
      MotionType: 23,
    })
  })

  it('自动绑骨：不支持的文件类型（如 OBJ）→ provider_bad_request', async () => {
    await expect(
      provider.submitRig({ assetUrl: 'https://cdn/a.obj', providerOptions: { fileType: 'OBJ' } }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('文生动作（扩展 submitMotionJob）：prompt 必填 / ≤128 字符校验 + 可选参数', async () => {
    await expect(provider.submitMotionJob({ prompt: '' })).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(provider.submitMotionJob({ prompt: 'x'.repeat(129) })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    await expect(provider.submitMotionJob({ prompt: '走路', duration: 13 })).rejects.toMatchObject({
      code: 'provider_bad_request',
    })
    fetchMock.mockResolvedValue(tc3Response({ JobId: 'motion-1' }))
    const handle = await provider.submitMotionJob({
      prompt: 'A person walks forward',
      duration: 5,
      enableMesh: true,
      enableRewrite: false,
    })
    expect(handle.taskId).toBe('motion-1')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-TC-Action']).toBe('SubmitHunyuanTo3DMotionJob')
    expect(JSON.parse(String(init.body))).toEqual({
      Prompt: 'A person walks forward',
      Model: 'HY-Motion-1.0',
      Duration: 5,
      EnableMesh: true,
      EnableRewrite: false,
    })
  })

  it('智能拓扑（扩展 submitSmartTopology）：glb 输入 + FaceLevel/PolygonType；OBJ 也可', async () => {
    fetchMock.mockImplementation(fetchResponder({ Response: { JobId: 'topo-1' } }))
    const handle = await provider.submitSmartTopology({
      fileUrl: 'https://cdn/high.glb',
      fileType: 'GLB',
      faceLevel: 'low',
      polygonType: 'quadrilateral',
    })
    expect(handle.taskId).toBe('topo-1')
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-TC-Action']).toBe('Submit3DSmartTopologyJob')
    expect(JSON.parse(String(init.body))).toEqual({
      File3D: { Url: 'https://cdn/high.glb', Type: 'GLB' },
      FaceLevel: 'low',
      PolygonType: 'quadrilateral',
    })
    await provider.submitSmartTopology({ fileUrl: 'https://cdn/high.obj', fileType: 'OBJ' })
  })

  it('查询 DONE：downloads 映射 ResultFile3Ds，积分明细保留在 raw', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'rig-1' }))
      .mockResolvedValue(
        tc3Response({
          Status: 'DONE',
          ResultFile3Ds: [
            { Type: 'FBX', Url: 'https://cdn/rigged.fbx', PreviewImageUrl: 'https://cdn/p.png' },
          ],
          ResultCreditConsumed: 10,
          ResultCreditDetails: '{"AutoRigging":10}',
          RequestId: 'req-1',
        }),
      )
    const handle = await provider.submitRig({ assetUrl: 'https://cdn/char.fbx' })
    const result = await provider.pollTask(handle)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      TC3_ENDPOINT,
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-TC-Action': 'DescribeAutoRiggingJob' }),
        body: JSON.stringify({ JobId: 'rig-1' }),
      }),
    )
    expect(result.status).toBe('succeeded')
    expect(result.downloads.fbx).toBe('https://cdn/rigged.fbx')
    expect(result.downloads.previewImage).toBe('https://cdn/p.png')
    // 积分明细在 raw 中
    expect((result.raw as { ResultCreditConsumed: number }).ResultCreditConsumed).toBe(10)
  })

  it('查询 WAIT → RUN → DONE 多次轮询（生成类 QueryHunyuanTo3DProJob）', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-1' }))
      .mockResolvedValueOnce(tc3Response({ Status: 'WAIT' }))
      .mockResolvedValueOnce(tc3Response({ Status: 'RUN' }))
      .mockResolvedValueOnce(
        tc3Response({ Status: 'DONE', ResultFile3Ds: [{ Type: 'GLB', Url: 'https://cdn/a.glb' }] }),
      )
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    const result = await provider.pollTask(handle)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(result.downloads.glb).toBe('https://cdn/a.glb')
  })

  it('FAIL 终态立即抛（submit 后只查一次），错误码映射 ErrorCode', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-1' }))
      .mockResolvedValue(
        tc3Response({ Status: 'FAIL', ErrorCode: 'FailedOperation.InnerError', ErrorMessage: '服务内部错误' }),
      )
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    const e = errorCodeOf(await provider.pollTask(handle).catch((err) => err))
    expect(e.code).toBe('provider_http_error')
    expect(e.message).toBe('FailedOperation.InnerError: 服务内部错误')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('FAIL 且 ErrorCode=InvalidParameter → provider_bad_request', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-1' }))
      .mockResolvedValue(tc3Response({ Status: 'FAIL', ErrorCode: 'InvalidParameter', ErrorMessage: '参数错误' }))
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle)).rejects.toMatchObject({ code: 'provider_bad_request' })
  })

  it('请求级 AuthFailure → provider_unauthorized', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-1' }))
      .mockResolvedValue(
        jsonResponse(
          { Response: { Error: { Code: 'AuthFailure.SignatureFailure', Message: 'signature error' }, RequestId: 'r' } },
          200,
        ),
      )
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle)).rejects.toMatchObject({ code: 'provider_unauthorized' })
  })

  it('请求级 LimitExceeded → provider_rate_limited（可重试）', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-1' }))
      .mockResolvedValue(
        jsonResponse({ Response: { Error: { Code: 'LimitExceeded.QuotaNotEnough', Message: '频率超限' }, RequestId: 'r' } }),
      )
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    const e = errorCodeOf(await provider.pollTask(handle).catch((err) => err))
    expect(e.code).toBe('provider_rate_limited')
    expect(e.retryable).toBe(true)
  })

  it('请求级 ResourceInsufficient / ResourceUnavailable（计费配额）→ provider_insufficient_credits', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-1' }))
      .mockResolvedValue(
        jsonResponse({ Response: { Error: { Code: 'ResourceInsufficient.BalanceInsufficient', Message: '积分不足' } } }),
      )
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle)).rejects.toMatchObject({ code: 'provider_insufficient_credits' })

    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-2' }))
      .mockResolvedValue(
        jsonResponse({ Response: { Error: { Code: 'ResourceUnavailable.NotPurchased', Message: '未开通服务' } } }),
      )
    const handle2 = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle2)).rejects.toMatchObject({ code: 'provider_insufficient_credits' })
  })

  it('DONE 但无 ResultFile3Ds → provider_http_error', async () => {
    fetchMock
      .mockResolvedValueOnce(tc3Response({ JobId: 'job-1' }))
      .mockResolvedValue(tc3Response({ Status: 'DONE', ResultFile3Ds: [] }))
    const handle = await provider.submitGeneration({ mode: 'text', prompt: 'x' })
    await expect(provider.pollTask(handle)).rejects.toMatchObject({ code: 'provider_http_error' })
  })
})

describe('错误映射纯函数', () => {
  it('mapTokenHubHttpError：401/403 → unauthorized；429 → rate_limited；400 → bad_request；503 → http_error', () => {
    expect(mapTokenHubHttpError(401).code).toBe('provider_unauthorized')
    expect(mapTokenHubHttpError(403).code).toBe('provider_unauthorized')
    expect(mapTokenHubHttpError(429).code).toBe('provider_rate_limited')
    expect(mapTokenHubHttpError(429, { error: { message: 'queue is full' } }).code).toBe('provider_queue_full')
    expect(mapTokenHubHttpError(400).code).toBe('provider_bad_request')
    expect(mapTokenHubHttpError(503).code).toBe('provider_http_error')
    expect(mapTokenHubHttpError(503).retryable).toBe(true)
    expect(mapTokenHubHttpError(429, { message: '太多请求' }).retryable).toBe(true)
  })

  it('mapTc3Error：未知错误码但含计费关键词 → provider_insufficient_credits', () => {
    expect(mapTc3Error('SomeCode', '免费积分包已耗尽，请开通后付费').code).toBe('provider_insufficient_credits')
    expect(mapTc3Error(undefined, undefined).code).toBe('provider_http_error')
  })
})

describe('listMotions：官方 48 个预设动作', () => {
  it('id 连续 1–48，名称非空，抽查关键项', () => {
    expect(HUNYUAN_MOTION_TYPES).toHaveLength(48)
    HUNYUAN_MOTION_TYPES.forEach((m, i) => {
      expect(m.id).toBe(i + 1)
      expect(m.name.length).toBeGreaterThan(0)
    })
    const byId = new Map(HUNYUAN_MOTION_TYPES.map((m) => [m.id, m.name]))
    expect(byId.get(1)).toBe('回旋踢')
    expect(byId.get(23)).toBe('走路-1')
    expect(byId.get(37)).toBe('冲刺跑-3')
    expect(byId.get(48)).toBe('发送冲击波')
  })

  it('provider.listMotions() 返回 48 条 MotionItem（id + label），支持 query 过滤', async () => {
    const provider = new Hunyuan3dProvider({ tokenHubApiKey: 'k' })
    const all = await provider.listMotions()
    expect(all).toHaveLength(48)
    expect(all[0]).toEqual({ id: 1, label: '回旋踢' })
    const walk = await provider.listMotions({ query: '走路' })
    expect(walk.map((m) => m.label)).toEqual(['走路-1', '走路-2', '走路-3'])
  })
})

describe('任务归属校验', () => {
  it('轮询其他 provider 的 handle → provider_bad_request；未注册任务 → provider_http_error', async () => {
    const provider = new Hunyuan3dProvider({ tokenHubApiKey: 'k' })
    await expect(
      provider.pollTask({ taskId: 'x', provider: 'meshy' }),
    ).rejects.toMatchObject({ code: 'provider_bad_request' })
    await expect(
      provider.pollTask({ taskId: 'ghost', provider: 'hunyuan3d' }),
    ).rejects.toMatchObject({ code: 'provider_http_error' })
  })

  it('HUNYUAN3D_PROVIDER_ID 常量', () => {
    expect(HUNYUAN3D_PROVIDER_ID).toBe('hunyuan3d')
  })
})
