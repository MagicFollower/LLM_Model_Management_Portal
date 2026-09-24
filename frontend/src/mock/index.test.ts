// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Api,
  ChunkConfig,
  ConversationInput,
  KnowledgeInput,
  ModelInput,
  StreamEvent,
  User,
  UserInput,
} from '@/types'
import {
  mockApi,
  resetMock,
  MAX_STORAGE_BYTES,
  SESSION_KEY,
  STORAGE_KEY,
  STORAGE_VERSION,
} from './index'

class MemoryStorage implements Storage {
  private values = new Map<string, string>()
  writeFailure: 'before' | 'after' | null = null
  removeFailure = false
  get length(): number {
    return this.values.size
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
  getItem(key: string): string | null {
    return this.values.get(String(key)) ?? null
  }
  setItem(key: string, value: string): void {
    if (this.writeFailure === 'before') throw new Error('模拟配额不足')
    this.values.set(String(key), String(value))
    if (this.writeFailure === 'after') {
      this.writeFailure = null
      throw new Error('模拟写入后失败')
    }
  }
  removeItem(key: string): void {
    if (this.removeFailure) {
      this.removeFailure = false
      throw new Error('模拟会话存储失败')
    }
    this.values.delete(String(key))
  }
  clear(): void {
    this.values.clear()
  }
}
let local: MemoryStorage
let session: MemoryStorage
const adminLogin = () => mockApi.login('admin', 'admin123')
const memberLogin = () => mockApi.login('member', 'member123')
const modelInput = (overrides: Partial<ModelInput> = {}): ModelInput => ({
  name: '新增演示模型',
  type: 'chat',
  provider: 'Mock',
  baseUrl: 'https://example.invalid/v1',
  modelName: 'demo-chat',
  enabled: true,
  description: '非真实模型',
  ...overrides,
})
const userInput = (overrides: Partial<UserInput> = {}): UserInput => ({
  username: 'new-member',
  name: '新增演示成员',
  role: 'user',
  enabled: true,
  modelIds: ['model-qwen'],
  ...overrides,
})
const knowledgeInput = (overrides: Partial<KnowledgeInput> = {}): KnowledgeInput => ({
  name: '新增知识库',
  description: '测试示例',
  embeddingModelId: 'model-embedding',
  rerankModelId: 'model-rerank',
  chunkSize: 500,
  chunkOverlap: 50,
  ...overrides,
})
const chatInput = (overrides: Partial<ConversationInput> = {}): ConversationInput => ({
  title: '演示会话',
  modelId: 'model-qwen',
  knowledgeBaseIds: [],
  ...overrides,
})
const config: ChunkConfig = { chunkSize: 50, chunkOverlap: 10 }
const persisted = (): string => local.getItem(STORAGE_KEY) ?? ''
async function completeStream(generationId: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  const settled = mockApi
    .stream(generationId, (event) => events.push(event), new AbortController().signal)
    .then(
      () => null,
      (error) => error as Error,
    )
  await vi.runAllTimersAsync()
  expect(await settled).toBeNull()
  return events
}
async function seededUser(username: string): Promise<User> {
  const user = (await mockApi.users()).find((item) => item.username === username)
  if (!user) throw new Error('缺少测试种子用户')
  return user
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-24T08:00:00Z'))
  local = new MemoryStorage()
  session = new MemoryStorage()
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('sessionStorage', session)
  resetMock()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('认证、种子与持久化', () => {
  it('全部业务方法在查询资源前检查登录', async () => {
    const calls: Record<
      Exclude<keyof Api, 'login' | 'restore' | 'logout'>,
      () => Promise<unknown>
    > = {
      models: () => mockApi.models(),
      saveModel: () => mockApi.saveModel(modelInput()),
      deleteModel: () => mockApi.deleteModel('x'),
      testModel: () => mockApi.testModel('x'),
      users: () => mockApi.users(),
      saveUser: () => mockApi.saveUser(userInput()),
      deleteUser: () => mockApi.deleteUser('x'),
      knowledgeBases: () => mockApi.knowledgeBases(),
      saveKnowledge: () => mockApi.saveKnowledge(knowledgeInput()),
      deleteKnowledge: () => mockApi.deleteKnowledge('x'),
      documents: () => mockApi.documents('x'),
      document: () => mockApi.document('x'),
      upload: () => mockApi.upload('x', new File(['text'], 'test.txt'), vi.fn()),
      deleteDocument: () => mockApi.deleteDocument('x'),
      chunks: () => mockApi.chunks('x'),
      preview: () => mockApi.preview('x', config),
      process: () => mockApi.process('x', config),
      download: () => mockApi.download('x'),
      conversations: () => mockApi.conversations(),
      saveConversation: () => mockApi.saveConversation(chatInput()),
      deleteConversation: () => mockApi.deleteConversation('x'),
      messages: () => mockApi.messages('x'),
      generate: () => mockApi.generate('x', '问题', 'req'),
      stream: () => mockApi.stream('x', vi.fn(), new AbortController().signal),
      cancel: () => mockApi.cancel('x'),
      citation: () => mockApi.citation('x', 'y'),
    }
    for (const call of Object.values(calls))
      await expect(call()).rejects.toMatchObject({ status: 401 })
    await expect(mockApi.restore()).resolves.toBeNull()
  })
  it('演示账号、四种模型和双方知识库文档均存在，只有用户 ID 进入会话存储', async () => {
    await expect(mockApi.login('admin', 'wrong')).rejects.toMatchObject({ status: 401 })
    const auth = await adminLogin()
    expect(session.getItem(SESSION_KEY)).toBe(auth.user.id)
    expect(session.length).toBe(1)
    expect((await mockApi.models()).map((model) => model.name)).toEqual([
      'Qwen2.5-7B',
      'DeepSeek-R1',
      'bge-small-zh',
      'bge-reranker',
    ])
    const knowledge = await mockApi.knowledgeBases()
    expect(knowledge).toHaveLength(2)
    for (const kb of knowledge) {
      const documents = await mockApi.documents(kb.id)
      expect(documents[0]).toMatchObject({ status: 'ready', simulated: true })
      expect((await mockApi.chunks(documents[0]!.id)).length).toBeGreaterThan(0)
    }
    expect(JSON.parse(persisted()).version).toBe(STORAGE_VERSION)
    expect(persisted()).not.toContain('admin123')
    expect(persisted()).not.toContain('member123')
    await memberLogin()
    expect(await mockApi.knowledgeBases()).toHaveLength(1)
    expect(await mockApi.models()).toHaveLength(3)
    await mockApi.logout()
    expect(session.getItem(SESSION_KEY)).toBeNull()
    await expect(mockApi.restore()).resolves.toBeNull()
  })
  it('每次查询读取最新授权与账号启用状态，不依赖登录快照', async () => {
    await adminLogin()
    const member = await seededUser('member')
    const oldSession = await memberLogin()
    await adminLogin()
    await mockApi.saveUser({ ...member, modelIds: [] }, member.id)
    session.setItem(SESSION_KEY, member.id)
    expect(oldSession.user.modelIds.length).toBeGreaterThan(0)
    expect(await mockApi.models()).toEqual([])
    expect((await mockApi.restore())?.user.modelIds).toEqual([])
    await expect(mockApi.testModel('model-qwen')).rejects.toMatchObject({ status: 403 })
    await adminLogin()
    await mockApi.saveUser({ ...member, enabled: false }, member.id)
    session.setItem(SESSION_KEY, member.id)
    await expect(mockApi.knowledgeBases()).rejects.toMatchObject({ status: 401 })
    await expect(mockApi.restore()).resolves.toBeNull()
    await expect(memberLogin()).rejects.toMatchObject({ status: 403 })
  })
  it('新增及重置密码不落库，新增用户只接受通用非生产密码', async () => {
    await adminLogin()
    const value = await mockApi.saveUser(userInput({ password: 'do-not-store-this-password' }))
    await mockApi.saveUser({ ...value, password: 'another-secret-password' }, value.id)
    expect(persisted()).not.toContain('do-not-store-this-password')
    expect(persisted()).not.toContain('another-secret-password')
    expect(persisted()).not.toContain('"password"')
    await expect(mockApi.login(value.username, 'another-secret-password')).rejects.toMatchObject({
      status: 401,
    })
    expect((await mockApi.login(value.username, 'demo123')).user.id).toBe(value.id)
  })
  it('所有返回的嵌套数组和对象与持久化数据隔离', async () => {
    const auth = await adminLogin()
    auth.user.role = 'user'
    auth.user.modelIds.length = 0
    const models = await mockApi.models()
    models[0]!.name = '篡改'
    const users = await mockApi.users()
    users[0]!.modelIds.length = 0
    const knowledge = await mockApi.knowledgeBases()
    knowledge[0]!.name = '篡改'
    const documents = await mockApi.documents('kb-admin')
    documents[0]!.status = 'failed'
    const chunks = await mockApi.chunks('doc-kb-admin')
    chunks[0]!.content = '篡改'
    expect((await mockApi.restore())?.user.role).toBe('admin')
    expect((await mockApi.users())[0]!.modelIds.length).toBe(4)
    expect((await mockApi.models())[0]!.name).not.toBe('篡改')
    expect((await mockApi.knowledgeBases())[0]!.name).not.toBe('篡改')
    expect((await mockApi.document('doc-kb-admin')).status).toBe('ready')
    expect((await mockApi.chunks('doc-kb-admin'))[0]!.content).not.toBe('篡改')
  })
  it.each(['before', 'after'] as const)(
    '持久化 %s 失败不泄漏未提交的 CRUD 修改',
    async (failure) => {
      await adminLogin()
      const before = persisted()
      local.writeFailure = failure
      await expect(mockApi.saveModel(modelInput())).rejects.toMatchObject({ status: 507 })
      local.writeFailure = null
      expect(persisted()).toBe(before)
      expect(await mockApi.models()).toHaveLength(4)
    },
  )
  it('重置清理登录和业务数据，若会话存储失败则回滚数据库', async () => {
    await adminLogin()
    await mockApi.saveModel(modelInput())
    const before = persisted()
    session.removeFailure = true
    expect(() => resetMock()).toThrow()
    expect(persisted()).toBe(before)
    expect(session.getItem(SESSION_KEY)).toBe('user-admin')
    resetMock()
    expect(session.getItem(SESSION_KEY)).toBeNull()
    await adminLogin()
    expect(await mockApi.models()).toHaveLength(4)
  })
  it('刷新恢复持久数据；版本不兼容时重置，损坏数据不被静默覆盖', async () => {
    await adminLogin()
    const model = await mockApi.saveModel(modelInput())
    vi.resetModules()
    const fresh = await import('./index')
    expect((await fresh.mockApi.restore())?.user.username).toBe('admin')
    expect((await fresh.mockApi.models()).some((item) => item.id === model.id)).toBe(true)
    local.setItem(STORAGE_KEY, JSON.stringify({ version: -1 }))
    await expect(fresh.mockApi.restore()).resolves.toBeNull()
    expect(JSON.parse(persisted()).version).toBe(STORAGE_VERSION)
    local.setItem(STORAGE_KEY, '{损坏数据')
    await expect(fresh.mockApi.restore()).rejects.toMatchObject({ status: 500 })
    expect(persisted()).toBe('{损坏数据')
  })
})

describe('权限隔离和 CRUD 冲突', () => {
  it('普通用户不能管理模型或用户，也不能读写他人的知识库和文档', async () => {
    await memberLogin()
    const forbidden = [
      () => mockApi.users(),
      () => mockApi.saveUser(userInput()),
      () => mockApi.deleteUser('user-admin'),
      () => mockApi.saveModel(modelInput()),
      () => mockApi.deleteModel('model-deepseek'),
      () => mockApi.saveKnowledge(knowledgeInput(), 'kb-admin'),
      () => mockApi.deleteKnowledge('kb-admin'),
      () => mockApi.documents('kb-admin'),
      () => mockApi.document('doc-kb-admin'),
      () => mockApi.chunks('doc-kb-admin'),
      () => mockApi.preview('doc-kb-admin', config),
      () => mockApi.process('doc-kb-admin', config),
      () => mockApi.download('doc-kb-admin'),
      () => mockApi.deleteDocument('doc-kb-admin'),
      () => mockApi.upload('kb-admin', new File(['内容'], 'text.txt'), vi.fn()),
    ]
    for (const action of forbidden) await expect(action()).rejects.toMatchObject({ status: 403 })
  })
  it('管理员可治理成员知识库，但不能访问成员会话、消息、任务或引用', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput())
    const task = await mockApi.generate(chat.id, '提问', 'member-request')
    await adminLogin()
    expect(await mockApi.conversations()).toEqual([])
    const forbidden = [
      () => mockApi.messages(chat.id),
      () => mockApi.saveConversation(chatInput(), chat.id),
      () => mockApi.deleteConversation(chat.id),
      () => mockApi.generate(chat.id, '提问', 'other'),
      () => mockApi.stream(task.generationId, vi.fn(), new AbortController().signal),
      () => mockApi.cancel(task.generationId),
      () => mockApi.citation(task.assistantMessageId, '不存在的引用也先返回归属错误'),
    ]
    for (const action of forbidden) await expect(action()).rejects.toMatchObject({ status: 403 })
    const saved = await mockApi.saveKnowledge(knowledgeInput({ name: '管理员治理' }), 'kb-member')
    expect(saved.ownerId).toBe('user-member')
    await mockApi.deleteDocument('doc-kb-member')
    await mockApi.deleteKnowledge('kb-member')
  })
  it('普通成员不能访问管理员会话', async () => {
    await adminLogin()
    const chat = await mockApi.saveConversation(chatInput())
    await memberLogin()
    await expect(mockApi.messages(chat.id)).rejects.toMatchObject({ status: 403 })
    await expect(mockApi.generate(chat.id, '越权', 'request')).rejects.toMatchObject({
      status: 403,
    })
  })
  it('模型 CRUD 保留密钥标记但不保存秘密，并检查引用、类型与维度冲突', async () => {
    await adminLogin()
    const created = await mockApi.saveModel(modelInput({ apiKey: 'never-persist-model-secret' }))
    expect(created.hasApiKey).toBe(true)
    expect(persisted()).not.toContain('never-persist-model-secret')
    expect(persisted()).not.toContain('"apiKey"')
    const updated = await mockApi.saveModel(modelInput({ name: '改名' }), created.id)
    expect(updated.hasApiKey).toBe(true)
    expect((await mockApi.saveModel(modelInput({ clearApiKey: true }), created.id)).hasApiKey).toBe(
      false,
    )
    expect((await mockApi.testModel(created.id)).message).toContain('模拟')
    await expect(mockApi.deleteModel('model-embedding')).rejects.toMatchObject({ status: 409 })
    await expect(
      mockApi.saveModel(modelInput({ type: 'chat' }), 'model-embedding'),
    ).rejects.toMatchObject({ status: 409 })
    const chat = await mockApi.saveConversation(chatInput({ modelId: created.id }))
    await expect(mockApi.deleteModel(created.id)).rejects.toMatchObject({ status: 409 })
    await mockApi.deleteConversation(chat.id)
    await mockApi.deleteModel(created.id)
    expect((await mockApi.models()).some((model) => model.id === created.id)).toBe(false)
  })
  it('禁止最后一个启用管理员被停用或降级，禁止自删及重复用户名', async () => {
    await adminLogin()
    const user = await seededUser('admin')
    await expect(mockApi.saveUser({ ...user, enabled: false }, user.id)).rejects.toMatchObject({
      status: 409,
    })
    await expect(mockApi.saveUser({ ...user, role: 'user' }, user.id)).rejects.toMatchObject({
      status: 409,
    })
    await expect(mockApi.deleteUser(user.id)).rejects.toMatchObject({ status: 409 })
    await expect(mockApi.saveUser(userInput({ username: 'ADMIN' }))).rejects.toMatchObject({
      status: 409,
    })
    await expect(mockApi.deleteUser('user-member')).rejects.toMatchObject({ status: 409 })
    const extra = await mockApi.saveUser(userInput({ role: 'admin' }))
    await mockApi.saveUser({ ...user, role: 'user' }, user.id)
    await expect(mockApi.users()).rejects.toMatchObject({ status: 403 })
    await mockApi.login(extra.username, 'demo123')
    await expect(mockApi.deleteUser(extra.id)).rejects.toMatchObject({ status: 409 })
  })
  it('用户 CRUD 与模型删除后的授权清理正常', async () => {
    await adminLogin()
    const model = await mockApi.saveModel(modelInput())
    const created = await mockApi.saveUser(userInput({ modelIds: [model.id, model.id] }))
    expect(created.modelIds).toEqual([model.id])
    const renamed = await mockApi.saveUser({ ...created, name: '修改姓名' }, created.id)
    expect(renamed.name).toBe('修改姓名')
    await mockApi.deleteModel(model.id)
    expect((await seededUser(created.username)).modelIds).toEqual([])
    await mockApi.deleteUser(created.id)
    expect((await mockApi.users()).some((user) => user.id === created.id)).toBe(false)
  })
  it('知识库 CRUD、非空换向量模型冲突及未授权、停用、错误类型校验', async () => {
    await adminLogin()
    const embedding = await mockApi.saveModel(
      modelInput({ name: '另一向量模型', type: 'embedding', dimension: 256 }),
    )
    await expect(
      mockApi.saveKnowledge(knowledgeInput({ embeddingModelId: embedding.id }), 'kb-admin'),
    ).rejects.toMatchObject({ status: 409 })
    const kb = await mockApi.saveKnowledge(knowledgeInput())
    expect(
      (await mockApi.saveKnowledge(knowledgeInput({ embeddingModelId: embedding.id }), kb.id))
        .embeddingModelId,
    ).toBe(embedding.id)
    await mockApi.deleteKnowledge(kb.id)
    await expect(mockApi.documents(kb.id)).rejects.toMatchObject({ status: 404 })
    await memberLogin()
    await expect(
      mockApi.saveKnowledge(knowledgeInput({ embeddingModelId: embedding.id })),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      mockApi.saveKnowledge(knowledgeInput({ embeddingModelId: 'model-qwen' })),
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      mockApi.saveKnowledge(knowledgeInput({ rerankModelId: 'model-qwen' })),
    ).rejects.toMatchObject({ status: 422 })
    await adminLogin()
    await mockApi.saveModel(
      modelInput({ name: '停用向量模型', type: 'embedding', dimension: 256, enabled: false }),
      embedding.id,
    )
    await expect(
      mockApi.saveKnowledge(knowledgeInput({ embeddingModelId: embedding.id })),
    ).rejects.toMatchObject({ status: 409 })
    await expect(mockApi.testModel(embedding.id)).rejects.toMatchObject({ status: 409 })
  })
  it('会话 CRUD，修改引用配置不改变所有者，删除时级联清理消息', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-member'] }))
    const renamed = await mockApi.saveConversation(chatInput({ title: '修改标题' }), chat.id)
    expect(renamed.ownerId).toBe('user-member')
    renamed.knowledgeBaseIds.push('kb-admin')
    expect((await mockApi.conversations())[0]!.knowledgeBaseIds).toEqual([])
    const task = await mockApi.generate(chat.id, '提问', 'req')
    await mockApi.deleteConversation(chat.id)
    expect(await mockApi.conversations()).toEqual([])
    await expect(mockApi.messages(chat.id)).rejects.toMatchObject({ status: 404 })
    await expect(mockApi.cancel(task.generationId)).rejects.toMatchObject({ status: 404 })
    expect(persisted()).not.toContain(task.assistantMessageId)
  })
})

