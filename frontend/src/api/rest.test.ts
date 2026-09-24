import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxiosRequestConfig } from 'axios'
import type {
  Api,
  ChunkConfig,
  Citation,
  ConversationInput,
  KnowledgeInput,
  ModelInput,
  Session,
  StreamEvent,
  UserInput,
} from '@/types'

const { http, create, isAxiosError } = vi.hoisted(() => {
  const http = { post: vi.fn(), request: vi.fn(), get: vi.fn() }
  return {
    http,
    create: vi.fn(() => http),
    isAxiosError: vi.fn((error: unknown) =>
      Boolean(
        error &&
          typeof error === 'object' &&
          'isAxiosError' in error &&
          error.isAxiosError === true,
      ),
    ),
  }
})
vi.mock('axios', () => ({ default: { create, isAxiosError } }))

const fetchMock = vi.fn<typeof fetch>()
const storage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(),
  length: 0,
}
const id = '目录/a ?#%&'
const encodedId = '%E7%9B%AE%E5%BD%95%2Fa%20%3F%23%25%26'
const modelInput: ModelInput = {
  name: '模型',
  type: 'chat',
  provider: 'custom',
  baseUrl: 'https://example.invalid',
  modelName: 'chat',
  enabled: true,
  description: '',
}
const userInput: UserInput = {
  username: 'reader',
  name: '读者',
  role: 'user',
  enabled: true,
  modelIds: [],
}
const chunkConfig: ChunkConfig = { chunkSize: 500, chunkOverlap: 50 }
const knowledgeInput: KnowledgeInput = {
  ...chunkConfig,
  name: '资料',
  description: '',
  embeddingModelId: 'embed',
  rerankModelId: '',
}
const conversationInput: ConversationInput = {
  title: '会话',
  modelId: 'chat',
  knowledgeBaseIds: [],
}
const citation: Citation = {
  id: 'c1',
  documentId: 'd1',
  knowledgeBaseId: 'k1',
  chunkId: 'chunk1',
  documentName: '资料.pdf',
  page: 2,
  section: '摘要',
  content: '引用正文',
  score: 0.9,
  version: 1,
}
let api: Api
let browserWindow: EventTarget

