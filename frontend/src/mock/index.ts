import type {
  Api,
  Chunk,
  ChunkConfig,
  Citation,
  Conversation,
  ConversationInput,
  DocumentRecord,
  Generation,
  KnowledgeBase,
  KnowledgeInput,
  Message,
  Model,
  ModelInput,
  ModelType,
  User,
  UserInput,
} from '@/types'
import { validateChunkConfig, validateFile, splitText } from '@/utils/validation'

export const STORAGE_KEY = 'model-workspace.mock.database'
export const SESSION_KEY = 'model-workspace.mock.user-id'
export const STORAGE_VERSION = 1
export const MAX_STORAGE_BYTES = 2 * 1024 * 1024

interface DocumentJob {
  startedAt: number
  config: ChunkConfig
  version: number
  actorId: string
}
interface StoredDocument {
  record: DocumentRecord
  text: string
  parsed: boolean
  chunks: Chunk[]
  job?: DocumentJob
}
interface RequestRecord extends Generation {
  conversationId: string
  userMessageId: string
  clientRequestId: string
  modelId: string
  knowledgeBaseIds: string[]
}
interface Database {
  version: number
  users: User[]
  models: Model[]
  knowledgeBases: KnowledgeBase[]
  documents: StoredDocument[]
  conversations: Conversation[]
  messages: Message[]
  requests: RequestRecord[]
}
interface Task {
  text: string
  citations: Citation[]
  controller: AbortController
  running: boolean
}
const tasks = new Map<string, Task>()
let recovered = false
let sequence = 0
const now = (): string => new Date().toISOString()
const uid = (prefix: string): string =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2)}`}`
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const problem = (status: number, message: string): Error & { status: number; code: string } =>
  Object.assign(new Error(message), { status, code: `MOCK_${status}` })
