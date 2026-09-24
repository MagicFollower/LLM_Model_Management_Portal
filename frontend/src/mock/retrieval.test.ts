// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Chunk, Conversation, KnowledgeBase, Message, Model, StreamEvent, User } from '@/types'
import type { SearchRequest } from '@/types/retrieval'
import { RETRIEVAL_MODEL_ID } from '@/api/retrieval'
import type { RetrievalDocument } from './retrieval'
import { mockApi, resetMock, searchKnowledgeBases, SESSION_KEY, STORAGE_KEY, STORAGE_VERSION } from './index'

class MemoryStorage implements Storage {
  private data = new Map<string, string>()
  get length() { return this.data.size }
  key(index: number) { return [...this.data.keys()][index] ?? null }
  getItem(key: string) { return this.data.get(key) ?? null }
  setItem(key: string, value: string) { this.data.set(key, String(value)) }
  removeItem(key: string) { this.data.delete(key) }
  clear() { this.data.clear() }
}
interface TestDatabase {
  version: number
  documents: RetrievalDocument[]
  users: User[]
  models: Model[]
  knowledgeBases: KnowledgeBase[]
  conversations: Conversation[]
  messages: Message[]
}
const options = { topK: 5, minScore: 0.3 }
const topics = ['会议室需要提前预约。', '差旅报销需提交行程、发票及审批记录。', '数据库每天备份并定期验证恢复。']
let local: MemoryStorage
let session: MemoryStorage
let fetchSpy: MockInstance<typeof fetch>
const raw = () => local.getItem(STORAGE_KEY)!
const database = (): TestDatabase => JSON.parse(raw()) as TestDatabase
function mutate(change: (db: TestDatabase) => void) {
  const db = database()
  change(db)
  local.setItem(STORAGE_KEY, JSON.stringify(db))
}
function installTopics(): Chunk[] {
  mutate((db) => {
    const doc = db.documents.find((item) => item.record.id === 'doc-kb-member')!
    doc.text = topics.join('\n\n')
    doc.chunks = topics.map((content, index) => ({
      id: `${doc.record.id}-v1-${index + 1}`, documentId: doc.record.id,
      content, index: index + 1, page: null, section: `章节 ${index + 1}`, version: 1,
    }))
    doc.record.chunkCount = doc.chunks.length
  })
  return database().documents.find((item) => item.record.id === 'doc-kb-member')!.chunks
}
function response(input: SearchRequest, hits = input.chunks.slice(0, 1).map(({ id }) => ({ id, score: 0.7312 }))) {
  return new Response(JSON.stringify({ data: {
    hits, modelId: RETRIEVAL_MODEL_ID, dimension: 512, elapsedMs: 4.5, totalChunks: input.chunks.length,
  } }))
}
function successful() {
  fetchSpy.mockImplementation(async (_, init) => response(JSON.parse(init!.body as string) as SearchRequest))
}
function deferred() {
  let resolve!: (value: Response) => void
  let input!: SearchRequest
  let signal!: AbortSignal
  fetchSpy.mockImplementationOnce((_, init) => {
    input = JSON.parse(init!.body as string) as SearchRequest
    signal = init!.signal!
    return new Promise<Response>((done) => { resolve = done })
  })
  return {
    get input() { return input },
    get signal() { return signal },
    finish(hits?: { id: string; score: number }[]) { resolve(response(input, hits)) },
  }
}
async function chat(knowledgeBaseIds = ['kb-member']) {
  return mockApi.saveConversation({ title: '检索对话', modelId: 'model-qwen', knowledgeBaseIds })
}
function stream(generationId: string, callback?: (event: StreamEvent) => void, signal = new AbortController().signal) {
  const events: StreamEvent[] = []
  const outcome = mockApi.stream(generationId, (event) => {
    events.push(structuredClone(event))
    callback?.(event)
  }, signal).then(() => undefined, (error: unknown) => error)
  return { events, outcome }
}
beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-24T08:00:00Z'))
  vi.stubEnv('VITE_RETRIEVAL_MODE', 'local')
  vi.stubEnv('VITE_DATA_MODE', 'mock')
  local = new MemoryStorage()
  session = new MemoryStorage()
  vi.stubGlobal('localStorage', local)
  vi.stubGlobal('sessionStorage', session)
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('测试禁止访问真实后端'))
  resetMock()
  await mockApi.login('member', 'member123')
})
afterEach(() => {
  resetMock()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('local 候选与引用映射', () => {
  it('全部已提交片段发往 HTTP，第二/第三片段排序由 fake HTTP 随查询改变', async () => {
    const chunks = installTopics()
    fetchSpy.mockImplementation(async (_, init) => {
      const input = JSON.parse(init!.body as string) as SearchRequest
      const index = input.query.includes('差旅') ? 1 : 2
      return response(input, [{ id: input.chunks[index]!.id, score: 0.7312 }])
    })
    const first = await searchKnowledgeBases(['kb-member'], '差旅材料', options)
    const second = await searchKnowledgeBases(['kb-member'], '备份恢复', options)
    expect(first).toMatchObject({ mode: 'local', modelId: RETRIEVAL_MODEL_ID, dimension: 512, totalChunks: 3, excludedDocuments: 0 })
    expect(first.hits[0]).toMatchObject({ chunkId: chunks[1]!.id, content: topics[1], score: 0.7312, version: 1 })
    expect(second.hits[0]).toMatchObject({ chunkId: chunks[2]!.id, content: topics[2] })
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).chunks).toEqual(
      chunks.map(({ id, content }) => expect.objectContaining({ id, content })),
    )
    first.hits[0]!.content = '不能改写正文'
    expect((await mockApi.chunks('doc-kb-member'))[1]!.content).toBe(topics[1])
  })
  it('合并多库全部候选，去重选库 ID，不受每篇首片段/分页限制', async () => {
    installTopics()
    await mockApi.login('admin', 'admin123')
    successful()
    const result = await searchKnowledgeBases(['kb-member', 'kb-admin', 'kb-member'], '问题', options)
    const input = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as SearchRequest
    expect(input.chunks).toHaveLength(4)
    expect(new Set(input.chunks.map((item) => item.id)).size).toBe(4)
    expect(result.totalChunks).toBe(4)
  })
  it('实际上传 TXT/MD 的全部正文参与；PDF/DOCX、预览、处理中和失败内容排除', async () => {
    const uploaded = []
    for (const extension of ['txt', 'md', 'pdf', 'docx']) {
      uploaded.push(await mockApi.upload('kb-member', new File([`${'预约说明。'.repeat(120)}\n\n${topics[1]}`], `测试.${extension}`), vi.fn()))
    }
    await mockApi.upload('kb-member', new File([''], 'empty.txt'), vi.fn())
    await vi.advanceTimersByTimeAsync(6000)
    await mockApi.documents('kb-member')
    const preview = await mockApi.preview(uploaded[0]!.id, { chunkSize: 50, chunkOverlap: 0 })
    await mockApi.upload('kb-member', new File(['待处理正文'], 'pending.txt'), vi.fn())
    successful()
    const result = await searchKnowledgeBases(['kb-member'], '差旅', options)
    const request = JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string) as SearchRequest
    const expected = database().documents.filter((doc) => doc.record.knowledgeBaseId === 'kb-member' && doc.record.status === 'ready' && /\.(md|txt)$/.test(doc.record.name)).flatMap((doc) => doc.chunks)
    expect(request.chunks.map((chunk) => chunk.id)).toEqual(expected.map((chunk) => chunk.id))
    expect(expected.length).toBeGreaterThan(3)
    expect(request.chunks.some((chunk) => preview.some((item) => item.id === chunk.id))).toBe(false)
    expect(request.chunks.some((chunk) => chunk.content.includes('不是 PDF / DOCX 原文'))).toBe(false)
    expect(result.excludedDocuments).toBe(2)
  })
  it('不把空正文、预览片段当作已提交候选', async () => {
    installTopics()
    mutate((db) => {
      const doc = db.documents.find((item) => item.record.id === 'doc-kb-member')!
      doc.chunks.push({ ...doc.chunks[0]!, id: `${doc.record.id}-preview-v2-1`, content: '仅预览' })
      doc.chunks.push({ ...doc.chunks[0]!, id: 'blank', content: '  ' })
    })
    successful()
    expect((await searchKnowledgeBases(['kb-member'], '问题', options)).totalChunks).toBe(3)
    mutate((db) => { db.documents.find((item) => item.record.id === 'doc-kb-member')!.text = '' })
    expect((await searchKnowledgeBases(['kb-member'], '问题', options)).totalChunks).toBe(0)
  })
  it.each(['数量', '总正文'])('候选%s超限明确失败且不发送截断后的 HTTP', async (kind) => {
    const chunks = installTopics()
    mutate((db) => {
      const doc = db.documents.find((item) => item.record.id === 'doc-kb-member')!
      doc.chunks = Array.from({ length: kind === '数量' ? 513 : 51 }, (_, i) => ({
        ...chunks[0]!, id: `c-${i}`, content: kind === '数量' ? '内容' : '字'.repeat(4000),
      }))
    })
    await expect(searchKnowledgeBases(['kb-member'], '问题', options)).rejects.toMatchObject({ code: 'CANDIDATE_LIMIT_EXCEEDED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('当前未授权库在读取候选之前拒绝，REST 不初始化 Mock 存储', async () => {
    await expect(searchKnowledgeBases(['kb-admin'], '问题', options)).rejects.toMatchObject({ status: 403 })
    vi.stubEnv('VITE_DATA_MODE', 'rest')
    local.clear()
    await expect(searchKnowledgeBases(['kb-member'], '问题', options)).rejects.toMatchObject({ code: 'REST_RETRIEVAL_UNAVAILABLE' })
    expect(local.length).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('服务断开不自动回退 demo，非法返回 ID 不映射正文', async () => {
    await expect(searchKnowledgeBases(['kb-member'], '问题', options)).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    fetchSpy.mockImplementation(async (_, init) => response(JSON.parse(init!.body as string), [{ id: '外部片段', score: 0.7 }]))
    await expect(searchKnowledgeBases(['kb-member'], '问题', options)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
  it('显式 demo 才使用旧固定引用，不谎称 BGE 或实际维度', async () => {
    vi.stubEnv('VITE_RETRIEVAL_MODE', 'demo')
    const result = await searchKnowledgeBases(['kb-member'], '问题', options)
    expect(result).toMatchObject({ mode: 'demo', dimension: 0, modelId: 'demo-fixed-citations' })
    expect(result.hits[0]!.score).toBe(0.88)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

const mutations: { name: string; status: number; change: (db: TestDatabase) => void }[] = [
  { name: '文档删除', status: 404, change: (db) => { db.documents = db.documents.filter((doc) => doc.record.id !== 'doc-kb-member') } },
  { name: '知识库删除', status: 404, change: (db) => { db.knowledgeBases = db.knowledgeBases.filter((kb) => kb.id !== 'kb-member') } },
  { name: '重新处理未完成', status: 409, change: (db) => { db.documents.find((doc) => doc.record.id === 'doc-kb-member')!.record.status = 'parsing' } },
  { name: '文档版本变化', status: 409, change: (db) => { db.documents.find((doc) => doc.record.id === 'doc-kb-member')!.record.version++ } },
  { name: '未命中片段同版正文变化', status: 409, change: (db) => { db.documents.find((doc) => doc.record.id === 'doc-kb-member')!.chunks[2]!.content = '新正文' } },
  { name: '原文同版变化', status: 409, change: (db) => { db.documents.find((doc) => doc.record.id === 'doc-kb-member')!.text = '新原文' } },
  { name: '片段版本变化', status: 409, change: (db) => { db.documents.find((doc) => doc.record.id === 'doc-kb-member')!.chunks[2]!.version++ } },
  { name: '配置变化', status: 409, change: (db) => { db.knowledgeBases.find((kb) => kb.id === 'kb-member')!.chunkSize = 100 } },
  { name: '模型权限撤销', status: 403, change: (db) => { db.users.find((user) => user.id === 'user-member')!.modelIds = ['model-qwen'] } },
  { name: '模型停用', status: 409, change: (db) => { db.models.find((model) => model.id === 'model-embedding')!.enabled = false } },
  { name: '所有权撤销', status: 403, change: (db) => { db.knowledgeBases.find((kb) => kb.id === 'kb-member')!.ownerId = 'user-admin' } },
  { name: '账号停用', status: 401, change: (db) => { db.users.find((user) => user.id === 'user-member')!.enabled = false } },
]

describe('检索返回前快照校验', () => {
  it.each(mutations)('$name 后迟到结果全部失败，绝不覆盖新数据库', async ({ change, status }) => {
    installTopics()
    const pending = deferred()
    const outcome = searchKnowledgeBases(['kb-member'], '问题', options).catch((error: unknown) => error)
    mutate(change)
    const latest = raw()
    pending.finish()
    expect(await outcome).toMatchObject({ status })
    expect(raw()).toBe(latest)
  })
  it('切换当前用户，即使新用户是有权管理员，也不能接收旧请求正文', async () => {
    const pending = deferred()
    const outcome = searchKnowledgeBases(['kb-member'], '问题', options).catch((error: unknown) => error)
    await mockApi.login('admin', 'admin123')
    pending.finish()
    expect(await outcome).toMatchObject({ code: 'IDENTITY_CHANGED' })
  })
  it('未命中文档被删除也冲突；不是只校验返回 ID 所在文档', async () => {
    await mockApi.login('admin', 'admin123')
    const pending = deferred()
    const outcome = searchKnowledgeBases(['kb-admin', 'kb-member'], '问题', options).catch((error: unknown) => error)
    await mockApi.deleteDocument('doc-kb-member')
    pending.finish([{ id: pending.input.chunks[0]!.id, score: 0.7 }])
    expect(await outcome).toMatchObject({ code: 'SOURCE_DELETED' })
  })
  it('新增文档只参与下次查询，不覆盖新增记录，也不混入当前结果', async () => {
    const pending = deferred()
    const outcome = searchKnowledgeBases(['kb-member'], '问题', options)
    const added = await mockApi.upload('kb-member', new File(['新文档'], 'new.txt'), vi.fn())
    const latest = raw()
    pending.finish()
    expect((await outcome).totalChunks).toBe(1)
    expect(raw()).toBe(latest)
    expect(database().documents.some((doc) => doc.record.id === added.id)).toBe(true)
  })
  it('停止等待会中止实际 fetch signal；忽略 abort 的迟到结果不会返回', async () => {
    const pending = deferred()
    const controller = new AbortController()
    const outcome = searchKnowledgeBases(['kb-member'], '问题', options, controller.signal).catch((error: unknown) => error)
    controller.abort()
    expect(await outcome).toMatchObject({ name: 'AbortError' })
    expect(pending.signal.aborted).toBe(true)
    const latest = raw()
    pending.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(raw()).toBe(latest)
  })
  it('新查询完成后旧查询取消，旧结果不会覆盖任何数据库状态', async () => {
    const chunks = installTopics()
    const pending = deferred()
    const controller = new AbortController()
    const old = searchKnowledgeBases(['kb-member'], '差旅', options, controller.signal).catch((error: unknown) => error)
    fetchSpy.mockImplementationOnce(async (_, init) => response(JSON.parse(init!.body as string), [{ id: chunks[2]!.id, score: 0.7 }]))
    const latest = await searchKnowledgeBases(['kb-member'], '备份', options)
    controller.abort()
    pending.finish([{ id: chunks[1]!.id, score: 0.7 }])
    expect(await old).toMatchObject({ name: 'AbortError' })
    expect(latest.hits[0]!.content).toBe(topics[2])
  })
})

describe('local 生成任务与流式竞态', () => {
  it('HTTP 前登记 ID/消息，同请求幂等且 stream 同步锁定，拒绝重复订阅', async () => {
    const conversation = await chat()
    const [one, two] = await Promise.all([
      mockApi.generate(conversation.id, '问题', 'request'),
      mockApi.generate(conversation.id, '问题', 'request'),
    ])
    expect(one).toEqual(two)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(await mockApi.messages(conversation.id)).toHaveLength(2)
    const pending = deferred()
    const work = stream(one.generationId)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    await expect(mockApi.stream(one.generationId, vi.fn(), new AbortController().signal)).rejects.toMatchObject({ status: 409 })
    expect(await mockApi.generate(conversation.id, '问题', 'request')).toEqual(one)
    await expect(mockApi.generate(conversation.id, '不同', 'request')).rejects.toMatchObject({ status: 409 })
    await expect(mockApi.generate(conversation.id, '问题', 'other')).rejects.toMatchObject({ status: 409 })
    pending.finish()
    await vi.runAllTimersAsync()
    expect(await work.outcome).toBeUndefined()
    expect((await mockApi.messages(conversation.id))[1]).toMatchObject({ status: 'complete', citations: [{ score: 0.7312 }] })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
  it('真实 HTTP 排序进入模板与引用，逐段输出并保留生成时配置和模式快照', async () => {
    const chunks = installTopics()
    const conversation = await chat()
    const task = await mockApi.generate(conversation.id, '差旅材料', 'request')
    await mockApi.saveConversation({ ...conversation, knowledgeBaseIds: [] }, conversation.id)
    vi.stubEnv('VITE_RETRIEVAL_MODE', 'demo')
    const pending = deferred()
    const work = stream(task.generationId)
    expect(pending.input).toMatchObject({ query: '差旅材料', ...options })
    pending.finish([{ id: chunks[1]!.id, score: 0.7312 }])
    await vi.runAllTimersAsync()
    expect(await work.outcome).toBeUndefined()
    const assistant = (await mockApi.messages(conversation.id))[1]!
    expect(assistant.content).toContain('实际Embedding检索，回答仍为模板，不是Chat模型输出')
    expect(assistant.content).toContain('BAAI/bge-small-zh-v1.5')
    expect(assistant.content).not.toContain('0.88')
    expect(assistant.citations[0]).toMatchObject({ content: topics[1], score: 0.7312 })
    expect(work.events.slice(-2).map((event) => event.type)).toEqual(['citations', 'done'])
    expect(assistant.content).toBe(work.events.flatMap((event) => event.type === 'delta' ? [event.text] : []).join(''))
    expect((await mockApi.conversations())[0]!.knowledgeBaseIds).toEqual([])
  })
  it('2000 码点限制在新任务创建之前检查，旧 demo 长问题重放不升级存储', async () => {
    const conversation = await chat()
    await expect(mockApi.generate(conversation.id, '😀'.repeat(2001), 'too-long')).rejects.toMatchObject({ status: 422 })
    expect(await mockApi.messages(conversation.id)).toEqual([])
    const allowed = await mockApi.generate(conversation.id, '😀'.repeat(2000), 'allowed')
    await mockApi.cancel(allowed.generationId)
    vi.stubEnv('VITE_RETRIEVAL_MODE', 'demo')
    const old = await mockApi.generate(conversation.id, '字'.repeat(2001), 'old')
    const oldWork = stream(old.generationId)
    await vi.runAllTimersAsync()
    expect(await oldWork.outcome).toBeUndefined()
    const before = raw()
    vi.stubEnv('VITE_RETRIEVAL_MODE', 'local')
    expect(await mockApi.generate(conversation.id, '字'.repeat(2001), 'old')).toEqual(old)
    const replay = stream(old.generationId)
    expect(await replay.outcome).toBeUndefined()
    expect(raw()).toBe(before)
    expect(database().version).toBe(STORAGE_VERSION)
    expect((await mockApi.messages(conversation.id))[3]!.content).toContain('未进行真实向量检索')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it.each(['无候选', '无命中', '未关联库'])('%s 不伪造引用', async (kind) => {
    if (kind === '无候选') await mockApi.deleteDocument('doc-kb-member')
    const conversation = await chat(kind === '未关联库' ? [] : ['kb-member'])
    fetchSpy.mockImplementation(async (_, init) => response(JSON.parse(init!.body as string), []))
    const task = await mockApi.generate(conversation.id, '问题', 'request')
    const work = stream(task.generationId)
    await vi.runAllTimersAsync()
    expect(await work.outcome).toBeUndefined()
    const assistant = (await mockApi.messages(conversation.id))[1]!
    expect(assistant.citations).toEqual([])
    expect(assistant.content).toContain('不提供来源或编造引用')
    if (kind === '未关联库') {
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(assistant.content).toContain('未执行 Embedding 检索')
    }
  })
  it.each(['cancel', 'signal', '删除会话', '重置'])('检索等待中%s：联动 abort，迟到 HTTP 不能写回或 done', async (kind) => {
    const conversation = await chat()
    const task = await mockApi.generate(conversation.id, '问题', 'request')
    const pending = deferred()
    const controller = new AbortController()
    const work = stream(task.generationId, undefined, controller.signal)
    if (kind === 'cancel') await mockApi.cancel(task.generationId)
    else if (kind === 'signal') controller.abort()
    else if (kind === '删除会话') await mockApi.deleteConversation(conversation.id)
    else resetMock()
    expect(await work.outcome).toMatchObject({ name: 'AbortError' })
    expect(pending.signal.aborted).toBe(true)
    const latest = raw()
    pending.finish()
    await vi.runAllTimersAsync()
    expect(raw()).toBe(latest)
    expect(work.events).toEqual([])
    if (kind === 'cancel' || kind === 'signal')
      expect((await mockApi.messages(conversation.id))[1]!.status).toBe('cancelled')
  })
  it('HTTP 错误使任务 error，不自动重复生成或回退，完成任务重放不检索', async () => {
    const conversation = await chat()
    const first = await mockApi.generate(conversation.id, '问题', 'request')
    const failed = stream(first.generationId)
    expect(await failed.outcome).toMatchObject({ code: 'NETWORK_ERROR' })
    expect(failed.events.map((event) => event.type)).toEqual(['error'])
    expect((await mockApi.messages(conversation.id))[1]).toMatchObject({ status: 'error', content: '', citations: [] })
    expect(await mockApi.generate(conversation.id, '问题', 'request')).toEqual(first)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    successful()
    const next = await mockApi.generate(conversation.id, '新问题', 'next')
    const work = stream(next.generationId)
    await vi.runAllTimersAsync()
    expect(await work.outcome).toBeUndefined()
    const stored = raw()
    const replay = stream(next.generationId)
    expect(await replay.outcome).toBeUndefined()
    expect(replay.events.map((event) => event.type)).toEqual(['citations', 'done'])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(raw()).toBe(stored)
  })
  it.each(mutations)('HTTP 等待中$name：任务 error，未输出任何旧正文', async ({ change, status }) => {
    installTopics()
    const conversation = await chat()
    const task = await mockApi.generate(conversation.id, '问题', 'request')
    const pending = deferred()
    const work = stream(task.generationId)
    mutate(change)
    const newest = database()
    pending.finish()
    await vi.runAllTimersAsync()
    expect(await work.outcome).toMatchObject({ status })
    expect(work.events.map((event) => event.type)).toEqual(['error'])
    const current = database()
    expect(current.documents).toEqual(newest.documents)
    expect(current.users).toEqual(newest.users)
    expect(current.knowledgeBases).toEqual(newest.knowledgeBases)
    expect(current.messages[1]).toMatchObject({ content: '', status: 'error', citations: [] })
  })
  it.each(['文档正文', '文档删除', '撤销权限', '切换身份'])('每个 delta 都校验来源，流中%s立即停止', async (kind) => {
    installTopics()
    successful()
    const conversation = await chat()
    const task = await mockApi.generate(conversation.id, '问题', 'request')
    let changed = false
    const work = stream(task.generationId, (event) => {
      if (event.type !== 'delta' || changed) return
      changed = true
      if (kind === '切换身份') session.setItem(SESSION_KEY, 'user-admin')
      else mutate((db) => {
        if (kind === '文档正文') db.documents.find((doc) => doc.record.id === 'doc-kb-member')!.chunks[2]!.content = '新的未命中正文'
        else if (kind === '文档删除') db.documents = db.documents.filter((doc) => doc.record.id !== 'doc-kb-member')
        else db.users.find((user) => user.id === 'user-member')!.modelIds = []
      })
    })
    await vi.runAllTimersAsync()
    expect(await work.outcome).toBeInstanceOf(Error)
    expect(work.events.filter((event) => event.type === 'delta')).toHaveLength(1)
    expect(work.events.map((event) => event.type)).not.toContain('done')
    expect(database().messages[1]!.status).toBe('error')
  })
  it('HTTP 等待期间新增文档和会话修改保留，不能用旧 db 持久化覆盖', async () => {
    const conversation = await chat()
    const task = await mockApi.generate(conversation.id, '问题', 'request')
    const pending = deferred()
    const work = stream(task.generationId)
    const added = await mockApi.upload('kb-member', new File(['新正文'], '新增.txt'), vi.fn())
    await mockApi.saveConversation({ ...conversation, title: '新标题', knowledgeBaseIds: [] }, conversation.id)
    pending.finish()
    await vi.runAllTimersAsync()
    expect(await work.outcome).toBeUndefined()
    expect(database().documents.some((doc) => doc.record.id === added.id)).toBe(true)
    expect(database().conversations[0]).toMatchObject({ title: '新标题', knowledgeBaseIds: [] })
  })
})
