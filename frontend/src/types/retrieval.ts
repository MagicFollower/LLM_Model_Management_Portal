import type { Citation } from '@/types'

export type RetrievalMode = 'local' | 'demo'

export interface RetrievalHealth {
  status: 'unloaded' | 'loading' | 'ready' | 'error'
  modelId: string
  dimension: number
  device: string
  error?: string
  reranker?: {
    status: 'unloaded' | 'loading' | 'ready' | 'error'
    modelId: string
    error?: string
  }
}

export interface SearchRequest {
  query: string
  topK: number
  minScore: number
  chunks: { id: string; content: string; knowledgeBaseId?: string; documentType?: string }[]
  enableBm25?: boolean
  enableRerank?: boolean
  knowledgeBaseIds?: string[]
  documentTypes?: string[]
}

export interface SearchResponse {
  hits: { id: string; score: number; vectorScore?: number; bm25Score?: number; rerankScore?: number }[]
  modelId: string
  dimension: number
  elapsedMs: number
  totalChunks: number
  rerankerUsed?: boolean
}

export interface KnowledgeSearchResult {
  hits: Citation[]
  modelId: string
  dimension: number
  elapsedMs: number
  totalChunks: number
  excludedDocuments: number
  mode: RetrievalMode
}