function session(accessToken = 'login-token'): Session {
  return { accessToken, user: { ...userInput, id: 'u1', createdAt: '2026-01-01T00:00:00Z' } }
}
function envelope<T>(data: T) {
  return { status: 200, data: { data } }
}
function axiosError(status?: number, message?: string) {
  return {
    isAxiosError: true,
    response:
      status === undefined ? undefined : { status, data: message ? { error: { message } } : {} },
  }
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function sse(event: string, data: unknown, eventId?: string) {
  return `${
    eventId === undefined
      ? ''
      : `id: ${eventId}
`
  }event: ${event}
data: ${JSON.stringify(data)}

`
}
function sseResponse(text: string, singleByte = false) {
  const bytes = new TextEncoder().encode(text)
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (singleByte) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        else controller.enqueue(bytes)
        controller.close()
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } },
  )
}
function openStream(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancelled = deferred<void>()
  const cancel = vi.fn(() => {
    cancelled.resolve()
  })
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel,
  })
  return {
    response: new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } }),
    send: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    cancel,
    cancelled: cancelled.promise,
  }
}
async function login() {
  const value = session()
  http.post.mockResolvedValueOnce(envelope(value))
  await api.login('reader', 'secret')
  http.post.mockClear()
  return value
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  http.post.mockReset().mockRejectedValue(new Error('意外的 POST 请求'))
  http.request.mockReset().mockResolvedValue(envelope([]))
  http.get.mockReset().mockRejectedValue(new Error('意外的 GET 请求'))
  fetchMock.mockReset().mockRejectedValue(new Error('意外的 fetch 请求'))
  browserWindow = Object.assign(new EventTarget(), { localStorage: storage })
  vi.stubGlobal('window', browserWindow)
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('VITE_API_BASE_URL', '/api/v1/')
  api = (await import('./rest')).restApi
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('REST 初始化、会话和响应', () => {
  it('创建携带 Cookie 的 axios 实例，去除基础路径尾部斜线', () => {
    expect(create).toHaveBeenCalledExactlyOnceWith({
      baseURL: '/api/v1',
      timeout: 30000,
      withCredentials: true,
    })
  })

  it.each(['https://example.invalid/api', '//example.invalid/api'])(
    '拒绝跨源基础路径 %s',
    async (baseURL) => {
      vi.resetModules()
      vi.stubEnv('VITE_API_BASE_URL', baseURL)
      await expect(import('./rest')).rejects.toThrow('API 地址必须为同源路径。')
      expect(create).toHaveBeenCalledTimes(1)
    },
  )

  it('登录解析 envelope，令牌只进入后续请求头，不读取或写入 localStorage', async () => {
    const value = session()
    await api.models()
    expect(http.request).toHaveBeenLastCalledWith({ url: '/models', headers: {} })
    http.post.mockResolvedValueOnce(envelope(value))
    await expect(api.login('reader', 'secret')).resolves.toEqual(value)
    expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/login', {
      username: 'reader',
      password: 'secret',
    })
    await api.users()
    expect(http.request).toHaveBeenLastCalledWith({
      url: '/users',
      headers: { Authorization: 'Bearer login-token' },
    })
    for (const method of [
      storage.getItem,
      storage.setItem,
      storage.removeItem,
      storage.clear,
      storage.key,
    ])
      expect(method).not.toHaveBeenCalled()
  })

  it('登录未返回令牌时拒绝，并清除旧令牌', async () => {
    await login()
    http.post.mockResolvedValueOnce(envelope({ user: session().user }))
    await expect(api.login('reader', 'wrong')).rejects.toThrow('后端未返回访问令牌。')
    await api.models()
    expect(http.request).toHaveBeenLastCalledWith({ url: '/models', headers: {} })
  })

  it('REST 解包 data，204 不访问响应体', async () => {
    const models = [{ ...modelInput, id: 'm1', hasApiKey: true, createdAt: 'now' }]
    http.request.mockResolvedValueOnce(envelope(models))
    await expect(api.models()).resolves.toEqual(models)
    http.request.mockResolvedValueOnce({
      status: 204,
      get data() {
        throw new Error('204 不应读取响应体')
      },
    })
    await expect(api.deleteModel('m1')).resolves.toBeUndefined()
  })

  it.each([
    ['业务错误', axiosError(422, '字段不合法'), '字段不合法'],
    ['HTTP 错误', axiosError(503), '请求失败（HTTP 503），请重试或联系管理员。'],
    ['网络错误', axiosError(), '无法连接业务后端，请检查服务地址或网络。'],
    ['原生错误', new Error('客户端错误'), '客户端错误'],
    ['未知错误', 'unknown', '请求失败。'],
  ])('%s 转换为可读错误且不刷新', async (_label, error, message) => {
    http.request.mockRejectedValueOnce(error)
    await expect(api.models()).rejects.toThrow(message)
    expect(http.post).not.toHaveBeenCalled()
    expect(isAxiosError).toHaveBeenCalledWith(error)
  })

  it('restore 恢复内存令牌并发送 session-refreshed', async () => {
    const refreshed = vi.fn()
    browserWindow.addEventListener('session-refreshed', refreshed)
    http.post.mockResolvedValueOnce(envelope(session('restored-token')))
    await expect(api.restore()).resolves.toEqual(session('restored-token'))
    expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/refresh')
    expect(refreshed).toHaveBeenCalledOnce()
    expect((refreshed.mock.calls[0][0] as CustomEvent).detail).toEqual(session().user)
    await api.models()
    expect(http.request.mock.calls[0][0].headers).toEqual({
      Authorization: 'Bearer restored-token',
    })
  })

  it('logout 失败也清除令牌并发送 session-expired，不执行刷新', async () => {
    await login()
    const expired = vi.fn()
    browserWindow.addEventListener('session-expired', expired)
    http.request.mockRejectedValueOnce(axiosError(503))
    await expect(api.logout()).rejects.toThrow('HTTP 503')
    expect(expired).toHaveBeenCalledOnce()
    expect(http.post).not.toHaveBeenCalled()
    await api.models()
    expect(http.request).toHaveBeenLastCalledWith({ url: '/models', headers: {} })
  })
})