const abortError = (): Error => Object.assign(new Error('模拟生成已中止。'), { name: 'AbortError' })
function requireValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw problem(404, `${label}不存在或已删除。`)
  return value
}
function textField(value: string, label: string, max = 200, optional = false): string {
  if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max)
    throw problem(422, `${label}格式或长度无效。`)
  return value.trim()
}
function booleanField(value: boolean): boolean {
  if (typeof value !== 'boolean') throw problem(422, '启用状态必须是布尔值。')
  return value
}
function ids(value: string[]): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id.trim()))
    throw problem(422, '资源 ID 列表无效。')
  return [...new Set(value)]
}
function configOf(value: ChunkConfig): ChunkConfig {
  const config = { chunkSize: value.chunkSize, chunkOverlap: value.chunkOverlap }
  try {
    validateChunkConfig(config)
  } catch (error) {
    throw problem(422, error instanceof Error ? error.message : '切分参数无效。')
  }
  return config
}
function makeChunks(
  documentId: string,
  text: string,
  config: ChunkConfig,
  version: number,
  preview = false,
): Chunk[] {
  configOf(config)
  if (!text.trim()) return []
  // 高重叠可能放大到数百万片段；在调用共享切分器前先保守限制输出规模。
  const count = Math.max(
    1,
    Math.ceil(
      Math.max(0, text.length - config.chunkSize) / (config.chunkSize - config.chunkOverlap),
    ) + 1,
  )
  if (count * (Math.min(text.length, config.chunkSize) + 180) * 2 > MAX_STORAGE_BYTES)
    throw problem(413, '切分结果过大，请减少重叠、缩短演示文档。')
  return splitText(text, config).map((content, index) => ({
    id: `${documentId}-${preview ? 'preview-' : ''}v${version}-${index + 1}`,
    documentId,
    index: index + 1,
    content,
    page: null,
    section: `模拟字符切分 · 片段 ${index + 1}`,
    version,
  }))
}
function seed(): Database {
  const createdAt = now()
  const model = (id: string, name: string, type: ModelType, dimension?: number): Model => ({
    id,
    name,
    type,
    provider: 'Mock 演示',
    baseUrl: 'https://mock.invalid/v1',
    modelName: name,
    enabled: true,
    description: '仅用于交互演示，不连接真实模型。',
    hasApiKey: false,
    createdAt,
    ...(dimension === undefined ? {} : { dimension }),
  })
  const models = [
    model('model-qwen', 'Qwen2.5-7B', 'chat'),
    model('model-deepseek', 'DeepSeek-R1', 'chat'),
    model('model-embedding', 'bge-small-zh', 'embedding', 512),
    model('model-rerank', 'bge-reranker', 'rerank'),
  ]
  const users: User[] = [
    {
      id: 'user-admin',
      username: 'admin',
      name: '演示管理员',
      role: 'admin',
      enabled: true,
      modelIds: models.map((item) => item.id),
      createdAt,
    },
    {
      id: 'user-member',
      username: 'member',
      name: '演示成员',
      role: 'user',
      enabled: true,
      modelIds: ['model-qwen', 'model-embedding', 'model-rerank'],
      createdAt,
    },
  ]
  const knowledgeBases: KnowledgeBase[] = users.map((user) => ({
    id: `kb-${user.username}`,
    name: `${user.name}的示例知识库`,
    description: '虚构演示资料，请勿存放敏感信息。',
    embeddingModelId: 'model-embedding',
    rerankModelId: 'model-rerank',
    ownerId: user.id,
    chunkSize: 500,
    chunkOverlap: 50,
    createdAt,
  }))
  const documents: StoredDocument[] = knowledgeBases.map((kb) => {
    const id = `doc-${kb.id}`
    const text = `# ${kb.name}\n\n这是虚构的演示文档，不是业务事实或真实模型输出。\n\n知识库流程：上传文档后依次模拟解析、字符切分、向量化与入库。只有就绪文档可以提供引用。\n\n权限说明：普通成员只能访问本人资源及授权模型；管理员可以治理知识库，但不能读取他人的会话。\n\n引用说明：片段采用字符切分，没有真实页码；相似度是模拟展示数值，不是答案准确率。`
    const chunks = makeChunks(id, text, kb, 1)
    return {
      record: {
        id,
        knowledgeBaseId: kb.id,
        name: '演示使用说明.md',
        size: new Blob([text]).size,
        status: 'ready',
        progress: 100,
        chunkCount: chunks.length,
        version: 1,
        chunkSize: 500,
        chunkOverlap: 50,
        createdAt,
        simulated: true,
      },
      text,
      parsed: true,
      chunks,
    }
  })
  return {
    version: STORAGE_VERSION,
    users,
    models,
    knowledgeBases,
    documents,
    conversations: [],
    messages: [],
    requests: [],
  }
}
function storage(kind: 'localStorage' | 'sessionStorage'): Storage {
  try {
    const result = globalThis[kind]
    if (!result) throw new Error('不可用')
    return result
  } catch {
    throw problem(507, `无法访问 ${kind}，请允许浏览器存储；Node 测试可注入内存 Storage。`)
  }
}
function readItem(store: Storage, key: string): string | null {
  try {
    return store.getItem(key)
  } catch {
    throw problem(507, '读取演示存储失败。')
  }
}
function rollback(store: Storage, key: string, old: string | null): void {
  try {
    if (store.getItem(key) !== old) {
      if (old === null) store.removeItem(key)
      else store.setItem(key, old)
    }
  } catch {
    /* 存储完全不可用时只能尽力回滚，不能宣称写入成功。 */
  }
}
function writeItem(store: Storage, key: string, value: string | null): void {
  const old = readItem(store, key)
  try {
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    rollback(store, key, old)
    throw problem(507, '演示数据保存失败，可能已达到浏览器配额；本次操作未确认成功。')
  }
}
function persist(db: Database): void {
  const serialized = JSON.stringify(db)
  // 同时限制 UTF-16 存储占用与 UTF-8 文本体积，包含切片、消息和引用副本。
  if (
    Math.max(serialized.length * 2, new TextEncoder().encode(serialized).byteLength) >
    MAX_STORAGE_BYTES
  ) {
    throw problem(413, '演示数据超过 2 MiB 文字限制，请删除部分文档或会话后重试。')
  }
  writeItem(storage('localStorage'), STORAGE_KEY, serialized)
}
function database(): Database {
  const raw = readItem(storage('localStorage'), STORAGE_KEY)
  let db: Database
  if (raw === null) {
    db = seed()
    persist(db)
  } else {
    try {
      db = JSON.parse(raw) as Database
    } catch {
      throw problem(500, '演示数据损坏，请重置演示数据。')
    }
    if (!db || typeof db !== 'object') throw problem(500, '演示数据格式无效，请重置。')
    if (db.version !== STORAGE_VERSION) {
      resetMock()
      return database()
    }
    if (
      ![
        db.users,
        db.models,
        db.knowledgeBases,
        db.documents,
        db.conversations,
        db.messages,
        db.requests,
      ].every(Array.isArray)
    ) {
      throw problem(500, '演示数据结构无效，请重置。')
    }
  }
  if (!recovered) {
    let changed = false
    for (const message of db.messages) {
      if (message.status === 'streaming') {
        message.status = 'error'
        changed = true
      }
    }
    if (changed) persist(db)
    recovered = true
  }
  return db
}
export function resetMock(): void {
  const local = storage('localStorage')
  const session = storage('sessionStorage')
  const previous = readItem(local, STORAGE_KEY)
  persist(seed())
  try {
    writeItem(session, SESSION_KEY, null)
  } catch (error) {
    rollback(local, STORAGE_KEY, previous)
    throw error
  }
  for (const task of tasks.values()) task.controller.abort()
  tasks.clear()
  recovered = true
}
function authenticated(db: Database): User {
  const userId = readItem(storage('sessionStorage'), SESSION_KEY)
  const user = db.users.find((item) => item.id === userId)
  if (!user || !user.enabled) throw problem(401, '请重新登录，账号可能已停用或删除。')
  return user
}
function context(): { db: Database; user: User } {
  const db = database()
  return { db, user: authenticated(db) }
}
function admin(user: User): void {
  if (user.role !== 'admin') throw problem(403, '此操作仅限管理员。')
}
function usableModel(db: Database, user: User, id: string, type?: ModelType): Model {
  const model = requireValue(
    db.models.find((item) => item.id === id),
    '模型',
  )
  if (user.role !== 'admin' && !user.modelIds.includes(id))
    throw problem(403, '未获此模型使用授权。')
  if (!model.enabled) throw problem(409, '模型未启用。')
  if (type && model.type !== type) throw problem(422, `需要 ${type} 类型模型。`)
  return model
}
function knowledge(db: Database, user: User, id: string): KnowledgeBase {
  const kb = requireValue(
    db.knowledgeBases.find((item) => item.id === id),
    '知识库',
  )
  if (user.role !== 'admin' && kb.ownerId !== user.id) throw problem(403, '无权访问此知识库。')
  return kb
}
function knowledgeModels(db: Database, user: User, kb: KnowledgeInput): void {
  usableModel(db, user, kb.embeddingModelId, 'embedding')
  if (kb.rerankModelId) usableModel(db, user, kb.rerankModelId, 'rerank')
}
function readableDocument(db: Database, user: User, id: string): StoredDocument {
  const doc = requireValue(
    db.documents.find((item) => item.record.id === id),
    '文档',
  )
  knowledge(db, user, doc.record.knowledgeBaseId)
  return doc
}
function conversation(db: Database, user: User, id: string): Conversation {
  const value = requireValue(
    db.conversations.find((item) => item.id === id),
    '会话',
  )
  if (value.ownerId !== user.id) throw problem(403, '只能访问本人的会话。')
  return value
}
function conversationModels(
  db: Database,
  user: User,
  input: Pick<ConversationInput, 'modelId' | 'knowledgeBaseIds'>,
): void {
  usableModel(db, user, input.modelId, 'chat')
  for (const id of input.knowledgeBaseIds) knowledgeModels(db, user, knowledge(db, user, id))
}
function modelReferenced(db: Database, id: string): boolean {
  return (
    db.knowledgeBases.some((kb) => kb.embeddingModelId === id || kb.rerankModelId === id) ||
    db.conversations.some((item) => item.modelId === id) ||
    db.requests.some(
      (request) =>
        request.modelId === id &&
        db.messages.some(
          (message) => message.id === request.assistantMessageId && message.status === 'streaming',
        ),
    )
  )
}
function advance(db: Database, docs: StoredDocument[]): void {
  let changed = false
  const snapshots = docs.filter((doc) => doc.job).map((doc) => ({ doc, previous: copy(doc) }))
  for (const doc of docs) {
    const job = doc.job
    if (!job) continue
    const elapsed = Math.max(0, Date.now() - job.startedAt)
    const before = JSON.stringify(doc)
    try {
      const actor = requireValue(
        db.users.find((user) => user.id === job.actorId),
        '处理任务用户',
      )
      if (!actor.enabled) throw problem(403, '处理任务所属账号已停用。')
      knowledgeModels(db, actor, knowledge(db, actor, doc.record.knowledgeBaseId))
      if (elapsed >= 1500) {
        if (!doc.text.trim())
          throw problem(422, '文档正文为空，模拟解析失败；可重试或重新上传有内容的文档。')
        doc.parsed = true
      }
      if (elapsed >= 6000) {
        const chunks = makeChunks(doc.record.id, doc.text, job.config, job.version)
        if (!chunks.length) throw problem(422, '文档未生成有效片段。')
        // 只有整个处理成功，才一次性替换片段、参数与版本。
        doc.chunks = chunks
        Object.assign(doc.record, job.config, {
          version: job.version,
          status: 'ready',
          progress: 100,
          chunkCount: chunks.length,
        })
        delete doc.job
      } else {
        doc.record.status =
          elapsed < 1500
            ? 'parsing'
            : elapsed < 3000
              ? 'splitting'
              : elapsed < 4500
                ? 'embedding'
                : 'indexing'
        doc.record.progress = Math.min(99, Math.floor(elapsed / 60))
      }
      delete doc.record.error
    } catch (error) {
      doc.record.status = 'failed'
      doc.record.error = error instanceof Error ? error.message : '模拟处理失败，可重试。'
      delete doc.job
    }
    if (JSON.stringify(doc) !== before) changed = true
  }
  if (changed) {
    try {
      persist(db)
    } catch (error) {
      if (!(error instanceof Error) || !('status' in error) || error.status !== 413) throw error
      // 原文可以入库不代表片段副本也能容纳；超限时保留旧版本并落库失败状态。
      for (const { doc, previous } of snapshots) {
        doc.record = previous.record
        doc.chunks = previous.chunks
        doc.record.status = 'failed'
        doc.record.error = '模拟切片使总数据超过 2 MiB，请清理演示数据或调整切分参数后重试。'
        delete doc.job
      }
      persist(db)
    }
  }
}
function requestContext(id: string): {
  db: Database
  user: User
  request: RequestRecord
  message: Message
} {
  const { db, user } = context()
  const request = requireValue(
    db.requests.find((item) => item.generationId === id),
    '生成任务',
  )
  conversation(db, user, request.conversationId)
  const message = requireValue(
    db.messages.find((item) => item.id === request.assistantMessageId),
    '助手消息',
  )
  return { db, user, request, message }
}
function readableCitation(db: Database, user: User, citation: Citation): void {
  const kb = knowledge(db, user, citation.knowledgeBaseId)
  const doc = readableDocument(db, user, citation.documentId)
  if (doc.record.knowledgeBaseId !== kb.id) throw problem(404, '引用来源已失效。')
  // 历史片段保留原版本；源文件必须仍然存在，且当前仍有知识库与模型访问权。
  knowledgeModels(db, user, kb)
}
function collectCitations(db: Database, selected: string[]): Citation[] {
  return db.documents
    .filter((doc) => selected.includes(doc.record.knowledgeBaseId) && doc.record.status === 'ready')
    .flatMap((doc) =>
      doc.chunks.slice(0, 1).map((chunk) => ({
        id: uid('citation'),
        documentId: doc.record.id,
        knowledgeBaseId: doc.record.knowledgeBaseId,
        chunkId: chunk.id,
        documentName: doc.record.name,
        page: chunk.page,
        section: chunk.section,
        content: chunk.content,
        score: 0.88,
        version: chunk.version,
      })),
    )
    .slice(0, 3)
}
function wait(ms: number, signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signals.some((signal) => signal.aborted)) {
      reject(abortError())
      return
    }
    const cleanup = (): void =>
      signals.forEach((signal) => signal.removeEventListener('abort', abort))
    const abort = (): void => {
      clearTimeout(timer)
      cleanup()
      reject(abortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signals.forEach((signal) => signal.addEventListener('abort', abort, { once: true }))
  })
}
function finishFailedTask(id: string, task: Task, status: 'cancelled' | 'error'): void {
  if (tasks.get(id) !== task) return
  task.controller.abort()
  try {
    const db = database()
    const request = db.requests.find((item) => item.generationId === id)
    const message = db.messages.find((item) => item.id === request?.assistantMessageId)
    if (message?.status === 'streaming') {
      message.status = status
      persist(db)
    }
  } catch {
    /* 不覆盖原始错误；刷新时仍会将遗留 streaming 转为 error。 */
  }
}

