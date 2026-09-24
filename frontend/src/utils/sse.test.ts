import { describe, expect, it } from 'vitest'
import { createSseParser, readSse, type SseFrame } from './sse'
import { splitText, validateChunkConfig, validateFile } from './validation'

describe('SSE 协议解析', () => {
  it('跨块 CRLF、多行数据、心跳和 id', () => {
    const frames: SseFrame[] = []
    const parser = createSseParser((frame) => frames.push(frame))
    for (const part of [
      ': heartbeat\r',
      '\n\r\n',
      'id: 2\nevent: delta\nda',
      'ta: {"text":\r',
      '\ndata: "你好"}\r\n\r',
      '\n',
    ])
      parser.push(part)
    expect(frames).toEqual([{ event: 'delta', id: '2', data: '{"text":\n"你好"}' }])
  })
  it('没有空行的残缺事件不被分发', () => {
    const frames: SseFrame[] = []
    const parser = createSseParser((frame) => frames.push(frame))
    parser.push('event: delta\ndata: unfinished')
    parser.finish()
    expect(frames).toEqual([])
  })
  it('按单字节切开中文 UTF-8 仍完整解析', async () => {
    const bytes = new TextEncoder().encode(
      'event: delta\ndata: {"text":"中文😀"}\n\nevent: done\ndata: {}\n\n',
    )
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
          controller.close()
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
    const frames: SseFrame[] = []
    await readSse(response, (frame) => frames.push(frame), new AbortController().signal)
    expect(JSON.parse(frames[0].data).text).toBe('中文😀')
    expect(frames[1].event).toBe('done')
  })
  it('拒绝非 SSE 响应和取消后的读取', async () => {
    await expect(
      readSse(new Response('{}'), () => undefined, new AbortController().signal),
    ).rejects.toThrow('SSE')
    const controller = new AbortController()
    controller.abort()
    await expect(
      readSse(
        new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
        () => undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('切分与文件校验', () => {
  it('校验数字范围和重叠边界', () => {
    expect(() => validateChunkConfig({ chunkSize: 50, chunkOverlap: 50 })).toThrow()
    expect(() => validateChunkConfig({ chunkSize: NaN, chunkOverlap: 0 })).toThrow()
    expect(() => validateChunkConfig({ chunkSize: 500, chunkOverlap: 50 })).not.toThrow()
  })
  it('切分保持重叠且高重叠不会死循环', () => {
    const text = 'a'.repeat(111)
    expect(splitText(text, { chunkSize: 50, chunkOverlap: 10 }).map((item) => item.length)).toEqual(
      [50, 50, 31],
    )
    expect(splitText(text, { chunkSize: 50, chunkOverlap: 49 })).toHaveLength(62)
    expect(splitText('  ', { chunkSize: 50, chunkOverlap: 0 })).toEqual([])
  })
  it('优先自然语义边界并限制长度', () => {
    const text = '模型管理。'.repeat(100)
    const chunks = splitText(text, { chunkSize: 50, chunkOverlap: 5 })
    expect(chunks.every((chunk) => chunk.length <= 50)).toBe(true)
    expect(chunks[0].endsWith('。')).toBe(true)
  })
  it('只接受支持的非空文件', () => {
    expect(() => validateFile(new File(['x'], 'demo.PDF'))).not.toThrow()
    expect(() => validateFile(new File(['x'], 'demo.exe'))).toThrow()
    expect(() => validateFile(new File([], 'empty.txt'))).toThrow('空文件')
  })
})