describe('URI 编码和上传校验', () => {
  const routes: [string, (value: Api) => Promise<unknown>, string, string?][] = [
    ['修改模型', (value) => value.saveModel(modelInput, id), `/models/${encodedId}`, 'PATCH'],
    ['删除模型', (value) => value.deleteModel(id), `/models/${encodedId}`, 'DELETE'],
    ['测试模型', (value) => value.testModel(id), `/models/${encodedId}/test-connection`, 'POST'],
    ['修改用户', (value) => value.saveUser(userInput, id), `/users/${encodedId}`, 'PATCH'],
    ['删除用户', (value) => value.deleteUser(id), `/users/${encodedId}`, 'DELETE'],
    [
      '修改知识库',
      (value) => value.saveKnowledge(knowledgeInput, id),
      `/knowledge-bases/${encodedId}`,
      'PATCH',
    ],
    ['删除知识库', (value) => value.deleteKnowledge(id), `/knowledge-bases/${encodedId}`, 'DELETE'],
    ['文档列表', (value) => value.documents(id), `/knowledge-bases/${encodedId}/documents`],
    ['读取文档', (value) => value.document(id), `/documents/${encodedId}`],
    ['删除文档', (value) => value.deleteDocument(id), `/documents/${encodedId}`, 'DELETE'],
    ['读取分块', (value) => value.chunks(id), `/documents/${encodedId}/chunks`],
    [
      '预览分块',
      (value) => value.preview(id, chunkConfig),
      `/documents/${encodedId}/chunk-preview`,
      'POST',
    ],
    [
      '处理文档',
      (value) => value.process(id, chunkConfig),
      `/documents/${encodedId}/process`,
      'POST',
    ],
    [
      '修改会话',
      (value) => value.saveConversation(conversationInput, id),
      `/conversations/${encodedId}`,
      'PATCH',
    ],
    ['删除会话', (value) => value.deleteConversation(id), `/conversations/${encodedId}`, 'DELETE'],
    ['读取消息', (value) => value.messages(id), `/conversations/${encodedId}/messages`],
    [
      '生成消息',
      (value) => value.generate(id, '问题', 'request-1'),
      `/conversations/${encodedId}/messages`,
      'POST',
    ],
    ['取消生成', (value) => value.cancel(id), `/generations/${encodedId}/cancel`, 'POST'],
    [
      '读取引用',
      (value) => value.citation(id, '引用/2?#%'),
      `/messages/${encodedId}/citations/%E5%BC%95%E7%94%A8%2F2%3F%23%25`,
    ],
  ]
  it.each(routes)('%s 对每个路径参数独立编码', async (_label, call, url, method) => {
    await call(api)
    expect(http.request).toHaveBeenCalledOnce()
    expect(http.request.mock.calls[0][0]).toMatchObject({
      url,
      ...(method ? { method } : {}),
      headers: {},
    })
  })

  it('创建接口使用 POST，生成消息保留幂等标识和正文', async () => {
    await api.saveModel(modelInput)
    await api.saveUser(userInput)
    await api.saveKnowledge(knowledgeInput)
    await api.saveConversation(conversationInput)
    await api.generate(id, '中文问题', 'client-request-1')
    expect(http.request.mock.calls.map(([config]) => config)).toEqual([
      { method: 'POST', url: '/models', data: modelInput, headers: {} },
      { method: 'POST', url: '/users', data: userInput, headers: {} },
      { method: 'POST', url: '/knowledge-bases', data: knowledgeInput, headers: {} },
      { method: 'POST', url: '/conversations', data: conversationInput, headers: {} },
      {
        method: 'POST',
        url: `/conversations/${encodedId}/messages`,
        data: { content: '中文问题', clientRequestId: 'client-request-1' },
        headers: {},
      },
    ])
  })

  it.each(['PDF', 'docx', 'md', 'txt'])(
    '上传 %s 使用真实 FormData，保留文件及进度，不手工设置 boundary',
    async (extension) => {
      await login()
      const file = new File(['中文文档'], `资料.${extension}`, { type: 'application/octet-stream' })
      const progress = vi.fn()
      const document = { id: 'doc1', name: file.name }
      http.request.mockResolvedValueOnce(envelope(document))
      await expect(api.upload(id, file, progress)).resolves.toEqual(document)
      const config = http.request.mock.calls[0][0] as AxiosRequestConfig
      expect(config).toMatchObject({
        method: 'POST',
        url: `/knowledge-bases/${encodedId}/documents`,
        timeout: 120000,
        headers: { Authorization: 'Bearer login-token' },
      })
      expect(config.data).toBeInstanceOf(FormData)
      const form = config.data as FormData
      expect([...form.keys()]).toEqual(['file'])
      const uploaded = form.get('file') as File
      expect(uploaded.name).toBe(file.name)
      expect(await uploaded.text()).toBe('中文文档')
      expect(config.headers).not.toHaveProperty('Content-Type')
      expect(config.onUploadProgress).toBeTypeOf('function')
      config.onUploadProgress!({ loaded: 1, total: 3, bytes: 1, lengthComputable: true })
      config.onUploadProgress!({ loaded: 3, total: 3, bytes: 2, lengthComputable: true })
      config.onUploadProgress!({ loaded: 3, bytes: 0, lengthComputable: false })
      config.onUploadProgress!({ loaded: 0, total: 0, bytes: 0, lengthComputable: true })
      expect(progress.mock.calls).toEqual([[33], [100]])
    },
  )

  it.each([
    ['不支持的扩展名', 'run.exe', 1, '仅支持'],
    ['空文件', 'empty.txt', 0, '空文件'],
    ['超大文件', 'big.pdf', 20 * 1024 * 1024 + 1, '20 MiB'],
  ])('%s 在发出请求之前被拒绝', (_label, name, size, message) => {
    const file = new File(['x'], name)
    Object.defineProperty(file, 'size', { value: size })
    const progress = vi.fn()
    expect(() => api.upload(id, file, progress)).toThrow(message)
    expect(http.request).not.toHaveBeenCalled()
    expect(progress).not.toHaveBeenCalled()
  })

  it.each([
    { chunkSize: 49, chunkOverlap: 0 },
    { chunkSize: 4001, chunkOverlap: 0 },
    { chunkSize: NaN, chunkOverlap: 0 },
    { chunkSize: 500.5, chunkOverlap: 0 },
    { chunkSize: 500, chunkOverlap: -1 },
    { chunkSize: 500, chunkOverlap: 500 },
    { chunkSize: 500, chunkOverlap: 1.5 },
  ])('非法切分配置 %j 不发出知识库、预览或处理请求', (config) => {
    expect(() => api.saveKnowledge({ ...knowledgeInput, ...config })).toThrow()
    expect(() => api.preview(id, config)).toThrow()
    expect(() => api.process(id, config)).toThrow()
    expect(http.request).not.toHaveBeenCalled()
  })

  it('下载使用编码 URI 和 Bearer 头，直接返回 Blob 而不解包', async () => {
    await login()
    const blob = new Blob(['文件正文'])
    http.get.mockResolvedValueOnce({ data: blob })
    await expect(api.download(id)).resolves.toBe(blob)
    expect(http.get).toHaveBeenCalledExactlyOnceWith(`/documents/${encodedId}/download`, {
      responseType: 'blob',
      headers: { Authorization: 'Bearer login-token' },
    })
  })
})

