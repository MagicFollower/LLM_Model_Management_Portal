import type { Chunk, Citation } from '@/types'
import type { KnowledgeSearchResult, RetrievalMode } from '@/types/retrieval'
import { getRetrievalMode, searchVectors, validateSearchRequest } from '@/api/retrieval'

export interface RetrievalDocument {
  record: {
    id: string
    knowledgeBaseId: string
    name: string
    status: string
    version: number
    chunkCount: number
    chunkSize: number
    chunkOverlap: number
    simulated?: boolean
  }
  text: string
  chunks: Chunk[]
}

interface ReadResult {
  userId: string
  knowledgeBases: { id: string; ownerId: string; chunkSize: number; chunkOverlap: number; embeddingModelId: string; rerankModelId?: string }[]
  documents: RetrievalDocument[]
  users: { id: string; role: string; enabled: boolean; modelIds: string[] }[]
  models: { id: string; enabled: boolean; type: string }[]
  demoCitations?: Citation[]
}

interface Dependencies {
  read: (selected: string[], prepare: boolean, mode: RetrievalMode) => ReadResult
  citationId: () => string
}

function isTextBased(name: string): boolean {
  return /\.(md|txt)$/i.test(name)
}

function inferDocumentType(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['md', 'txt', 'pdf', 'doc', 'docx'].includes(ext)) return ext
  return 'txt'
}

interface EligibleChunk {
  id: string
  content: string
  documentId: string
  knowledgeBaseId: string
  documentType: string
  documentName: string
  index: number
  section: string
  page: number | null
  version: number
}

function collectEligible(documents: RetrievalDocument[]): { chunks: EligibleChunk[]; excluded: number } {
  const chunks: EligibleChunk[] = []
  let excluded = 0
  for (const doc of documents) {
    if (doc.record.status !== 'ready' || !doc.text.trim()) continue
    if (!isTextBased(doc.record.name)) {
      excluded++
      continue
    }
    for (const chunk of doc.chunks) {
      if (!chunk.content.trim()) continue
      if (chunk.id.includes('-preview-')) continue
      chunks.push({
        id: chunk.id,
        content: chunk.content,
        documentId: doc.record.id,
        knowledgeBaseId: doc.record.knowledgeBaseId,
        documentType: inferDocumentType(doc.record.name),
        documentName: doc.record.name,
        index: chunk.index,
        section: chunk.section,
        page: chunk.page,
        version: chunk.version,
      })
    }
  }
  return { chunks, excluded }
}

function retrievalError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code })
}

function validateSnapshot(
  snapshot: ReadResult,
  current: ReadResult,
  selected: string[],
): void {
  if (current.userId !== snapshot.userId)
    throw retrievalError(401, 'IDENTITY_CHANGED', '检索期间登录身份已改变。')

  const snapshotKbMap = new Map(snapshot.knowledgeBases.map((kb) => [kb.id, kb]))
  for (const kbId of selected) {
    const snapshotKb = snapshotKbMap.get(kbId)
    if (!snapshotKb) throw retrievalError(404, 'SOURCE_DELETED', '检索期间来源知识库已删除。')
    const currentKb = current.knowledgeBases.find((kb) => kb.id === kbId)
    if (!currentKb) throw retrievalError(404, 'SOURCE_DELETED', '检索期间来源知识库已删除。')
    if (currentKb.ownerId !== snapshotKb.ownerId)
      throw retrievalError(403, 'OWNERSHIP_CHANGED', '检索期间知识库所有权已变更。')
    const currentUser = current.users.find((u) => u.id === current.userId)
    if (!currentUser) throw retrievalError(401, 'IDENTITY_CHANGED', '检索期间用户已不存在。')
    if (!currentUser.enabled) throw retrievalError(401, 'USER_DISABLED', '检索期间账号已停用。')
    if (currentUser.role !== 'admin' && currentKb.ownerId !== currentUser.id)
      throw retrievalError(403, 'ACCESS_REVOKED', '检索期间知识库访问权已撤销。')
    if (
      currentKb.chunkSize !== snapshotKb.chunkSize ||
      currentKb.chunkOverlap !== snapshotKb.chunkOverlap
    )
      throw retrievalError(409, 'CONFIG_CHANGED', '检索期间知识库配置已变化。')
    const snapshotEmbed = snapshotKb.embeddingModelId
    const currentEmbed = currentKb.embeddingModelId
    if (currentEmbed !== snapshotEmbed)
      throw retrievalError(409, 'CONFIG_CHANGED', '检索期间 Embedding 模型已变化。')
    const snapshotModel = snapshot.models.find((m) => m.id === snapshotEmbed)
    const currentModel = current.models.find((m) => m.id === currentEmbed)
    if (snapshotModel?.enabled && !currentModel?.enabled)
      throw retrievalError(409, 'MODEL_DISABLED', '检索期间 Embedding 模型已停用。')
    if (currentUser.role !== 'admin' && !currentUser.modelIds.includes(snapshotEmbed))
      throw retrievalError(403, 'MODEL_AUTH_REVOKED', '检索期间 Embedding 模型授权已撤销。')
  }

  const snapshotDocMap = new Map(snapshot.documents.map((doc) => [doc.record.id, doc]))
  for (const [docId, snapshotDoc] of snapshotDocMap) {
    const currentDoc = current.documents.find((d) => d.record.id === docId)
    if (!currentDoc) throw retrievalError(404, 'SOURCE_DELETED', '检索期间来源文档已删除。')
    if (snapshotDoc.record.status === 'ready' && currentDoc.record.status !== 'ready')
      throw retrievalError(409, 'SOURCE_CHANGED', '检索期间来源文档状态已变化。')
    if (currentDoc.record.version !== snapshotDoc.record.version)
      throw retrievalError(409, 'SOURCE_CHANGED', '检索期间来源文档已更新。')
    if (currentDoc.text !== snapshotDoc.text)
      throw retrievalError(409, 'SOURCE_CHANGED', '检索期间文档正文已变化。')
    const snapshotChunkMap = new Map(snapshotDoc.chunks.map((c) => [c.id, c]))
    for (const [chunkId, snapshotChunk] of snapshotChunkMap) {
      const currentChunk = currentDoc.chunks.find((c) => c.id === chunkId)
      if (!currentChunk) throw retrievalError(409, 'SOURCE_CHANGED', '检索期间片段已失效。')
      if (currentChunk.version !== snapshotChunk.version)
        throw retrievalError(409, 'SOURCE_CHANGED', '检索期间片段版本已变化。')
      if (currentChunk.content !== snapshotChunk.content)
        throw retrievalError(409, 'SOURCE_CHANGED', '检索期间片段正文已变化。')
    }
  }
}

