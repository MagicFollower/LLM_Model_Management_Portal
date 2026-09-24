export type Role = 'admin' | 'user'
export type ModelType = 'chat' | 'embedding' | 'rerank'
export interface User {
  id: string
  username: string
  name: string
  role: Role
  enabled: boolean
  modelIds: string[]
  createdAt: string
}
export interface UserInput {
  username: string
  name: string
  role: Role
  enabled: boolean
  modelIds: string[]
  password?: string
}
export interface Model {
  id: string
  name: string
  type: ModelType
  provider: string
  baseUrl: string
  modelName: string
  enabled: boolean
  description: string
  dimension?: number
  hasApiKey: boolean
  createdAt: string
}
export interface ModelInput {
  name: string
  type: ModelType
  provider: string
  baseUrl: string
  modelName: string
  enabled: boolean
  description: string
  dimension?: number
  apiKey?: string
  clearApiKey?: boolean
}
export interface ChunkConfig {
  chunkSize: number
  chunkOverlap: number
}
export interface KnowledgeBase extends ChunkConfig {
  id: string
  name: string
  description: string
  embeddingModelId: string
  rerankModelId: string
  ownerId: string
  createdAt: string
}
export interface KnowledgeInput extends ChunkConfig {
  name: string
  description: string
  embeddingModelId: string
  rerankModelId: string
}
export type DocumentStatus = 'parsing' | 'splitting' | 'embedding' | 'indexing' | 'ready' | 'failed'
export interface DocumentRecord extends ChunkConfig {
  id: string
  knowledgeBaseId: string
  name: string
  size: number
  status: DocumentStatus
  progress: number
  chunkCount: number
  version: number
  createdAt: string
  error?: string
  simulated?: boolean
}
export interface Chunk {
  id: string
  documentId: string
  index: number
  content: string
  page: number | null
  section: string
  version: number
}
export interface Citation {
  id: string
  documentId: string
  knowledgeBaseId: string
  chunkId: string
  documentName: string
  page: number | null
  section: string
  content: string
  score: number
  version: number
}
export interface Conversation {
  id: string
  title: string
  modelId: string
  knowledgeBaseIds: string[]
  ownerId: string
  createdAt: string
  updatedAt: string
}
export interface ConversationInput {
  title: string
  modelId: string
  knowledgeBaseIds: string[]
}
export interface Message {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  citations: Citation[]
  status: 'complete' | 'streaming' | 'cancelled' | 'error'
  createdAt: string
}
export interface Generation {
  generationId: string
  assistantMessageId: string
}
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'done' }
  | { type: 'error'; message: string }
export interface Session {
  user: User
  accessToken?: string
}
export interface Api {
  login(username: string, password: string): Promise<Session>
  restore(): Promise<Session | null>
  logout(): Promise<void>
  models(): Promise<Model[]>
  saveModel(input: ModelInput, id?: string): Promise<Model>
  deleteModel(id: string): Promise<void>
  testModel(id: string): Promise<{ message: string; latency: number }>
  users(): Promise<User[]>
  saveUser(input: UserInput, id?: string): Promise<User>
  deleteUser(id: string): Promise<void>
  knowledgeBases(): Promise<KnowledgeBase[]>
  saveKnowledge(input: KnowledgeInput, id?: string): Promise<KnowledgeBase>
  deleteKnowledge(id: string): Promise<void>
  documents(kbId: string): Promise<DocumentRecord[]>
  document(id: string): Promise<DocumentRecord>
  upload(kbId: string, file: File, onProgress: (value: number) => void): Promise<DocumentRecord>
  deleteDocument(id: string): Promise<void>
  chunks(id: string): Promise<Chunk[]>
  preview(id: string, config: ChunkConfig): Promise<Chunk[]>
  process(id: string, config: ChunkConfig): Promise<DocumentRecord>
  download(id: string): Promise<Blob>
  conversations(): Promise<Conversation[]>
  saveConversation(input: ConversationInput, id?: string): Promise<Conversation>
  deleteConversation(id: string): Promise<void>
  messages(id: string): Promise<Message[]>
  generate(id: string, content: string, clientRequestId: string): Promise<Generation>
  stream(id: string, onEvent: (event: StreamEvent) => void, signal: AbortSignal): Promise<void>
  cancel(id: string): Promise<void>
  citation(messageId: string, citationId: string): Promise<Citation>
}