describe('文档校验、时间戳流水线与原子版本', () => {
  it.each([
    { chunkSize: 49, chunkOverlap: 0 },
    { chunkSize: 4001, chunkOverlap: 0 },
    { chunkSize: 50.5, chunkOverlap: 0 },
    { chunkSize: 50, chunkOverlap: -1 },
    { chunkSize: 50, chunkOverlap: 50 },
    { chunkSize: 50, chunkOverlap: 0.5 },
    { chunkSize: Number.NaN, chunkOverlap: 0 },
  ])('所有切分参数入口拒绝非法配置 %j', async (invalid) => {
    await adminLogin()
    await expect(mockApi.saveKnowledge(knowledgeInput(invalid))).rejects.toMatchObject({
      status: 422,
    })
    await expect(mockApi.preview('doc-kb-admin', invalid)).rejects.toMatchObject({ status: 422 })
    await expect(mockApi.process('doc-kb-admin', invalid)).rejects.toMatchObject({ status: 422 })
  })
  it.each(['txt', 'md'])(
    '%s 读取真实文字，六秒分阶段推进，预览先于 ready 可用',
    async (extension) => {
      await memberLogin()
      const text = 'abcdefghijklmnopqrstuvwxyz'.repeat(8)
      const progress = vi.fn()
      const doc = await mockApi.upload('kb-member', new File([text], `test.${extension}`), progress)
      expect(progress.mock.calls.map((call) => call[0])).toEqual([0, 70, 100])
      expect(doc).toMatchObject({ status: 'parsing', progress: 0, version: 0 })
      await expect(mockApi.chunks(doc.id)).rejects.toMatchObject({ status: 409 })
      await expect(mockApi.preview(doc.id, config)).rejects.toMatchObject({ status: 409 })
      await vi.advanceTimersByTimeAsync(1500)
      expect((await mockApi.document(doc.id)).status).toBe('splitting')
      const preview = await mockApi.preview(doc.id, config)
      expect(preview[0]!.content).toBe(text.slice(0, 50))
      expect(preview[1]!.content).toBe(text.slice(40, 90))
      expect(preview.every((chunk) => chunk.page === null)).toBe(true)
      await vi.advanceTimersByTimeAsync(1500)
      expect((await mockApi.document(doc.id)).status).toBe('embedding')
      await vi.advanceTimersByTimeAsync(1500)
      expect((await mockApi.document(doc.id)).status).toBe('indexing')
      await vi.advanceTimersByTimeAsync(1500)
      expect((await mockApi.document(doc.id)).status).toBe('ready')
      expect(await (await mockApi.download(doc.id)).text()).toBe(text)
      const oldChunks = await mockApi.chunks(doc.id)
      expect(oldChunks[0]!.version).toBe(1)
      await mockApi.process(doc.id, config)
      await expect(mockApi.process(doc.id, config)).rejects.toMatchObject({ status: 409 })
      expect((await mockApi.document(doc.id)).version).toBe(1)
      await expect(mockApi.chunks(doc.id)).rejects.toMatchObject({ status: 409 })
      await vi.advanceTimersByTimeAsync(6000)
      const ready = await mockApi.document(doc.id)
      expect(ready).toMatchObject({ status: 'ready', version: 2, ...config })
      expect((await mockApi.chunks(doc.id)).map((chunk) => chunk.content)).toEqual(
        preview.map((chunk) => chunk.content),
      )
      expect((await mockApi.chunks(doc.id)).every((chunk) => chunk.version === 2)).toBe(true)
      await mockApi.deleteDocument(doc.id)
      await expect(mockApi.download(doc.id)).rejects.toMatchObject({ status: 404 })
    },
  )
  it('刷新后无需旧定时器，仍按原时间戳完成处理', async () => {
    await adminLogin()
    const doc = await mockApi.upload('kb-admin', new File(['文档内容'], 'test.txt'), vi.fn())
    await vi.advanceTimersByTimeAsync(2000)
    vi.resetModules()
    const fresh = await import('./index')
    await fresh.mockApi.restore()
    expect((await fresh.mockApi.document(doc.id)).status).toBe('splitting')
    await vi.advanceTimersByTimeAsync(4000)
    expect((await fresh.mockApi.document(doc.id)).status).toBe('ready')
  })
  it.each(['', '   \n\t'])('空白文档进入 failed，可提交重试但不伪造成功', async (text) => {
    await adminLogin()
    const doc = await mockApi.upload('kb-admin', new File([text], 'empty.txt'), vi.fn())
    await vi.advanceTimersByTimeAsync(6000)
    expect(await mockApi.document(doc.id)).toMatchObject({ status: 'failed', version: 0 })
    await expect(mockApi.chunks(doc.id)).rejects.toMatchObject({ status: 409 })
    expect((await mockApi.process(doc.id, config)).status).toBe('parsing')
    await vi.advanceTimersByTimeAsync(6000)
    expect((await mockApi.document(doc.id)).status).toBe('failed')
  })
  it.each(['pdf', 'docx'])('%s 不执行真实解析，下载仅返回说明文本 Blob', async (extension) => {
    await adminLogin()
    const file = new File(['binary-data-not-real-document'], `test.${extension}`)
    const read = vi.spyOn(file, 'text')
    const doc = await mockApi.upload('kb-admin', file, vi.fn())
    await vi.advanceTimersByTimeAsync(6000)
    expect((await mockApi.chunks(doc.id))[0]!.content).toContain('不是 PDF / DOCX 原文')
    expect(read).not.toHaveBeenCalled()
    const blob = await mockApi.download(doc.id)
    expect(blob.type).toContain('text/plain')
    expect(await blob.text()).toContain('此 TXT 仅为说明')
    expect(persisted()).not.toContain('binary-data-not-real-document')
  })
  it('拒绝不支持的文件、超大文件、总体积及高重叠膨胀，失败不留下文档', async () => {
    await adminLogin()
    await expect(
      mockApi.upload('kb-admin', new File(['x'], 'test.exe'), vi.fn()),
    ).rejects.toMatchObject({ status: 415 })
    const oversized = new File(['x'], 'test.pdf')
    Object.defineProperty(oversized, 'size', { value: 20 * 1024 * 1024 + 1 })
    await expect(mockApi.upload('kb-admin', oversized, vi.fn())).rejects.toMatchObject({
      status: 413,
    })
    const before = persisted()
    await expect(
      mockApi.upload(
        'kb-admin',
        new File(['字'.repeat(MAX_STORAGE_BYTES / 2)], 'large.txt'),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ status: 413 })
    expect(persisted()).toBe(before)
    const doc = await mockApi.upload(
      'kb-admin',
      new File(['x'.repeat(10000)], 'overlap.txt'),
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(6000)
    await mockApi.document(doc.id)
    await expect(
      mockApi.preview(doc.id, { chunkSize: 4000, chunkOverlap: 3999 }),
    ).rejects.toMatchObject({ status: 413 })
    await mockApi.process(doc.id, { chunkSize: 4000, chunkOverlap: 3999 })
    await vi.advanceTimersByTimeAsync(6000)
    expect(await mockApi.document(doc.id)).toMatchObject({
      status: 'failed',
      version: 1,
      chunkSize: 500,
    })
  })
  it('原文可保存但切片总量超限时转 failed，不留下半个新版本', async () => {
    await adminLogin()
    const doc = await mockApi.upload(
      'kb-admin',
      new File(['x'.repeat(600000)], 'quota.txt'),
      vi.fn(),
    )
    await vi.advanceTimersByTimeAsync(6000)
    const result = await mockApi.document(doc.id)
    expect(result).toMatchObject({ status: 'failed', version: 0, chunkCount: 0 })
    expect(result.error).toContain('2 MiB')
    expect(persisted().length * 2).toBeLessThanOrEqual(MAX_STORAGE_BYTES)
    expect(
      (await mockApi.preview(doc.id, { chunkSize: 4000, chunkOverlap: 0 })).length,
    ).toBeGreaterThan(0)
    await expect(mockApi.chunks(doc.id)).rejects.toMatchObject({ status: 409 })
    expect((await mockApi.process(doc.id, config)).status).toBe('parsing')
  })
  it('读取文件期间身份变化阻止提交，任务期间模型停用导致失败', async () => {
    await memberLogin()
    const file = new File(['内容'], 'test.txt')
    vi.spyOn(file, 'text').mockImplementation(async () => {
      await adminLogin()
      return '内容'
    })
    await expect(mockApi.upload('kb-member', file, vi.fn())).rejects.toMatchObject({ status: 401 })
    expect(await mockApi.documents('kb-member')).toHaveLength(1)
    const doc = await mockApi.upload('kb-admin', new File(['内容'], 'test.txt'), vi.fn())
    const embedding = (await mockApi.models()).find((model) => model.id === 'model-embedding')!
    await mockApi.saveModel({ ...embedding, enabled: false }, embedding.id)
    await vi.advanceTimersByTimeAsync(6000)
    expect((await mockApi.document(doc.id)).status).toBe('failed')
  })
})

describe('流式生成、幂等与引用鉴权', () => {
  it('先保存两条消息，再逐段输出 delta/citations/done，响应及事件深拷贝', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-member'] }))
    const task = await mockApi.generate(chat.id, '请提供示例', 'request-1')
    const history = await mockApi.messages(chat.id)
    expect(history).toHaveLength(2)
    expect(history[1]).toMatchObject({
      id: task.assistantMessageId,
      content: '',
      status: 'streaming',
    })
    history[1]!.content = '不能穿透'
    const events: StreamEvent[] = []
    const controller = new AbortController()
    const work = mockApi.stream(
      task.generationId,
      (event) => {
        events.push(structuredClone(event))
        if (event.type === 'citations') {
          event.citations[0]!.content = '不能穿透'
          event.citations.length = 0
        }
        if (event.type === 'done') controller.abort()
      },
      controller.signal,
    )
    const settled = work.then(
      () => null,
      (error) => error as Error,
    )
    await vi.advanceTimersByTimeAsync(29)
    expect(events).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(events[0]!.type).toBe('delta')
    await vi.runAllTimersAsync()
    expect(await settled).toBeNull()
    expect(events.slice(-2).map((event) => event.type)).toEqual(['citations', 'done'])
    const assistant = (await mockApi.messages(chat.id))[1]!
    expect(assistant.status).toBe('complete')
    expect(assistant.content).toBe(
      events.flatMap((event) => (event.type === 'delta' ? [event.text] : [])).join(''),
    )
    expect(assistant.content).toContain('不是实际模型回答')
    expect(assistant.citations).toHaveLength(1)
    const citation = await mockApi.citation(assistant.id, assistant.citations[0]!.id)
    citation.content = '不能穿透'
    expect((await mockApi.citation(assistant.id, citation.id)).content).not.toBe('不能穿透')
  })
  it('无就绪文档不编造引用，尚在处理的文档不进入引用', async () => {
    await memberLogin()
    await mockApi.deleteDocument('doc-kb-member')
    await mockApi.upload('kb-member', new File(['内容'], 'pending.txt'), vi.fn())
    const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-member'] }))
    const task = await mockApi.generate(chat.id, '问题', 'request')
    await completeStream(task.generationId)
    const assistant = (await mockApi.messages(chat.id))[1]!
    expect(assistant.citations).toEqual([])
    expect(assistant.content).toContain('不提供来源或编造引用')
  })
  it('使用生成时的配置快照，改会话配置不会改动进行中任务的引用', async () => {
    await adminLogin()
    const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-admin'] }))
    const task = await mockApi.generate(chat.id, '问题', 'snapshot')
    await mockApi.saveConversation(
      chatInput({ modelId: 'model-deepseek', knowledgeBaseIds: [] }),
      chat.id,
    )
    await expect(mockApi.deleteModel('model-qwen')).rejects.toMatchObject({ status: 409 })
    await completeStream(task.generationId)
    expect((await mockApi.messages(chat.id))[1]!.citations[0]!.knowledgeBaseId).toBe('kb-admin')
    expect(await mockApi.generate(chat.id, '问题', 'snapshot')).toEqual(task)
    expect(await mockApi.messages(chat.id)).toHaveLength(2)
  })
  it('完成流可以重放终态，预先取消的任务不能启动，重置可中止活跃流', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput())
    const first = await mockApi.generate(chat.id, '第一问', 'one')
    await completeStream(first.generationId)
    const terminal = await completeStream(first.generationId)
    expect(terminal.map((event) => event.type)).toEqual(['citations', 'done'])
    const second = await mockApi.generate(chat.id, '第二问', 'two')
    await mockApi.cancel(second.generationId)
    await expect(
      mockApi.stream(second.generationId, vi.fn(), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    const third = await mockApi.generate(chat.id, '第三问', 'three')
    const outcome = mockApi
      .stream(third.generationId, vi.fn(), new AbortController().signal)
      .catch((error) => error as Error)
    await vi.advanceTimersByTimeAsync(30)
    resetMock()
    const resetData = persisted()
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(persisted()).toBe(resetData)
  })
  it('同一请求幂等，冲突内容和并发生成返回 409，刷新后仍不会重复消息', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput())
    const [one, two] = await Promise.all([
      mockApi.generate(chat.id, '问题', 'idempotent'),
      mockApi.generate(chat.id, '问题', 'idempotent'),
    ])
    expect(one).toEqual(two)
    expect(await mockApi.messages(chat.id)).toHaveLength(2)
    await expect(mockApi.generate(chat.id, '不同内容', 'idempotent')).rejects.toMatchObject({
      status: 409,
    })
    await expect(mockApi.generate(chat.id, '问题', 'another')).rejects.toMatchObject({
      status: 409,
    })
    vi.resetModules()
    const fresh = await import('./index')
    expect((await fresh.mockApi.messages(chat.id))[1]!.status).toBe('error')
    expect(await fresh.mockApi.generate(chat.id, '问题', 'idempotent')).toEqual(one)
    expect(await fresh.mockApi.messages(chat.id)).toHaveLength(2)
    await expect(
      fresh.mockApi.stream(one.generationId, vi.fn(), new AbortController().signal),
    ).rejects.toMatchObject({ status: 409 })
  })
  it.each(['before', 'during'] as const)(
    'signal 在 %s 中止抛 AbortError，并保留 cancelled 状态',
    async (when) => {
      await memberLogin()
      const chat = await mockApi.saveConversation(chatInput())
      const task = await mockApi.generate(chat.id, '问题', 'request')
      const controller = new AbortController()
      if (when === 'before') controller.abort()
      const outcome = mockApi
        .stream(task.generationId, vi.fn(), controller.signal)
        .catch((error) => error as Error)
      if (when === 'during') {
        await vi.advanceTimersByTimeAsync(30)
        controller.abort()
      }
      await vi.runAllTimersAsync()
      expect(await outcome).toMatchObject({ name: 'AbortError' })
      expect((await mockApi.messages(chat.id))[1]!.status).toBe('cancelled')
      await mockApi.cancel(task.generationId)
    },
  )
  it('cancel 中止已连接流，后续定时器不得追加内容或发送 done', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput())
    const task = await mockApi.generate(chat.id, '问题', 'request')
    const events: StreamEvent[] = []
    const outcome = mockApi
      .stream(task.generationId, (event) => events.push(event), new AbortController().signal)
      .catch((error) => error as Error)
    await vi.advanceTimersByTimeAsync(60)
    await mockApi.cancel(task.generationId)
    const stopped = (await mockApi.messages(chat.id))[1]!
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect((await mockApi.messages(chat.id))[1]).toEqual(stopped)
    expect(stopped.status).toBe('cancelled')
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })
  it('引用回调内取消也不能被完成事件覆写；重复订阅被拒绝', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-member'] }))
    const task = await mockApi.generate(chat.id, '问题', 'request')
    const events: StreamEvent[] = []
    let cancellation: Promise<void> | undefined
    const outcome = mockApi
      .stream(
        task.generationId,
        (event) => {
          events.push(event)
          if (event.type === 'citations') cancellation = mockApi.cancel(task.generationId)
        },
        new AbortController().signal,
      )
      .catch((error) => error as Error)
    await expect(
      mockApi.stream(task.generationId, vi.fn(), new AbortController().signal),
    ).rejects.toMatchObject({ status: 409 })
    await vi.runAllTimersAsync()
    await cancellation
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect((await mockApi.messages(chat.id))[1]!.status).toBe('cancelled')
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })
  it('创建/生成阻止错误类型、越权和停用模型，流中撤销授权立即终止', async () => {
    await memberLogin()
    await expect(
      mockApi.saveConversation(chatInput({ modelId: 'model-embedding' })),
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      mockApi.saveConversation(chatInput({ modelId: 'model-deepseek' })),
    ).rejects.toMatchObject({ status: 403 })
    await expect(
      mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-admin'] })),
    ).rejects.toMatchObject({ status: 403 })
    const chat = await mockApi.saveConversation(chatInput())
    const task = await mockApi.generate(chat.id, '问题', 'request')
    const outcome = mockApi
      .stream(task.generationId, vi.fn(), new AbortController().signal)
      .catch((error) => error as Error)
    await vi.advanceTimersByTimeAsync(30)
    await adminLogin()
    const member = await seededUser('member')
    await mockApi.saveUser({ ...member, modelIds: [] }, member.id)
    session.setItem(SESSION_KEY, member.id)
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ status: 403 })
    expect((await mockApi.messages(chat.id))[1]!.status).toBe('error')
    await expect(mockApi.generate(chat.id, '问题', 'next')).rejects.toMatchObject({ status: 403 })
    await adminLogin()
    await mockApi.saveUser(member, member.id)
    const model = (await mockApi.models()).find((item) => item.id === 'model-qwen')!
    await mockApi.saveModel({ ...model, enabled: false }, model.id)
    await memberLogin()
    await expect(mockApi.generate(chat.id, '问题', 'next')).rejects.toMatchObject({ status: 409 })
    await mockApi.cancel(task.generationId)
  })
  it('撤销知识库模型授权后阻止生成，切换登录身份后停止现有流', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-member'] }))
    await adminLogin()
    const member = await seededUser('member')
    await mockApi.saveUser({ ...member, modelIds: ['model-qwen'] }, member.id)
    session.setItem(SESSION_KEY, member.id)
    await expect(mockApi.generate(chat.id, '问题', 'denied')).rejects.toMatchObject({ status: 403 })
    await adminLogin()
    await mockApi.saveUser(member, member.id)
    await memberLogin()
    const task = await mockApi.generate(chat.id, '问题', 'allowed')
    const events: StreamEvent[] = []
    const outcome = mockApi
      .stream(task.generationId, (event) => events.push(event), new AbortController().signal)
      .catch((error) => error as Error)
    await vi.advanceTimersByTimeAsync(30)
    await adminLogin()
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ status: 403 })
    expect(events.some((event) => event.type === 'done')).toBe(false)
    await memberLogin()
    expect((await mockApi.messages(chat.id))[1]!.status).toBe('error')
  })
  it('生成保存失败不留半条消息；流式持久化失败不发虚假 delta 或 done', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput())
    local.writeFailure = 'before'
    await expect(mockApi.generate(chat.id, '问题', 'request')).rejects.toMatchObject({
      status: 507,
    })
    local.writeFailure = null
    expect(await mockApi.messages(chat.id)).toEqual([])
    const task = await mockApi.generate(chat.id, '问题', 'request')
    const events: StreamEvent[] = []
    const outcome = mockApi
      .stream(task.generationId, (event) => events.push(event), new AbortController().signal)
      .catch((error) => error as Error)
    local.writeFailure = 'after'
    await vi.runAllTimersAsync()
    expect(await outcome).toMatchObject({ status: 507 })
    expect(events.map((event) => event.type)).toEqual(['error'])
    expect((await mockApi.messages(chat.id))[1]).toMatchObject({ content: '', status: 'error' })
  })
  it.each(['document', 'knowledge'] as const)(
    '引用先验证消息本人，再验证当前 %s 来源存在',
    async (resource) => {
      await memberLogin()
      const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-member'] }))
      const task = await mockApi.generate(chat.id, '问题', 'request')
      await completeStream(task.generationId)
      const citation = (await mockApi.messages(chat.id))[1]!.citations[0]!
      await adminLogin()
      await expect(mockApi.citation(task.assistantMessageId, citation.id)).rejects.toMatchObject({
        status: 403,
      })
      if (resource === 'document') await mockApi.deleteDocument(citation.documentId)
      else await mockApi.deleteKnowledge(citation.knowledgeBaseId)
      await memberLogin()
      await expect(mockApi.citation(task.assistantMessageId, citation.id)).rejects.toMatchObject({
        status: 404,
      })
    },
  )
  it('引用获取时重新验证最新模型授权', async () => {
    await memberLogin()
    const chat = await mockApi.saveConversation(chatInput({ knowledgeBaseIds: ['kb-member'] }))
    const task = await mockApi.generate(chat.id, '问题', 'request')
    await completeStream(task.generationId)
    const citation = (await mockApi.messages(chat.id))[1]!.citations[0]!
    await adminLogin()
    const member = await seededUser('member')
    await mockApi.saveUser({ ...member, modelIds: ['model-qwen'] }, member.id)
    session.setItem(SESSION_KEY, member.id)
    await expect(mockApi.citation(task.assistantMessageId, citation.id)).rejects.toMatchObject({
      status: 403,
    })
  })
})