export function createKnowledgeRetrieval(deps: Dependencies) {
  function hitsToCitations(
    hits: { id: string; score: number }[],
    chunkMap: Map<string, EligibleChunk>,
  ): Citation[] {
    return hits
      .map((hit) => {
        const chunk = chunkMap.get(hit.id)
        if (!chunk) return null
        return {
          id: deps.citationId(),
          documentId: chunk.documentId,
          knowledgeBaseId: chunk.knowledgeBaseId,
          chunkId: chunk.id,
          documentName: chunk.documentName,
          page: chunk.page,
          section: chunk.section,
          content: chunk.content,
          score: hit.score,
          version: chunk.version,
        } satisfies Citation
      })
      .filter((item): item is Citation => item !== null)
  }

  function demoResult(data: ReadResult): KnowledgeSearchResult {
    return {
      hits: data.demoCitations ?? [],
      modelId: 'demo-fixed-citations',
      dimension: 0,
      elapsedMs: 0,
      totalChunks: 0,
      excludedDocuments: 0,
      mode: 'demo',
    }
  }

  return {
    async search(
      selected: string[],
      query: string,
      options: { topK: number; minScore: number; enableBm25?: boolean; enableRerank?: boolean },
      signal?: AbortSignal,
    ): Promise<KnowledgeSearchResult> {
      if (import.meta.env.VITE_DATA_MODE === 'rest')
        throw Object.assign(new Error('REST 模式需要正式业务检索 API，不能调用本机无鉴权检索。'), {
          code: 'REST_RETRIEVAL_UNAVAILABLE',
        })
      const mode: RetrievalMode = getRetrievalMode()
      const data = deps.read(selected, true, mode)
      if (mode === 'demo') return demoResult(data)

      const { chunks, excluded } = collectEligible(data.documents)
      if (!chunks.length) {
        return {
          hits: [],
          modelId: 'BAAI/bge-small-zh-v1.5',
          dimension: 512,
          elapsedMs: 0,
          totalChunks: 0,
          excludedDocuments: excluded,
          mode: 'local',
        }
      }

      const request = {
        query,
        topK: options.topK,
        minScore: options.minScore,
        enableBm25: options.enableBm25 ?? false,
        enableRerank: options.enableRerank ?? false,
        chunks,
      }
      validateSearchRequest(request)
      const response = await searchVectors(request, signal)

      const current = deps.read(selected, false, mode)
      validateSnapshot(data, current, selected)

      const elapsed = 0
      const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]))
      return {
        hits: hitsToCitations(response.hits, chunkMap),
        modelId: response.modelId,
        dimension: response.dimension,
        elapsedMs: elapsed,
        totalChunks: response.totalChunks,
        excludedDocuments: excluded,
        mode: 'local',
      }
    },

    prepare(
      selected: string[],
      query: string,
      options: { topK: number; minScore: number; enableBm25?: boolean; enableRerank?: boolean },
      mode: RetrievalMode,
    ) {
      const data = deps.read(selected, true, mode)
      if (mode === 'demo') {
        return {
          validate: (): void => undefined,
          run: async (): Promise<KnowledgeSearchResult> => demoResult(data),
        }
      }

      const { chunks, excluded } = collectEligible(data.documents)

      const validate = (validateSignal?: AbortSignal): void => {
        if (validateSignal?.aborted)
          throw Object.assign(new Error('已中止。'), { name: 'AbortError' })
        const current = deps.read(selected, false, mode)
        validateSnapshot(data, current, selected)
      }

      return {
        validate,
        run: async (runSignal?: AbortSignal): Promise<KnowledgeSearchResult> => {
          if (!chunks.length) {
            return {
              hits: [],
              modelId: 'BAAI/bge-small-zh-v1.5',
              dimension: 512,
              elapsedMs: 0,
              totalChunks: 0,
              excludedDocuments: excluded,
              mode: 'local',
            }
          }
          const request = {
            query,
            topK: options.topK,
            minScore: options.minScore,
            enableBm25: options.enableBm25 ?? false,
            enableRerank: options.enableRerank ?? false,
            chunks,
          }
          validateSearchRequest(request)
          const response = await searchVectors(request, runSignal)
          validate(runSignal)
          const chunkMap = new Map(chunks.map((chunk) => [chunk.id, chunk]))
          return {
            hits: hitsToCitations(response.hits, chunkMap),
            modelId: response.modelId,
            dimension: response.dimension,
            elapsedMs: 0,
            totalChunks: response.totalChunks,
            excludedDocuments: excluded,
            mode: 'local',
          }
        },
      }
    },
  }
}
