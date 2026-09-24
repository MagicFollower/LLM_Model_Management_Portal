import type { RetrievalHealth, RetrievalMode, SearchRequest, SearchResponse } from '@/types/retrieval'

export const RETRIEVAL_MODEL_ID = 'BAAI/bge-small-zh-v1.5'
export const RETRIEVAL_DIMENSION = 512
export const RETRIEVAL_TIMEOUT_MS = 120_000

export class RetrievalError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 0,
  ) {
    super(message)
    this.name = 'RetrievalError'
  }
}

export function getRetrievalMode(): RetrievalMode {
  const mode = import.meta.env.VITE_RETRIEVAL_MODE
  if (mode === undefined) return 'local'
  if (mode === 'local' || mode === 'demo') return mode
  throw new RetrievalError('INVALID_RETRIEVAL_MODE', 'VITE_RETRIEVAL_MODE 只能为 local 或 demo。')
}

export function retrievalAbortError(): Error {
  return Object.assign(new RetrievalError('REQUEST_CANCELLED', '已停止等待检索结果。'), {
    name: 'AbortError',
  })
}

export function assertRetrievalActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw retrievalAbortError()
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const invalidResponse = (): RetrievalError =>
  new RetrievalError('INVALID_RESPONSE', '检索服务响应不符合约定，未使用任何模拟回退。', 502)

export function validateSearchRequest(input: SearchRequest): void {
  const invalid = (): never => {
    throw new RetrievalError('VALIDATION_ERROR', '检索参数无效，请检查查询、Top-K、阈值与片段。', 422)
  }
  if (
    !object(input) ||
    !nonempty(input.query) ||
    Array.from(input.query).length > 2000 ||
    !Number.isInteger(input.topK) || input.topK < 1 || input.topK > 20 ||
    !finite(input.minScore) || input.minScore < 0 || input.minScore > 100 ||
    !Array.isArray(input.chunks)
  ) invalid()
  if (input.chunks.length > 512)
    throw new RetrievalError('CANDIDATE_LIMIT_EXCEEDED', '候选超过 512 条，请缩小知识库范围；不会截断候选。', 413)
  let total = 0
  const ids = new Set<string>()
  for (const chunk of input.chunks) {
    if (!object(chunk) || !nonempty(chunk.id) || !nonempty(chunk.content) || ids.has(chunk.id)) invalid()
    ids.add(chunk.id)
    const length = Array.from(chunk.content).length
    if (length > 4000) invalid()
    total += length
  }
  if (total > 200000)
    throw new RetrievalError('CANDIDATE_LIMIT_EXCEEDED', '候选正文超过 200000 码点，请缩小范围。', 413)
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 2 * 1024 * 1024)
    throw new RetrievalError('REQUEST_TOO_LARGE', '检索请求超过 2 MiB，请缩小范围。', 413)
}

