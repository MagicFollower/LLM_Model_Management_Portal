import type { ChunkConfig } from '@/types'

export function validateChunkConfig(config: ChunkConfig): void {
  if (!Number.isInteger(config.chunkSize) || config.chunkSize < 50 || config.chunkSize > 4000) {
    throw new Error('切分大小必须为 50–4000 之间的整数（字符）。')
  }
  if (
    !Number.isInteger(config.chunkOverlap) ||
    config.chunkOverlap < 0 ||
    config.chunkOverlap >= config.chunkSize
  ) {
    throw new Error('重叠字符数必须为非负整数，且小于切分大小。')
  }
}

export function validateFile(file: File): void {
  if (!/\.(pdf|docx|md|txt)$/i.test(file.name))
    throw new Error('仅支持 PDF、DOCX、Markdown 和 TXT 文件。')
  if (file.size > 20 * 1024 * 1024) throw new Error('单个文件不能超过 20 MiB。')
  if (!file.size) throw new Error('不能上传空文件。')
}

export function splitText(text: string, config: ChunkConfig): string[] {
  validateChunkConfig(config)
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []
  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + config.chunkSize, normalized.length)
    if (end < normalized.length) {
      const section = normalized.slice(start, end)
      for (const separator of ['\n\n', '\n', '。', '；', ' ']) {
        const boundary = section.lastIndexOf(separator)
        if (boundary > Math.max(config.chunkSize / 2, config.chunkOverlap)) {
          end = start + boundary + separator.length
          break
        }
      }
    }
    chunks.push(normalized.slice(start, end))
    if (end >= normalized.length) break
    start = Math.max(start + 1, end - config.chunkOverlap)
  }
  return chunks
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试。'
}