export const mockApi: Api = {
  async login(username, password) {
    const db = database()
    const user = db.users.find((item) => item.username === username.trim())
    // 公开的非生产演示凭证；新增用户统一 demo123，忽略且不保存提交密码。
    const accepted =
      user?.id === 'user-admin' ? 'admin123' : user?.id === 'user-member' ? 'member123' : 'demo123'
    if (!user || password !== accepted) throw problem(401, '演示账号或密码错误（非生产认证）。')
    if (!user.enabled) throw problem(403, '演示账号已停用。')
    writeItem(storage('sessionStorage'), SESSION_KEY, user.id)
    return copy({ user })
  },
  async restore() {
    const db = database()
    const store = storage('sessionStorage')
    const id = readItem(store, SESSION_KEY)
    if (!id) return null
    const user = db.users.find((item) => item.id === id && item.enabled)
    if (!user) {
      writeItem(store, SESSION_KEY, null)
      return null
    }
    return copy({ user })
  },
  async logout() {
    // 清理会话无需账号继续有效，停用账号同样可以退出。
    writeItem(storage('sessionStorage'), SESSION_KEY, null)
  },
  async models() {
    const { db, user } = context()
    return copy(
      db.models.filter(
        (model) => user.role === 'admin' || (model.enabled && user.modelIds.includes(model.id)),
      ),
    )
  },
  async saveModel(input: ModelInput, id) {
    const { db, user } = context()
    admin(user)
    const old =
      id === undefined
        ? undefined
        : requireValue(
            db.models.find((model) => model.id === id),
            '模型',
          )
    const name = textField(input.name, '模型名称')
    if (
      db.models.some((model) => model.id !== id && model.name.toLowerCase() === name.toLowerCase())
    )
      throw problem(409, '模型名称已存在。')
    if (!['chat', 'embedding', 'rerank'].includes(input.type)) throw problem(422, '模型类型无效。')
    const baseUrl = textField(input.baseUrl, '模型地址', 2000)
    try {
      const url = new URL(baseUrl)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('无效地址')
    } catch {
      throw problem(422, '模型地址须为不含账号密码的 HTTP(S) URL。')
    }
    if (
      input.dimension !== undefined &&
      (!Number.isInteger(input.dimension) || input.dimension <= 0)
    )
      throw problem(422, '向量维度必须为正整数。')
    if (
      old &&
      modelReferenced(db, old.id) &&
      (old.type !== input.type || old.dimension !== input.dimension)
    )
      throw problem(409, '模型被知识库或会话引用，不能改变类型或维度。')
    const model: Model = {
      id: old?.id ?? uid('model'),
      name,
      type: input.type,
      provider: textField(input.provider, '提供商'),
      baseUrl,
      modelName: textField(input.modelName, '模型标识'),
      enabled: booleanField(input.enabled),
      description: textField(input.description, '描述', 4000, true),
      createdAt: old?.createdAt ?? now(),
      hasApiKey: input.clearApiKey ? false : !!input.apiKey?.trim() || (old?.hasApiKey ?? false),
      ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
    }
    db.models = old
      ? db.models.map((item) => (item.id === old.id ? model : item))
      : [...db.models, model]
    persist(db)
    return copy(model)
  },
  async deleteModel(id) {
    const { db, user } = context()
    admin(user)
    requireValue(
      db.models.find((model) => model.id === id),
      '模型',
    )
    if (modelReferenced(db, id)) throw problem(409, '模型被知识库或会话引用，无法删除。')
    db.models = db.models.filter((model) => model.id !== id)
    db.users.forEach((item) => {
      item.modelIds = item.modelIds.filter((modelId) => modelId !== id)
    })
    persist(db)
  },
  async testModel(id) {
    const { db, user } = context()
    usableModel(db, user, id)
    return { message: '模拟连接测试通过；未发起网络请求，也未验证真实模型或密钥。', latency: 30 }
  },
  async users() {
    const { db, user } = context()
    admin(user)
    return copy(db.users)
  },
  async saveUser(input: UserInput, id) {
    const { db, user } = context()
    admin(user)
    const old =
      id === undefined
        ? undefined
        : requireValue(
            db.users.find((item) => item.id === id),
            '用户',
          )
    const username = textField(input.username, '登录账号', 64)
    if (/\s/.test(username)) throw problem(422, '登录账号不能包含空白字符。')
    if (
      db.users.some(
        (item) => item.id !== id && item.username.toLowerCase() === username.toLowerCase(),
      )
    )
      throw problem(409, '登录账号已存在。')
    if (!['admin', 'user'].includes(input.role)) throw problem(422, '用户角色无效。')
    const modelIds = ids(input.modelIds)
    modelIds.forEach((modelId) =>
      requireValue(
        db.models.find((model) => model.id === modelId),
        '授权模型',
      ),
    )
    const value: User = {
      id: old?.id ?? uid('user'),
      username,
      name: textField(input.name, '姓名', 100),
      role: input.role,
      enabled: booleanField(input.enabled),
      modelIds,
      createdAt: old?.createdAt ?? now(),
    }
    if (
      old?.role === 'admin' &&
      old.enabled &&
      (value.role !== 'admin' || !value.enabled) &&
      !db.users.some((item) => item.id !== old.id && item.role === 'admin' && item.enabled)
    )
      throw problem(409, '必须保留至少一个启用管理员。')
    db.users = old
      ? db.users.map((item) => (item.id === old.id ? value : item))
      : [...db.users, value]
    persist(db)
    return copy(value)
  },
  async deleteUser(id) {
    const { db, user } = context()
    admin(user)
    const target = requireValue(
      db.users.find((item) => item.id === id),
      '用户',
    )
    if (target.id === user.id) throw problem(409, '不能删除当前登录的自己账号。')
    if (
      target.role === 'admin' &&
      target.enabled &&
      !db.users.some((item) => item.id !== id && item.role === 'admin' && item.enabled)
    )
      throw problem(409, '不能删除最后一个启用管理员。')
    if (
      db.knowledgeBases.some((kb) => kb.ownerId === id) ||
      db.conversations.some((item) => item.ownerId === id)
    )
      throw problem(409, '用户仍拥有知识库或会话，请先由有权限的账号清理资源。')
    db.users = db.users.filter((item) => item.id !== id)
    persist(db)
  },
  async knowledgeBases() {
    const { db, user } = context()
    return copy(db.knowledgeBases.filter((kb) => user.role === 'admin' || kb.ownerId === user.id))
  },
  async saveKnowledge(input: KnowledgeInput, id) {
    const { db, user } = context()
    const old = id === undefined ? undefined : knowledge(db, user, id)
    const config = configOf(input)
    knowledgeModels(db, user, input)
    if (
      old &&
      old.embeddingModelId !== input.embeddingModelId &&
      db.documents.some((doc) => doc.record.knowledgeBaseId === id)
    )
      throw problem(409, '非空知识库禁止更换 Embedding 模型。')
    const kb: KnowledgeBase = {
      id: old?.id ?? uid('kb'),
      name: textField(input.name, '知识库名称'),
      description: textField(input.description, '描述', 4000, true),
      embeddingModelId: input.embeddingModelId,
      rerankModelId: input.rerankModelId,
      ownerId: old?.ownerId ?? user.id,
      createdAt: old?.createdAt ?? now(),
      ...config,
    }
    db.knowledgeBases = old
      ? db.knowledgeBases.map((item) => (item.id === old.id ? kb : item))
      : [...db.knowledgeBases, kb]
    persist(db)
    return copy(kb)
  },
  async deleteKnowledge(id) {
    const { db, user } = context()
    knowledge(db, user, id)
    db.knowledgeBases = db.knowledgeBases.filter((kb) => kb.id !== id)
    db.documents = db.documents.filter((doc) => doc.record.knowledgeBaseId !== id)
    // 保留历史会话配置与引用快照；后续生成/引用访问会明确报来源失效。
    persist(db)
  },
  async documents(kbId) {
    const { db, user } = context()
    knowledge(db, user, kbId)
    const docs = db.documents.filter((doc) => doc.record.knowledgeBaseId === kbId)
    advance(db, docs)
    return copy(docs.map((doc) => doc.record))
  },
  async document(id) {
    const { db, user } = context()
    const doc = readableDocument(db, user, id)
    advance(db, [doc])
    return copy(doc.record)
  },
  async upload(kbId, file, onProgress) {
    let state = context()
    const actorId = state.user.id
    const initialKb = knowledge(state.db, state.user, kbId)
    knowledgeModels(state.db, state.user, initialKb)
    try {
      validateFile(file)
    } catch (error) {
      // 零字节的受支持文件仍可进入解析失败演示，不跳过类型或大小检查。
      if (file.size !== 0 || !/\.(md|txt|pdf|docx)$/i.test(file.name))
        throw problem(
          file.size > 20 * 1024 * 1024 ? 413 : 415,
          error instanceof Error ? error.message : '文件无效。',
        )
    }
    if (file.size > 20 * 1024 * 1024) throw problem(413, '文件超过 20 MiB 限制。')
    if (!/\.(md|txt|pdf|docx)$/i.test(file.name)) throw problem(415, '仅支持 PDF、DOCX、MD、TXT。')
    const binary = /\.(pdf|docx)$/i.test(file.name)
    if (!binary && file.size > MAX_STORAGE_BYTES) throw problem(413, '演示文本超过 2 MiB 限制。')
    onProgress(0)
    const text = binary
      ? file.size
        ? `模拟解析说明：${file.name}\n此处是预设示例文字，不是 PDF / DOCX 原文，也未执行真实解析。\n本演示仅展示解析、切分、向量化和索引的状态流转。请连接真实后端读取文件内容。`
        : ''
      : await file.text()
    onProgress(70)
    // file.text() 期间可能切换账号、删除资源或撤销授权，提交前必须读取最新数据库。
    state = context()
    if (state.user.id !== actorId) throw problem(401, '上传期间登录身份已改变。')
    const kb = knowledge(state.db, state.user, kbId)
    knowledgeModels(state.db, state.user, kb)
    const config = configOf(kb)
    const record: DocumentRecord = {
      id: uid('doc'),
      knowledgeBaseId: kbId,
      name: textField(file.name, '文件名', 255),
      size: file.size,
      status: 'parsing',
      progress: 0,
      chunkCount: 0,
      version: 0,
      createdAt: now(),
      simulated: true,
      ...config,
    }
    state.db.documents.push({
      record,
      text,
      parsed: false,
      chunks: [],
      job: { startedAt: Date.now(), config, version: 1, actorId },
    })
    persist(state.db)
    onProgress(100)
    return copy(record)
  },
  async deleteDocument(id) {
    const { db, user } = context()
    readableDocument(db, user, id)
    db.documents = db.documents.filter((doc) => doc.record.id !== id)
    persist(db)
  },
  async chunks(id) {
    const { db, user } = context()
    const doc = readableDocument(db, user, id)
    advance(db, [doc])
    if (doc.record.status !== 'ready') throw problem(409, '文档尚未就绪，不能读取入库片段。')
    return copy(doc.chunks)
  },
  async preview(id, input) {
    const { db, user } = context()
    const doc = readableDocument(db, user, id)
    const config = configOf(input)
    advance(db, [doc])
    if (!doc.parsed) throw problem(409, '文档尚未成功解析，无法预览。')
    return copy(makeChunks(id, doc.text, config, doc.record.version + 1, true))
  },
  async process(id, input) {
    const { db, user } = context()
    const doc = readableDocument(db, user, id)
    const config = configOf(input)
    knowledgeModels(db, user, knowledge(db, user, doc.record.knowledgeBaseId))
    advance(db, [doc])
    if (doc.job) throw problem(409, '文档已经在处理中。')
    doc.job = { startedAt: Date.now(), config, version: doc.record.version + 1, actorId: user.id }
    doc.record.status = 'parsing'
    doc.record.progress = 0
    delete doc.record.error
    persist(db)
    return copy(doc.record)
  },
  async download(id) {
    const { db, user } = context()
    const doc = readableDocument(db, user, id)
    const text = /\.(pdf|docx)$/i.test(doc.record.name)
      ? `模拟下载说明\n文档名称：${doc.record.name}\n没有保存原始二进制文件，也没有执行真实 PDF / DOCX 解析。此 TXT 仅为说明，不是原文。\n`
      : doc.text
    return new Blob([text], { type: 'text/plain;charset=utf-8' })
  },
  async conversations() {
    const { db, user } = context()
    return copy(
      db.conversations
        .filter((item) => item.ownerId === user.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    )
  },
  async saveConversation(input: ConversationInput, id) {
    const { db, user } = context()
    const old = id === undefined ? undefined : conversation(db, user, id)
    const knowledgeBaseIds = ids(input.knowledgeBaseIds)
    conversationModels(db, user, { modelId: input.modelId, knowledgeBaseIds })
    const value: Conversation = {
      id: old?.id ?? uid('conversation'),
      title: textField(input.title, '会话标题', 100, true) || '新会话',
      modelId: input.modelId,
      knowledgeBaseIds,
      ownerId: user.id,
      createdAt: old?.createdAt ?? now(),
      updatedAt: now(),
    }
    db.conversations = old
      ? db.conversations.map((item) => (item.id === old.id ? value : item))
      : [...db.conversations, value]
    persist(db)
    return copy(value)
  },
  async deleteConversation(id) {
    const { db, user } = context()
    conversation(db, user, id)
    const removed = db.requests.filter((item) => item.conversationId === id)
    db.conversations = db.conversations.filter((item) => item.id !== id)
    db.messages = db.messages.filter((item) => item.conversationId !== id)
    db.requests = db.requests.filter((item) => item.conversationId !== id)
    persist(db)
    removed.forEach((request) => {
      tasks.get(request.generationId)?.controller.abort()
      tasks.delete(request.generationId)
    })
  },
  async messages(id) {
    const { db, user } = context()
    conversation(db, user, id)
    return copy(db.messages.filter((item) => item.conversationId === id))
  },
  async generate(id, content, clientRequestId) {
    const { db, user } = context()
    const chat = conversation(db, user, id)
    const body = textField(content, '提问', 20000)
    const requestId = textField(clientRequestId, '客户端请求 ID', 200)
    conversationModels(db, user, chat)
    const existing = db.requests.find(
      (item) => item.conversationId === id && item.clientRequestId === requestId,
    )
    if (existing) {
      const original = requireValue(
        db.messages.find((item) => item.id === existing.userMessageId),
        '原始提问',
      )
      if (original.content !== body) throw problem(409, '相同 clientRequestId 不能用于不同提问。')
      return copy({
        generationId: existing.generationId,
        assistantMessageId: existing.assistantMessageId,
      })
    }
    if (db.messages.some((item) => item.conversationId === id && item.status === 'streaming'))
      throw problem(409, '此会话已有进行中的生成任务。')
    advance(
      db,
      db.documents.filter((doc) => chat.knowledgeBaseIds.includes(doc.record.knowledgeBaseId)),
    )
    const citations = collectCitations(db, chat.knowledgeBaseIds)
    const text = `【模拟示例，不是实际模型回答】\n你提出的问题是：“${body.slice(0, 200)}”。\n此回复由预设模板生成，未调用任何模型，也未进行真实向量检索。\n${citations.length ? `为演示引用溯源，选取了已选知识库中 ${citations.length} 份就绪文档的示例片段。引用分数 0.88 仅为模拟值，不代表答案准确率。请查看引用并自行核对原文。` : '当前没有可引用的已选知识库就绪文档，因此不提供来源或编造引用。'}\n此内容仅用于演示流式交互，不作为事实依据。`
    const createdAt = now()
    const userMessage: Message = {
      id: uid('message'),
      conversationId: id,
      role: 'user',
      content: body,
      citations: [],
      status: 'complete',
      createdAt,
    }
    const assistant: Message = {
      id: uid('message'),
      conversationId: id,
      role: 'assistant',
      content: '',
      citations: [],
      status: 'streaming',
      createdAt,
    }
    const generationId = uid('generation')
    db.messages.push(userMessage, assistant)
    db.requests.push({
      generationId,
      assistantMessageId: assistant.id,
      userMessageId: userMessage.id,
      conversationId: id,
      clientRequestId: requestId,
      modelId: chat.modelId,
      knowledgeBaseIds: [...chat.knowledgeBaseIds],
    })
    chat.updatedAt = createdAt
    persist(db)
    tasks.set(generationId, { text, citations, controller: new AbortController(), running: false })
    return copy({ generationId, assistantMessageId: assistant.id })
  },
  async stream(id, onEvent, signal) {
    const initial = requestContext(id)
    if (initial.message.status === 'cancelled') throw abortError()
    const task = tasks.get(id)
    if (task?.running) throw problem(409, '此生成任务已有流式订阅。')
    if (initial.message.status === 'error')
      throw problem(409, '生成已中断，不能恢复旧流；请发送新的提问。')
    if (initial.message.status === 'complete') {
      if (signal.aborted) throw abortError()
      conversationModels(initial.db, initial.user, initial.request)
      initial.message.citations.forEach((citation) =>
        readableCitation(initial.db, initial.user, citation),
      )
      onEvent(copy({ type: 'citations' as const, citations: initial.message.citations }))
      if (signal.aborted) throw abortError()
      const latest = requestContext(id)
      if (latest.user.id !== initial.user.id) throw problem(401, '生成期间登录身份已改变。')
      conversationModels(latest.db, latest.user, latest.request)
      latest.message.citations.forEach((citation) =>
        readableCitation(latest.db, latest.user, citation),
      )
      onEvent({ type: 'done' })
      return
    }
    if (!task) {
      initial.message.status = 'error'
      persist(initial.db)
      throw problem(409, '生成任务已丢失，请刷新消息。')
    }
    task.running = true
    const checked = (): ReturnType<typeof requestContext> => {
      if (signal.aborted || task.controller.signal.aborted || tasks.get(id) !== task)
        throw abortError()
      const state = requestContext(id)
      if (state.user.id !== initial.user.id) throw problem(401, '生成期间登录身份已改变。')
      if (state.message.status === 'cancelled') throw abortError()
      if (state.message.status !== 'streaming') throw problem(409, '生成任务已结束。')
      conversationModels(state.db, state.user, state.request)
      task.citations.forEach((citation) => readableCitation(state.db, state.user, citation))
      return state
    }
    try {
      checked()
      while (true) {
        await wait(30, [signal, task.controller.signal])
        const state = checked()
        const offset = state.message.content.length
        if (offset >= task.text.length) break
        const delta = Array.from(task.text.slice(offset)).slice(0, 12).join('')
        state.message.content += delta
        persist(state.db)
        onEvent({ type: 'delta', text: delta })
      }
      let state = checked()
      state.message.citations = copy(task.citations)
      persist(state.db)
      onEvent(copy({ type: 'citations' as const, citations: task.citations }))
      // 回调可能取消、删除会话、切换身份或修改授权，完成事件前再次读取。
      state = checked()
      state.message.status = 'complete'
      conversation(state.db, state.user, state.request.conversationId).updatedAt = now()
      persist(state.db)
      onEvent({ type: 'done' })
    } catch (error) {
      const aborted =
        signal.aborted ||
        task.controller.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError')
      finishFailedTask(id, task, aborted ? 'cancelled' : 'error')
      if (!aborted) {
        try {
          onEvent({
            type: 'error',
            message: error instanceof Error ? error.message : '模拟生成失败。',
          })
        } catch {
          /* 保留原始异常。 */
        }
      }
      throw aborted ? abortError() : error
    } finally {
      task.running = false
      if (tasks.get(id) === task) tasks.delete(id)
    }
  },
  async cancel(id) {
    const { db, message } = requestContext(id)
    // 停止不要求模型仍可用，否则撤销授权后无法清理生成任务。
    if (message.status === 'streaming') {
      message.status = 'cancelled'
      persist(db)
    }
    const task = tasks.get(id)
    task?.controller.abort()
    if (task && !task.running) tasks.delete(id)
  },
  async citation(messageId, citationId) {
    const { db, user } = context()
    const message = requireValue(
      db.messages.find((item) => item.id === messageId),
      '消息',
    )
    // 必须先校验消息归属，再查引用及当前来源，管理员也不能绕过本人会话约束。
    conversation(db, user, message.conversationId)
    const value = requireValue(
      message.citations.find((item) => item.id === citationId),
      '引用',
    )
    readableCitation(db, user, value)
    return copy(value)
  },
}