async function request(path: 'health' | 'load' | 'search', body?: string, signal?: AbortSignal): Promise<unknown> {
  assertRetrievalActive(signal)
  if (import.meta.env.VITE_DATA_MODE === 'rest')
    throw new RetrievalError('REST_RETRIEVAL_UNAVAILABLE', 'REST 模式需要正式业务检索 API，不能调用本机无鉴权检索。')
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: () => void = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    stop = () => {
      controller.abort()
      reject(retrievalAbortError())
    }
    signal?.addEventListener('abort', stop, { once: true })
    timer = setTimeout(() => {
      controller.abort()
      reject(new RetrievalError('RETRIEVAL_TIMEOUT', '检索等待超时；后台 CPU 任务可能仍在运行，请稍后重试。', 408))
    }, RETRIEVAL_TIMEOUT_MS)
  })
  const work = async (): Promise<unknown> => {
    let response: Response
    try {
      response = await fetch(`/retrieval/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body }),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch {
      assertRetrievalActive(signal)
      throw new RetrievalError('NETWORK_ERROR', '无法连接本地检索服务，请确认服务已启动；不会自动切换 demo。')
    }
    let envelope: unknown
    try {
      envelope = await response.json()
    } catch {
      throw invalidResponse()
    }
    if (!object(envelope)) throw invalidResponse()
    if (!response.ok) {
      const error = envelope.error
      if (!object(error) || !nonempty(error.code) || !nonempty(error.message)) throw invalidResponse()
      throw new RetrievalError(error.code, error.message, response.status)
    }
    if ('error' in envelope || !('data' in envelope)) throw invalidResponse()
    return envelope.data
  }
  try {
    const result = await Promise.race([interrupted, work()])
    assertRetrievalActive(signal)
    return result
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
}

function health(value: unknown): RetrievalHealth {
  if (
    !object(value) || !['unloaded', 'loading', 'ready', 'error'].includes(value.status as string) ||
    value.modelId !== RETRIEVAL_MODEL_ID || value.dimension !== RETRIEVAL_DIMENSION ||
    value.device !== 'cpu' || (value.error !== undefined && value.error !== null && typeof value.error !== 'string')
  ) throw invalidResponse()
  const hasError = value.error !== undefined && value.error !== null
  // 解析可选的 reranker 字段
  let reranker: RetrievalHealth['reranker']
  if (value.reranker !== undefined && value.reranker !== null && object(value.reranker)) {
    const r = value.reranker
    if (
      ['unloaded', 'loading', 'ready', 'error'].includes(r.status as string) &&
      typeof r.modelId === 'string'
    ) {
      reranker = {
        status: r.status as RetrievalHealth['reranker'] extends undefined ? never : NonNullable<RetrievalHealth['reranker']>['status'],
        modelId: r.modelId,
        ...(r.error !== undefined && r.error !== null && typeof r.error === 'string' ? { error: r.error } : {}),
      }
    }
  }
  return {
    status: value.status as RetrievalHealth['status'],
    modelId: value.modelId,
    dimension: value.dimension,
    device: value.device,
    ...(hasError ? { error: value.error as string } : {}),
    ...(reranker !== undefined ? { reranker } : {}),
  }
}

export async function retrievalHealth(signal?: AbortSignal): Promise<RetrievalHealth> {
  return health(await request('health', undefined, signal))
}

export async function loadRetrievalModel(signal?: AbortSignal): Promise<RetrievalHealth> {
  return health(await request('load', '{}', signal))
}

export async function searchVectors(input: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
  assertRetrievalActive(signal)
  validateSearchRequest(input)
  // 在任何等待前复制请求，调用方之后修改对象不能改变响应校验依据。
  const snapshot: SearchRequest = {
    query: input.query,
    topK: input.topK,
    minScore: input.minScore,
    chunks: input.chunks.map((c) => ({
      id: c.id,
      content: c.content,
      ...(c.knowledgeBaseId !== undefined ? { knowledgeBaseId: c.knowledgeBaseId } : {}),
      ...(c.documentType !== undefined ? { documentType: c.documentType } : {}),
    })),
    ...(input.enableBm25 !== undefined ? { enableBm25: input.enableBm25 } : {}),
    ...(input.enableRerank !== undefined ? { enableRerank: input.enableRerank } : {}),
    ...(input.knowledgeBaseIds !== undefined ? { knowledgeBaseIds: input.knowledgeBaseIds } : {}),
    ...(input.documentTypes !== undefined ? { documentTypes: input.documentTypes } : {}),
  }
  const value = await request('search', JSON.stringify(snapshot), signal)
  if (
    !object(value) || value.modelId !== RETRIEVAL_MODEL_ID || value.dimension !== RETRIEVAL_DIMENSION ||
    !finite(value.elapsedMs) || value.elapsedMs < 0 || value.totalChunks !== snapshot.chunks.length ||
    !Array.isArray(value.hits) || value.hits.length > snapshot.topK
  ) throw invalidResponse()
  const order = new Map(snapshot.chunks.map((chunk, index) => [chunk.id, index]))
  const seen = new Set<string>()
  let previousScore = Infinity
  let previousIndex = -1
  const hits = value.hits.map((hit: unknown) => {
    // 使用 epsilon 容差确保边界值被包含（处理浮点精度问题）
    const epsilon = 1e-9
    if (
      !object(hit) || !nonempty(hit.id) || !order.has(hit.id) || seen.has(hit.id) ||
      !finite(hit.score) || hit.score < 0 || hit.score > 100 || hit.score < snapshot.minScore - epsilon ||
      hit.score > previousScore || (hit.score === previousScore && order.get(hit.id)! < previousIndex)
    ) throw invalidResponse()
    // 校验可选分数字段（存在时必须为 number）
    if (hit.vectorScore !== undefined && hit.vectorScore !== null && !finite(hit.vectorScore)) throw invalidResponse()
    if (hit.bm25Score !== undefined && hit.bm25Score !== null && !finite(hit.bm25Score)) throw invalidResponse()
    if (hit.rerankScore !== undefined && hit.rerankScore !== null && !finite(hit.rerankScore)) throw invalidResponse()
    seen.add(hit.id)
    previousScore = hit.score
    previousIndex = order.get(hit.id)!
    return {
      id: hit.id,
      score: hit.score,
      ...(hit.vectorScore !== undefined && hit.vectorScore !== null ? { vectorScore: hit.vectorScore } : {}),
      ...(hit.bm25Score !== undefined && hit.bm25Score !== null ? { bm25Score: hit.bm25Score } : {}),
      ...(hit.rerankScore !== undefined && hit.rerankScore !== null ? { rerankScore: hit.rerankScore } : {}),
    }
  })
  // 解析可选的 rerankerUsed
  let rerankerUsed: boolean | undefined
  if (value.rerankerUsed !== undefined && value.rerankerUsed !== null) {
    if (typeof value.rerankerUsed !== 'boolean') throw invalidResponse()
    rerankerUsed = value.rerankerUsed
  }
  return {
    hits,
    modelId: value.modelId,
    dimension: value.dimension,
    elapsedMs: value.elapsedMs,
    totalChunks: snapshot.chunks.length,
    ...(rerankerUsed !== undefined ? { rerankerUsed } : {}),
  }
}