describe('401 刷新合并和单次重试', () => {
  it('并发 REST 401 共享一个未完成的 refresh，随后使用新令牌重试', async () => {
    await login()
    const refreshStarted = deferred<void>()
    const refreshing = deferred<ReturnType<typeof envelope<Session>>>()
    const refreshed = vi.fn()
    browserWindow.addEventListener('session-refreshed', refreshed)
    http.post.mockImplementationOnce(() => {
      refreshStarted.resolve()
      return refreshing.promise
    })
    http.request.mockImplementation(async (config: AxiosRequestConfig) => {
      if (config.headers?.Authorization === 'Bearer login-token') throw axiosError(401)
      return envelope([config.url])
    })
    const pending = Promise.all([api.models(), api.users(), api.knowledgeBases()])
    await refreshStarted.promise
    expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/refresh')
    expect(http.request).toHaveBeenCalledTimes(3)
    refreshing.resolve(envelope(session('refreshed-token')))
    await expect(pending).resolves.toEqual([['/models'], ['/users'], ['/knowledge-bases']])
    expect(http.post).toHaveBeenCalledOnce()
    expect(http.request).toHaveBeenCalledTimes(6)
    expect(http.request.mock.calls.slice(3).map(([config]) => config.headers)).toEqual(
      Array.from({ length: 3 }, () => ({ Authorization: 'Bearer refreshed-token' })),
    )
    expect(refreshed).toHaveBeenCalledOnce()
  })

  it('REST、下载和 SSE 的并发 401 也共享同一个 refresh', async () => {
    vi.useFakeTimers()
    await login()
    const refreshing = deferred<ReturnType<typeof envelope<Session>>>()
    const unauthorized = openStream(401)
    const blob = new Blob(['文件'])
    http.post.mockReturnValueOnce(refreshing.promise)
    http.request.mockRejectedValueOnce(axiosError(401)).mockResolvedValueOnce(envelope([]))
    http.get.mockRejectedValueOnce(axiosError(401)).mockResolvedValueOnce({ data: blob })
    fetchMock
      .mockResolvedValueOnce(unauthorized.response)
      .mockResolvedValueOnce(sseResponse(sse('done', {})))
    const pending = Promise.all([
      api.models(),
      api.download(id),
      api.stream(id, vi.fn(), new AbortController().signal),
    ])
    const assertion = expect(pending).resolves.toEqual([[], blob, undefined])
    await vi.advanceTimersByTimeAsync(0)
    expect(unauthorized.cancel).toHaveBeenCalledOnce()
    expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/refresh')
    refreshing.resolve(envelope(session('shared-token')))
    await assertion
    expect(http.post).toHaveBeenCalledOnce()
    expect(http.request).toHaveBeenCalledTimes(2)
    expect(http.get).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(http.request.mock.calls[1][0].headers).toEqual({ Authorization: 'Bearer shared-token' })
    expect(http.get.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer shared-token' })
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      Authorization: 'Bearer shared-token',
    })
  })

  it('REST 重试仍为 401 时终止，发送 session-expired 并清除令牌', async () => {
    await login()
    const expired = vi.fn()
    browserWindow.addEventListener('session-expired', expired)
    http.request
      .mockRejectedValueOnce(axiosError(401))
      .mockRejectedValueOnce(axiosError(401, '仍未认证'))
    http.post.mockResolvedValueOnce(envelope(session('refreshed-token')))
    await expect(api.models()).rejects.toThrow('仍未认证')
    expect(http.request).toHaveBeenCalledTimes(2)
    expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/refresh')
    expect(expired).toHaveBeenCalledOnce()
    await api.users()
    expect(http.request).toHaveBeenLastCalledWith({ url: '/users', headers: {} })
  })

  it.each([401, 403, 503, undefined])(
    'REST refresh 失败（%s）不重试并发送 session-expired',
    async (status) => {
      await login()
      const expired = vi.fn()
      browserWindow.addEventListener('session-expired', expired)
      http.request.mockRejectedValueOnce(axiosError(401, '访问已过期'))
      http.post.mockRejectedValueOnce(
        axiosError(status, status === undefined ? undefined : '刷新失败'),
      )
      await expect(api.models()).rejects.toThrow(
        status === 401 || status === 403
          ? '访问已过期'
          : status === undefined
            ? '无法连接业务后端'
            : '刷新失败',
      )
      expect(http.request).toHaveBeenCalledOnce()
      expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/refresh')
      expect(expired).toHaveBeenCalledOnce()
      await api.users()
      expect(http.request).toHaveBeenLastCalledWith({ url: '/users', headers: {} })
    },
  )

  it('刷新返回空令牌也发送 session-expired', async () => {
    await login()
    const expired = vi.fn()
    browserWindow.addEventListener('session-expired', expired)
    http.request.mockRejectedValueOnce(axiosError(401))
    http.post.mockResolvedValueOnce(envelope(session('')))
    await expect(api.models()).rejects.toThrow('后端未返回访问令牌。')
    expect(expired).toHaveBeenCalledOnce()
    expect(http.request).toHaveBeenCalledOnce()
  })

  it('失败后可以重新发起 refresh，不保留已拒绝的刷新 Promise', async () => {
    http.post
      .mockRejectedValueOnce(axiosError(401))
      .mockResolvedValueOnce(envelope(session('next-token')))
    await expect(api.restore()).resolves.toBeNull()
    await expect(api.restore()).resolves.toEqual(session('next-token'))
    expect(http.post).toHaveBeenCalledTimes(2)
  })

  it('下载的 401 只重试一次并使用新令牌', async () => {
    await login()
    const blob = new Blob(['下载内容'])
    http.get.mockRejectedValueOnce(axiosError(401)).mockResolvedValueOnce({ data: blob })
    http.post.mockResolvedValueOnce(envelope(session('download-token')))
    await expect(api.download(id)).resolves.toBe(blob)
    expect(http.get).toHaveBeenCalledTimes(2)
    expect(http.get.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer download-token' })
    expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/refresh')
  })

  it('下载重试仍为 401 时发送 session-expired，不再刷新', async () => {
    await login()
    const expired = vi.fn()
    browserWindow.addEventListener('session-expired', expired)
    http.get.mockRejectedValue(axiosError(401))
    http.post.mockResolvedValueOnce(envelope(session('download-token')))
    await expect(api.download(id)).rejects.toThrow('HTTP 401')
    expect(http.get).toHaveBeenCalledTimes(2)
    expect(http.post).toHaveBeenCalledOnce()
    expect(expired).toHaveBeenCalledOnce()
    await api.models()
    expect(http.request.mock.calls[0][0].headers).toEqual({})
  })

  it.each([401, 503])('下载刷新失败（%s）终止并发送 session-expired', async (status) => {
    const expired = vi.fn()
    browserWindow.addEventListener('session-expired', expired)
    http.get.mockRejectedValueOnce(axiosError(401))
    http.post.mockRejectedValueOnce(axiosError(status))
    await expect(api.download(id)).rejects.toThrow(`HTTP ${status}`)
    expect(http.get).toHaveBeenCalledOnce()
    expect(expired).toHaveBeenCalledOnce()
  })
})

