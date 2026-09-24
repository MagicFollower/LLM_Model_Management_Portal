import axios, { type AxiosRequestConfig } from 'axios'
import type { Api, Session } from '@/types'
import { readSse } from '@/utils/sse'
import { validateChunkConfig, validateFile } from '@/utils/validation'

const baseURL = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/$/, '')
if (!baseURL.startsWith('/') || baseURL.startsWith('//'))
  throw new Error('API 地址必须为同源路径。')
const http = axios.create({ baseURL, timeout: 30000, withCredentials: true })
let accessToken = ''
let refreshing: Promise<Session | null> | null = null
let epoch = 0

function authLost() {
  accessToken = ''
  window.dispatchEvent(new Event('session-expired'))
}
function formatError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.error?.message
    if (typeof message === 'string') return new Error(message)
    if (!error.response) return new Error('无法连接业务后端，请检查服务地址或网络。')
    return new Error(`请求失败（HTTP ${error.response.status}），请重试或联系管理员。`)
  }
  return error instanceof Error ? error : new Error('请求失败。')
}
async function refresh(): Promise<Session | null> {
  if (refreshing) return refreshing
  const current = epoch
  refreshing = (async () => {
    try {
      const result = await http.post<{ data: Session }>('/auth/refresh')
      if (current !== epoch) return null
      accessToken = result.data.data.accessToken || ''
      if (!accessToken) throw new Error('后端未返回访问令牌。')
      window.dispatchEvent(new CustomEvent('session-refreshed', { detail: result.data.data.user }))
      return result.data.data
    } catch (error) {
      if (current === epoch) accessToken = ''
      if (axios.isAxiosError(error) && [401, 403].includes(error.response?.status || 0)) return null
      throw formatError(error)
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}
async function refreshAfterUnauthorized(): Promise<Session | null> {
  try {
    const session = await refresh()
    if (!session) authLost()
    return session
  } catch (error) {
    authLost()
    throw error
  }
}
async function request<T>(config: AxiosRequestConfig, retry = true): Promise<T> {
  try {
    const result = await http.request<{ data: T }>({
      ...config,
      headers: {
        ...config.headers,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
    })
    return result.status === 204 ? (undefined as T) : result.data.data
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 401 && retry) {
      if (await refreshAfterUnauthorized()) return request<T>(config, false)
    } else if (axios.isAxiosError(error) && error.response?.status === 401) authLost()
    throw formatError(error)
  }
}
const key = encodeURIComponent
export const restApi: Api = {
  async login(username, password) {
    epoch++
    accessToken = ''
    try {
      const result = await http.post<{ data: Session }>('/auth/login', { username, password })
      const session = result.data.data
      if (!session.accessToken) throw new Error('后端未返回访问令牌。')
      accessToken = session.accessToken
      return session
    } catch (error) {
      throw formatError(error)
    }
  },
  restore: refresh,
  async logout() {
    try {
      await request({ method: 'POST', url: '/auth/logout' }, false)
    } finally {
      epoch++
      accessToken = ''
      authLost()
    }
  },
  models: () => request({ url: '/models' }),
  saveModel: (data, id) =>
    request({ method: id ? 'PATCH' : 'POST', url: id ? `/models/${key(id)}` : '/models', data }),
  deleteModel: (id) => request({ method: 'DELETE', url: `/models/${key(id)}` }),
  testModel: (id) => request({ method: 'POST', url: `/models/${key(id)}/test-connection` }),
  users: () => request({ url: '/users' }),
  saveUser: (data, id) =>
    request({ method: id ? 'PATCH' : 'POST', url: id ? `/users/${key(id)}` : '/users', data }),
  deleteUser: (id) => request({ method: 'DELETE', url: `/users/${key(id)}` }),
  knowledgeBases: () => request({ url: '/knowledge-bases' }),
  saveKnowledge(data, id) {
    validateChunkConfig(data)
    return request({
      method: id ? 'PATCH' : 'POST',
      url: id ? `/knowledge-bases/${key(id)}` : '/knowledge-bases',
      data,
    })
  },
  deleteKnowledge: (id) => request({ method: 'DELETE', url: `/knowledge-bases/${key(id)}` }),
  documents: (id) => request({ url: `/knowledge-bases/${key(id)}/documents` }),
  document: (id) => request({ url: `/documents/${key(id)}` }),
  upload(id, file, onProgress) {
    validateFile(file)
    const form = new FormData()
    form.append('file', file)
    return request({
      method: 'POST',
      url: `/knowledge-bases/${key(id)}/documents`,
      data: form,
      timeout: 120000,
      onUploadProgress: (event) => {
        if (event.total) onProgress(Math.round((event.loaded * 100) / event.total))
      },
    })
  },
  deleteDocument: (id) => request({ method: 'DELETE', url: `/documents/${key(id)}` }),
  chunks: (id) => request({ url: `/documents/${key(id)}/chunks` }),
  preview(id, data) {
    validateChunkConfig(data)
    return request({ method: 'POST', url: `/documents/${key(id)}/chunk-preview`, data })
  },
  process(id, data) {
    validateChunkConfig(data)
    return request({ method: 'POST', url: `/documents/${key(id)}/process`, data })
  },
  async download(id) {
    // Blob 接口不能使用 JSON envelope，401 仍需统一处理。
    const get = () =>
      http.get(`/documents/${key(id)}/download`, {
        responseType: 'blob',
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    try {
      return (await get()).data
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        if (await refreshAfterUnauthorized()) {
          try {
            return (await get()).data
          } catch (retryError) {
            if (axios.isAxiosError(retryError) && retryError.response?.status === 401) authLost()
            throw formatError(retryError)
          }
        }
      }
      throw formatError(error)
    }
  },
  conversations: () => request({ url: '/conversations' }),
  saveConversation: (data, id) =>
    request({
      method: id ? 'PATCH' : 'POST',
      url: id ? `/conversations/${key(id)}` : '/conversations',
      data,
    }),
  deleteConversation: (id) => request({ method: 'DELETE', url: `/conversations/${key(id)}` }),
  messages: (id) => request({ url: `/conversations/${key(id)}/messages` }),
  generate: (id, content, clientRequestId) =>
    request({
      method: 'POST',
      url: `/conversations/${key(id)}/messages`,
      data: { content, clientRequestId },
    }),
  async stream(id, onEvent, signal) {
    let complete = false
    const seen = new Set<string>()
    const connect = () =>
      fetch(`${baseURL}/generations/${key(id)}/events`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'text/event-stream' },
        credentials: 'same-origin',
        signal,
      })
    let response = await connect()
    if (response.status === 401) {
      await response.body?.cancel()
      if (await refreshAfterUnauthorized()) response = await connect()
      else throw new Error('登录已过期，请重新登录。')
    }
    if (response.status === 401) {
      await response.body?.cancel()
      authLost()
    }
    await readSse(
      response,
      (frame) => {
        if (complete || (frame.id && seen.has(frame.id))) return
        if (frame.id) seen.add(frame.id)
        if (frame.event === 'meta') return
        let data: Record<string, unknown>
        try {
          data = JSON.parse(frame.data)
        } catch {
          throw new Error('服务端流式事件格式不正确。')
        }
        if (frame.event === 'delta' && typeof data.text === 'string')
          onEvent({ type: 'delta', text: data.text })
        else if (frame.event === 'citations' && Array.isArray(data.citations))
          onEvent({ type: 'citations', citations: data.citations })
        else if (frame.event === 'done') {
          complete = true
          onEvent({ type: 'done' })
          return false
        } else if (frame.event === 'error')
          throw new Error(typeof data.message === 'string' ? data.message : '模型生成失败。')
      },
      signal,
    )
    if (!complete) throw new Error('连接提前中断，已保留收到的内容；请重新加载会话查看最终状态。')
  },
  cancel: (id) => request({ method: 'POST', url: `/generations/${key(id)}/cancel` }),
  citation: (messageId, id) => request({ url: `/messages/${key(messageId)}/citations/${key(id)}` }),
}
