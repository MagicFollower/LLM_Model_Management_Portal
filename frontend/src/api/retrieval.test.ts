// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { SearchRequest } from '@/types/retrieval'
import {
  getRetrievalMode, retrievalHealth, loadRetrievalModel, searchVectors,
  RETRIEVAL_MODEL_ID, RETRIEVAL_TIMEOUT_MS,
} from './retrieval'

const input = (): SearchRequest => ({
  query: '差旅报销材料', topK: 5, minScore: 0.3,
  chunks: [{ id: 'c1', content: '会议室预约' }, { id: 'c2', content: '差旅发票及审批记录' }],
})
const result = () => ({
  hits: [{ id: 'c2', score: 0.7312 }], modelId: RETRIEVAL_MODEL_ID,
  dimension: 512, elapsedMs: 12.5, totalChunks: 2,
})
const health = () => ({ status: 'unloaded', modelId: RETRIEVAL_MODEL_ID, dimension: 512, device: 'cpu' })
const response = (data: unknown, status = 200) => new Response(JSON.stringify({ data }), { status })
let fetchSpy: MockInstance<typeof fetch>
beforeEach(() => {
  vi.stubEnv('VITE_RETRIEVAL_MODE', 'local')
  vi.stubEnv('VITE_DATA_MODE', 'mock')
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('测试禁止联网'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('独立检索 HTTP 契约', () => {
  it('每次读取模式，未配置默认 local，空值和未知值均报错', () => {
    vi.stubEnv('VITE_RETRIEVAL_MODE', undefined)
    expect(getRetrievalMode()).toBe('local')
    vi.stubEnv('VITE_RETRIEVAL_MODE', 'demo')
    expect(getRetrievalMode()).toBe('demo')
    vi.stubEnv('VITE_RETRIEVAL_MODE', 'local')
    expect(getRetrievalMode()).toBe('local')
    for (const value of ['', 'LOCAL', 'invalid']) {
      vi.stubEnv('VITE_RETRIEVAL_MODE', value)
      expect(getRetrievalMode).toThrow('只能为 local 或 demo')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('固定同源 health/load，不带业务令牌且接受 202', async () => {
    fetchSpy.mockResolvedValueOnce(response(health()))
    await expect(retrievalHealth()).resolves.toEqual(health())
    fetchSpy.mockResolvedValueOnce(response({ ...health(), status: 'loading' }, 202))
    await expect(loadRetrievalModel()).resolves.toMatchObject({ status: 'loading' })
    expect(fetchSpy.mock.calls[0]).toEqual(['/retrieval/health', expect.objectContaining({ method: 'GET', credentials: 'omit', redirect: 'error' })])
    expect(fetchSpy.mock.calls[1]).toEqual(['/retrieval/load', expect.objectContaining({ method: 'POST', body: '{}', credentials: 'omit' })])
    expect(fetchSpy.mock.calls[1]![1]!.headers).not.toHaveProperty('Authorization')
  })
  it('发送全部候选，保留真实排序分数，只返回 ID 不采信服务端正文', async () => {
    fetchSpy.mockResolvedValue(response({ ...result(), hits: [{ id: 'c2', score: 0.7312, content: '伪造正文' }] }))
    await expect(searchVectors(input())).resolves.toEqual(result())
    expect(fetchSpy.mock.calls[0]![0]).toBe('/retrieval/search')
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toEqual(input())
  })
  it('请求对象等待期间被修改不改变原始校验快照', async () => {
    let resolve!: (value: Response) => void
    fetchSpy.mockImplementation(() => new Promise((done) => { resolve = done }))
    const value = input()
    const work = searchVectors(value)
    value.chunks.length = 0
    value.topK = 1
    resolve(response(result()))
    await expect(work).resolves.toEqual(result())
  })
  it.each([
    { query: '' }, { query: '字'.repeat(2001) }, { topK: 0 }, { topK: 21 }, { topK: 1.5 },
    { minScore: NaN }, { minScore: Infinity }, { minScore: -1.01 }, { minScore: 1.01 },
    { chunks: [{ id: '', content: '内容' }] }, { chunks: [{ id: 'c', content: ' ' }] },
    { chunks: [{ id: 'c', content: '字'.repeat(4001) }] },
    { chunks: [{ id: 'c', content: '一' }, { id: 'c', content: '二' }] },
  ])('发送前拒绝非法参数 %#', async (change) => {
    await expect(searchVectors({ ...input(), ...change })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('按码点接受 emoji 边界且空候选合法', async () => {
    fetchSpy.mockResolvedValue(response({ ...result(), hits: [], totalChunks: 0 }))
    await expect(searchVectors({ ...input(), query: '😀'.repeat(2000), chunks: [] })).resolves.toMatchObject({ hits: [], totalChunks: 0 })
    fetchSpy.mockResolvedValue(response({ ...result(), hits: [], totalChunks: 1 }))
    await expect(searchVectors({ ...input(), chunks: [{ id: 'c', content: '😀'.repeat(4000) }] })).resolves.toMatchObject({ totalChunks: 1 })
  })
  it.each([
    Array.from({ length: 513 }, (_, i) => ({ id: `${i}`, content: '正文' })),
    Array.from({ length: 51 }, (_, i) => ({ id: `${i}`, content: '字'.repeat(4000) })),
  ])('候选数量或总正文超限拒绝而非截断 %#', async (...chunks) => {
    await expect(searchVectors({ ...input(), chunks })).rejects.toMatchObject({ code: 'CANDIDATE_LIMIT_EXCEEDED' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('检查实际 UTF-8 请求体（包括 ID）上限', async () => {
    await expect(searchVectors({ ...input(), chunks: [{ id: '字'.repeat(700000), content: '正文' }] })).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it.each([
    { hits: [{ id: 'unknown', score: 0.8 }] },
    { hits: [{ id: 'c2', score: 0.8 }, { id: 'c2', score: 0.7 }] },
    { hits: [{ id: 'c2', score: 1.01 }] }, { hits: [{ id: 'c2', score: -1.01 }] },
    { hits: [{ id: 'c2', score: NaN }] }, { hits: [{ id: 'c2', score: '0.8' }] },
    { hits: [{ id: 'c2', score: 0.2 }] },
    { hits: [{ id: 'c1', score: 0.6 }, { id: 'c2', score: 0.7 }] },
    { hits: [{ id: 'c2', score: 0.7 }, { id: 'c1', score: 0.7 }] },
    { modelId: 'other' }, { dimension: 384 }, { elapsedMs: -1 }, { totalChunks: 1 },
  ])('拒绝非法响应而非部分成功 %#', async (change) => {
    fetchSpy.mockResolvedValue(response({ ...result(), ...change }))
    await expect(searchVectors(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
  it('命中不得超过 topK', async () => {
    fetchSpy.mockResolvedValue(response({ ...result(), hits: [{ id: 'c1', score: 0.8 }, { id: 'c2', score: 0.7 }] }))
    await expect(searchVectors({ ...input(), topK: 1 })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each([{}, { status: 'searching' }, { dimension: 384 }, { device: 'cuda' }, { error: {} }])('health 校验字段 %#', async (value) => {
    fetchSpy.mockResolvedValue(response(Object.keys(value).length ? { ...health(), ...value } : value))
    await expect(retrievalHealth()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it.each([429, 503, 500])('保留服务错误 %i，不重试、不回退', async (status) => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'SERVICE_FAILURE', message: '服务失败' } }), { status }))
    await expect(searchVectors(input())).rejects.toMatchObject({ status, code: 'SERVICE_FAILURE', message: '服务失败' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
  it('网络错误和非法 JSON 分别报告', async () => {
    await expect(searchVectors(input())).rejects.toMatchObject({ code: 'NETWORK_ERROR' })
    fetchSpy.mockResolvedValue(new Response('非法 JSON'))
    await expect(searchVectors(input())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('REST 调用不访问本地服务', async () => {
    vi.stubEnv('VITE_DATA_MODE', 'rest')
    await expect(retrievalHealth()).rejects.toMatchObject({ code: 'REST_RETRIEVAL_UNAVAILABLE' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('预先取消不发送 HTTP', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(searchVectors(input(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
  it('等待中取消立即结束，即使 fake HTTP 忽略 abort，迟到成功也被丢弃', async () => {
    let resolve!: (value: Response) => void
    fetchSpy.mockImplementation(() => new Promise((done) => { resolve = done }))
    const controller = new AbortController()
    const work = searchVectors(input(), controller.signal)
    controller.abort()
    await expect(work).rejects.toMatchObject({ name: 'AbortError', code: 'REQUEST_CANCELLED' })
    expect(fetchSpy.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    resolve(response(result()))
  })
  it('超时与用户取消区分，清理定时器并中止传输', async () => {
    vi.useFakeTimers()
    fetchSpy.mockImplementation(() => new Promise(() => {}))
    const outcome = searchVectors(input()).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(RETRIEVAL_TIMEOUT_MS)
    expect(await outcome).toMatchObject({ code: 'RETRIEVAL_TIMEOUT', status: 408 })
    expect(fetchSpy.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
