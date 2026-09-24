export interface SseFrame {
  event: string
  data: string
  id?: string
}

// 仅显式返回 false 时停止解析，兼容无返回值和数组 push 等既有回调。
export function createSseParser(onFrame: (frame: SseFrame) => unknown) {
  let stopped = false
  let buffer = ''
  let frame: SseFrame = { event: 'message', data: '' }
  let data: string[] = []
  function line(value: string) {
    if (!value) {
      if (data.length && onFrame({ ...frame, data: data.join('\n') }) === false) stopped = true
      frame = { event: 'message', data: '' }
      data = []
      return
    }
    if (value.startsWith(':')) return
    const colon = value.indexOf(':')
    const key = colon === -1 ? value : value.slice(0, colon)
    let content = colon === -1 ? '' : value.slice(colon + 1)
    if (content.startsWith(' ')) content = content.slice(1)
    if (key === 'data') data.push(content)
    if (key === 'event') frame.event = content
    if (key === 'id' && !content.includes('\0')) frame.id = content
  }
  return {
    push(chunk: string) {
      if (stopped) return
      buffer += chunk
      while (!stopped) {
        const position = buffer.search(/[\r\n]/)
        if (position === -1) break
        if (buffer[position] === '\r' && position === buffer.length - 1) break
        const length = buffer[position] === '\r' && buffer[position + 1] === '\n' ? 2 : 1
        line(buffer.slice(0, position))
        buffer = buffer.slice(position + length)
      }
      if (stopped) {
        buffer = ''
        return
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('流式事件过大，已终止接收。')
    },
    finish() {
      if (!stopped && buffer.endsWith('\r')) line(buffer.slice(0, -1))
      // 未以空行完成的事件不会在 EOF 时被当作成功响应。
      buffer = ''
    },
  }
}

// 与解析器一致，仅显式返回 false 表示正常结束读取。
export async function readSse(
  response: Response,
  onFrame: (frame: SseFrame) => unknown,
  signal: AbortSignal,
) {
  if (!response.ok) throw new Error(`流式请求失败（HTTP ${response.status}）。`)
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'text/event-stream') throw new Error('服务端没有返回 SSE 事件流。')
  if (!response.body) throw new Error('当前环境不支持流式响应。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let stopped = false
  const checkAbort = () => {
    if (signal.aborted) throw new DOMException('已停止生成', 'AbortError')
  }
  const parser = createSseParser((frame) => {
    checkAbort()
    stopped = onFrame(frame) === false
    return !stopped
  })
  const abort = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    while (true) {
      checkAbort()
      const { value, done } = await reader.read()
      checkAbort()
      if (done) break
      parser.push(decoder.decode(value, { stream: true }))
      if (stopped) return
    }
    parser.push(decoder.decode())
    parser.finish()
    if (!stopped) checkAbort()
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