describe('SSE 传输和事件', () => {
  it('编码 URI，携带登录令牌与凭据，逐字节 UTF-8 解码 delta/citations/done', async () => {
    await login()
    const controller = new AbortController()
    const onEvent = vi.fn()
    const text =
      ': heartbeat\r\n\r\nevent: meta\ndata: not-json\n\n' +
      'id: 1\r\nevent: delta\r\ndata: {"text":\r\ndata: "中文😀"}\r\n\r\n' +
      sse('citations', { citations: [citation] }, '2') +
      sse('done', {}, '3')
    fetchMock.mockResolvedValueOnce(sseResponse(text, true))
    await expect(api.stream(id, onEvent, controller.signal)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`/api/v1/generations/${encodedId}/events`, {
      headers: { Authorization: 'Bearer login-token', Accept: 'text/event-stream' },
      credentials: 'same-origin',
      signal: controller.signal,
    })
    expect(onEvent.mock.calls).toEqual([
      [{ type: 'delta', text: '中文😀' }],
      [{ type: 'citations', citations: [citation] }],
      [{ type: 'done' }],
    ])
  })

  it('按 event id 去重，无 id 的重复内容仍分发，去重状态不泄漏到下一次 stream', async () => {
    const text =
      sse('delta', { text: '一次' }, '0') +
      'id: 0\nevent: delta\ndata: invalid-json\n\n' +
      sse('citations', { citations: [citation] }, 'cite') +
      sse('citations', { citations: [] }, 'cite') +
      sse('delta', { text: '重复' }) +
      sse('delta', { text: '重复' }) +
      sse('done', {}, 'done')
    fetchMock.mockResolvedValueOnce(sseResponse(text)).mockResolvedValueOnce(sseResponse(text))
    for (let i = 0; i < 2; i++) {
      const onEvent = vi.fn()
      await api.stream('g1', onEvent, new AbortController().signal)
      expect(onEvent.mock.calls).toEqual([
        [{ type: 'delta', text: '一次' }],
        [{ type: 'citations', citations: [citation] }],
        [{ type: 'delta', text: '重复' }],
        [{ type: 'delta', text: '重复' }],
        [{ type: 'done' }],
      ])
    }
  })

  it('非法 JSON 拒绝且取消 reader、释放锁', async () => {
    const source = openStream()
    source.send('event: delta\ndata: {broken}\n\n')
    fetchMock.mockResolvedValueOnce(source.response)
    const onEvent = vi.fn()
    await expect(api.stream('g1', onEvent, new AbortController().signal)).rejects.toThrow(
      '服务端流式事件格式不正确。',
    )
    expect(onEvent).not.toHaveBeenCalled()
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.response.body!.locked).toBe(false)
  })

  it.each(['', sse('delta', { text: '部分内容' }), 'event: done\ndata: {}\n'])(
    '提前 EOF 不作为成功（%j）',
    async (text) => {
      fetchMock.mockResolvedValueOnce(sseResponse(text))
      const onEvent = vi.fn()
      await expect(api.stream('g1', onEvent, new AbortController().signal)).rejects.toThrow(
        '连接提前中断',
      )
      expect(onEvent.mock.calls.some(([event]) => event.type === 'done')).toBe(false)
    },
  )

  it.each(['application/json', 'text/plain', 'application/text/event-stream-invalid', ''])(
    '拒绝非 SSE Content-Type（%s）',
    async (contentType) => {
      fetchMock.mockResolvedValueOnce(
        new Response(sse('done', {}), {
          headers: contentType ? { 'Content-Type': contentType } : {},
        }),
      )
      const onEvent = vi.fn()
      await expect(api.stream('g1', onEvent, new AbortController().signal)).rejects.toThrow(
        '服务端没有返回 SSE 事件流。',
      )
      expect(onEvent).not.toHaveBeenCalled()
    },
  )

  it('SSE 媒体类型大小写不敏感，允许字符集参数', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(sse('done', {}), {
        headers: { 'Content-Type': 'TEXT/EVENT-STREAM; charset=UTF-8' },
      }),
    )
    await expect(api.stream('g1', vi.fn(), new AbortController().signal)).resolves.toBeUndefined()
  })

  it('拒绝 HTTP 错误和缺失响应体', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
    await expect(api.stream('g1', vi.fn(), new AbortController().signal)).rejects.toThrow(
      'HTTP 502',
    )
    fetchMock.mockResolvedValueOnce(
      new Response(null, { headers: { 'Content-Type': 'text/event-stream' } }),
    )
    await expect(api.stream('g1', vi.fn(), new AbortController().signal)).rejects.toThrow(
      '当前环境不支持流式响应。',
    )
  })

  it.each([{ message: '模型服务不可用' }, {}])(
    '服务端 error 事件抛出错误并取消保持打开的流：%j',
    async (data) => {
      const source = openStream()
      source.send(sse('delta', { text: '部分' }) + sse('error', data) + sse('done', {}))
      fetchMock.mockResolvedValueOnce(source.response)
      const onEvent = vi.fn()
      await expect(api.stream('g1', onEvent, new AbortController().signal)).rejects.toThrow(
        data.message || '模型生成失败。',
      )
      expect(onEvent.mock.calls).toEqual([[{ type: 'delta', text: '部分' }]])
      expect(source.cancel).toHaveBeenCalledOnce()
      expect(source.response.body!.locked).toBe(false)
    },
  )

  it.each([
    { abortInDone: false, oversizedTail: false },
    { abortInDone: true, oversizedTail: false },
    { abortInDone: false, oversizedTail: true },
    { abortInDone: true, oversizedTail: true },
  ])('连接保持 open，done 后主动终止且成功完成（%j）', async ({ abortInDone, oversizedTail }) => {
    vi.useFakeTimers()
    const source = openStream()
    const controller = new AbortController()
    const events: StreamEvent[] = []
    source.send(
      sse('delta', { text: '完整' }) +
        sse('done', {}) +
        sse('error', { message: '不应再处理' }) +
        (oversizedTail ? 'x'.repeat(2 * 1024 * 1024 + 1) : ''),
    )
    fetchMock.mockResolvedValueOnce(source.response)
    const pending = api.stream(
      'g1',
      (event) => {
        events.push(event)
        if (event.type === 'done' && abortInDone) controller.abort()
      },
      controller.signal,
    )
    const settled = pending.then(
      () => ({ state: 'resolved' }),
      (error) => ({ state: 'rejected', error }),
    )
    // 虚拟时钟只作为失败保护；后端从不 close，测试不依赖真实等待。
    let timer!: ReturnType<typeof setTimeout>
    const deadline = new Promise<{ state: string }>((resolve) => {
      timer = setTimeout(() => resolve({ state: '仍在等待后端 close' }), 1000)
    })
    try {
      const outcome = Promise.race([settled, deadline])
      await vi.advanceTimersByTimeAsync(1000)
      expect(await outcome).toEqual({ state: 'resolved' })
      expect(events).toEqual([{ type: 'delta', text: '完整' }, { type: 'done' }])
      expect(source.cancel).toHaveBeenCalledOnce()
      expect(source.response.body!.locked).toBe(false)
      expect(controller.signal.aborted).toBe(abortInDone)
    } finally {
      clearTimeout(timer)
      controller.abort()
      await settled
    }
  })

  it('后端已 close 时 done 回调 abort 同样成功', async () => {
    const controller = new AbortController()
    fetchMock.mockResolvedValueOnce(sseResponse(sse('done', {})))
    const onEvent = vi.fn(() => controller.abort())
    await expect(api.stream('g1', onEvent, controller.signal)).resolves.toBeUndefined()
    expect(onEvent).toHaveBeenCalledExactlyOnceWith({ type: 'done' })
  })

  it('done 回调自己抛出的异常不能被完成状态吞掉', async () => {
    fetchMock.mockResolvedValueOnce(sseResponse(sse('done', {})))
    const failure = new Error('消费者异常')
    await expect(
      api.stream(
        'g1',
        () => {
          throw failure
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(failure)
  })

  it('读取之前已经取消时保持 AbortError', async () => {
    const controller = new AbortController()
    controller.abort()
    const source = openStream()
    source.send(sse('done', {}))
    fetchMock.mockResolvedValueOnce(source.response)
    const onEvent = vi.fn()
    await expect(api.stream('g1', onEvent, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(onEvent).not.toHaveBeenCalled()
    expect(source.cancel).toHaveBeenCalledOnce()
  })

  it('done 前取消等待中的读取时拒绝 AbortError 并清理资源', async () => {
    const source = openStream()
    const controller = new AbortController()
    const received = deferred<void>()
    source.send(sse('delta', { text: '部分' }))
    fetchMock.mockResolvedValueOnce(source.response)
    const pending = api.stream('g1', () => received.resolve(), controller.signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await received.promise
    controller.abort()
    await assertion
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.response.body!.locked).toBe(false)
  })

  it('同一块中 delta 回调先取消，即使随后有 done 也必须 AbortError', async () => {
    const controller = new AbortController()
    const onEvent = vi.fn((event: StreamEvent) => {
      if (event.type === 'delta') controller.abort()
    })
    fetchMock.mockResolvedValueOnce(sseResponse(sse('delta', { text: '未完成' }) + sse('done', {})))
    await expect(api.stream('g1', onEvent, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(onEvent.mock.calls).toEqual([[{ type: 'delta', text: '未完成' }]])
  })
})

describe('SSE 401 刷新', () => {
  it('取消 401 响应体后刷新，用新令牌重新连接一次', async () => {
    await login()
    const unauthorized = openStream(401)
    fetchMock
      .mockResolvedValueOnce(unauthorized.response)
      .mockResolvedValueOnce(sseResponse(sse('done', {})))
    http.post.mockImplementationOnce(async () => {
      expect(unauthorized.cancel).toHaveBeenCalledOnce()
      return envelope(session('stream-token'))
    })
    const controller = new AbortController()
    await expect(api.stream(id, vi.fn(), controller.signal)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      headers: { Authorization: 'Bearer stream-token' },
      signal: controller.signal,
    })
    expect(http.post).toHaveBeenCalledExactlyOnceWith('/auth/refresh')
  })

  it.each([401, 403, 503])('刷新失败（%s）不重连并发送 session-expired', async (status) => {
    const expired = vi.fn()
    browserWindow.addEventListener('session-expired', expired)
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
    http.post.mockRejectedValueOnce(axiosError(status))
    await expect(api.stream('g1', vi.fn(), new AbortController().signal)).rejects.toThrow(
      status === 503 ? 'HTTP 503' : '登录已过期',
    )
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(http.post).toHaveBeenCalledOnce()
    expect(expired).toHaveBeenCalledOnce()
  })

  it('重新连接仍是 401 时发送 session-expired，不再刷新', async () => {
    await login()
    const expired = vi.fn()
    browserWindow.addEventListener('session-expired', expired)
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
    http.post.mockResolvedValueOnce(envelope(session('stream-token')))
    await expect(api.stream('g1', vi.fn(), new AbortController().signal)).rejects.toThrow(
      'HTTP 401',
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(http.post).toHaveBeenCalledOnce()
    expect(expired).toHaveBeenCalledOnce()
    await api.models()
    expect(http.request.mock.calls[0][0].headers).toEqual({})
  })
})
