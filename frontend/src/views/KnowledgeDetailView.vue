<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import ProgressBar from 'primevue/progressbar'
import ProgressSpinner from 'primevue/progressspinner'
import Paginator from 'primevue/paginator'
import { api, isMock } from '@/api'
import KnowledgeRetrievalPanel from '@/components/KnowledgeRetrievalPanel.vue'
import { useAuthStore } from '@/stores/auth'
import type { Chunk, ChunkConfig, DocumentRecord, DocumentStatus, KnowledgeBase } from '@/types'

type UploadItem = {
  id: number
  file: File
  state: 'queued' | 'uploading' | 'uploaded' | 'failed'
  progress: number
  error: string
}
type DraftConfig = { chunkSize: number | null; chunkOverlap: number | null }
type Severity = 'info' | 'secondary' | 'success' | 'danger' | 'warn'
const stages: { value: DocumentStatus; label: string }[] = [
  { value: 'parsing', label: '解析' },
  { value: 'splitting', label: '切分' },
  { value: 'embedding', label: '向量化' },
  { value: 'indexing', label: '入库' },
  { value: 'ready', label: '就绪' },
]
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : '请求失败，请稍后重试。'
const checkedConfig = (draft: DraftConfig): ChunkConfig => {
  const { chunkSize, chunkOverlap } = draft
  if (chunkSize === null || !Number.isInteger(chunkSize) || chunkSize < 50 || chunkSize > 4000)
    throw new Error('切分长度必须为 50～4000 的整数。')
  if (
    chunkOverlap === null ||
    !Number.isInteger(chunkOverlap) ||
    chunkOverlap < 0 ||
    chunkOverlap >= chunkSize
  )
    throw new Error('重叠长度必须为非负整数，且小于切分长度。')
  return { chunkSize, chunkOverlap }
}
const checkFile = (file: File): void => {
  if (!/\.(pdf|docx|md|txt)$/i.test(file.name)) throw new Error('仅支持 PDF、DOCX、MD、TXT 文件。')
  if (file.size > 20 * 1024 * 1024) throw new Error('文件超过单文件 20 MiB 限制。')
  if (!file.size) throw new Error('不能上传空文件。')
}

export default defineComponent({
  name: 'KnowledgeDetailView',
  components: {
    Button,
    Dialog,
    InputText,
    InputNumber,
    Select,
    Tag,
    ProgressBar,
    ProgressSpinner,
    Paginator,
    KnowledgeRetrievalPanel,
  },
  data() {
    return {
      auth: useAuthStore(),
      isMock,
      stages,
      kb: null as KnowledgeBase | null,
      documents: [] as DocumentRecord[],
      loading: false,
      pageError: '',
      documentsLoading: false,
      documentsError: '',
      success: '',
      documentSearch: '',
      statusFilter: 'all' as string,
      statusOptions: [
        { label: '全部状态', value: 'all' },
        { label: '处理中', value: 'processing' },
        { label: '已就绪', value: 'ready' },
        { label: '处理失败', value: 'failed' },
      ],
      selectedId: '',
      chunks: [] as Chunk[],
      chunksLoading: false,
      chunksError: '',
      chunkMode: 'stored' as 'stored' | 'preview',
      chunkFirst: 0,
      chunkRows: 5,
      chunkForm: { chunkSize: 500, chunkOverlap: 50 } as DraftConfig,
      configError: '',
      previewChunks: [] as Chunk[],
      previewConfig: null as ChunkConfig | null,
      previewLoading: false,
      previewError: '',
      uploads: [] as UploadItem[],
      uploadSequence: 0,
      uploading: false,
      fileErrors: [] as string[],
      dragging: false,
      downloadIds: [] as string[],
      actionErrors: {} as Record<string, string>,
      deleteVisible: false,
      deleteTarget: null as DocumentRecord | null,
      deleting: false,
      deleteError: '',
      processVisible: false,
      processTarget: null as DocumentRecord | null,
      processConfig: null as ChunkConfig | null,
      processSubmitting: false,
      processError: '',
      disposed: false,
      epoch: 0,
      listRequest: 0,
      documentRevision: 0,
      chunkRequest: 0,
      previewRequest: 0,
      pollTimer: null as ReturnType<typeof setTimeout> | null,
      downloadResources: [] as { url: string; timer: ReturnType<typeof setTimeout> }[],
    }
  },
  computed: {
    kbId(): string {
      const id = this.$route.params.id
      return Array.isArray(id) ? id[0] || '' : id || ''
    },
    canManage(): boolean {
      return (
        !!this.kb &&
        !!this.auth.user &&
        (this.auth.isAdmin || this.kb.ownerId === this.auth.user.id)
      )
    },
    selectedDocument(): DocumentRecord | null {
      return this.documents.find((doc) => doc.id === this.selectedId) || null
    },
    filteredDocuments(): DocumentRecord[] {
      const query = this.documentSearch.trim().toLocaleLowerCase()
      return this.documents.filter(
        (doc) =>
          (!query || doc.name.toLocaleLowerCase().includes(query)) &&
          (this.statusFilter === 'all' ||
            (this.statusFilter === 'processing'
              ? this.isProcessing(doc.status)
              : doc.status === this.statusFilter)),
      )
    },
    readyCount(): number {
      return this.documents.filter((doc) => doc.status === 'ready').length
    },
    processingCount(): number {
      return this.documents.filter((doc) => this.isProcessing(doc.status)).length
    },
    failedCount(): number {
      return this.documents.filter((doc) => doc.status === 'failed').length
    },
    storedChunkCount(): number {
      return this.documents
        .filter((doc) => doc.status === 'ready')
        .reduce((sum, doc) => sum + doc.chunkCount, 0)
    },
    totalSize(): number {
      return this.documents.reduce((sum, doc) => sum + doc.size, 0)
    },
    queuedCount(): number {
      return this.uploads.filter((item) => item.state === 'queued').length
    },
    failedUploads(): number {
      return this.uploads.filter((item) => item.state === 'failed').length
    },
    visibleChunks(): Chunk[] {
      return this.chunkMode === 'preview' ? this.previewChunks : this.chunks
    },
    pagedChunks(): Chunk[] {
      return this.visibleChunks.slice(this.chunkFirst, this.chunkFirst + this.chunkRows)
    },
    selectedProcessing(): boolean {
      return !!this.selectedDocument && this.isProcessing(this.selectedDocument.status)
    },
    previewMatches(): boolean {
      return (
        !!this.previewConfig &&
        this.previewConfig.chunkSize === this.chunkForm.chunkSize &&
        this.previewConfig.chunkOverlap === this.chunkForm.chunkOverlap
      )
    },
  },
  watch: {
    kbId: {
      immediate: true,
      handler() {
        void this.initialize()
      },
    },
    'chunkForm.chunkSize'() {
      this.invalidatePreview()
    },
    'chunkForm.chunkOverlap'() {
      this.invalidatePreview()
    },
  },
  beforeUnmount() {
    this.disposed = true
    this.epoch++
    this.stopPolling()
    this.cleanupDownloads()
    this.chunkRequest++
    this.previewRequest++
    this.listRequest++
  },
  methods: {
    clearDocumentFilters() {
      this.documentSearch = ''
      this.statusFilter = 'all'
    },
    onChunkPage(event: { first: number; rows: number }) {
      this.chunkFirst = event.first
      this.chunkRows = event.rows
    },
    current(epoch: number): boolean {
      return !this.disposed && this.epoch === epoch
    },
    isProcessing(status: DocumentStatus): boolean {
      return status !== 'ready' && status !== 'failed'
    },
    statusLabel(status: DocumentStatus): string {
      return status === 'failed'
        ? '处理失败'
        : this.stages.find((stage) => stage.value === status)?.label || status
    },
    severity(status: DocumentStatus): Severity {
      return status === 'ready' ? 'success' : status === 'failed' ? 'danger' : 'info'
    },
    percent(value: number): number {
      return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 0
    },
    formatSize(value: number): string {
      if (value < 1024) return `${value} B`
      return value < 1024 * 1024
        ? `${(value / 1024).toFixed(1)} KiB`
        : `${(value / (1024 * 1024)).toFixed(1)} MiB`
    },
    formatDate(value: string): string {
      const date = new Date(value)
      return Number.isNaN(date.getTime())
        ? '日期未知'
        : date.toLocaleString('zh-CN', { hour12: false })
    },
    extension(name: string): string {
      return name.split('.').pop()?.toUpperCase() || 'FILE'
    },
    stageClass(doc: DocumentRecord, index: number): string {
      if (doc.status === 'failed') return 'stage-unknown'
      const current = this.stages.findIndex((stage) => stage.value === doc.status)
      return index < current || doc.status === 'ready'
        ? 'stage-done'
        : index === current
          ? 'stage-active'
          : ''
    },
    stopPolling() {
      if (this.pollTimer !== null) {
        clearTimeout(this.pollTimer)
        this.pollTimer = null
      }
    },
    schedulePoll(delay = 2000) {
      this.stopPolling()
      if (
        this.disposed ||
        !this.kb ||
        this.documentsError ||
        !this.documents.some((doc) => this.isProcessing(doc.status))
      )
        return
      const epoch = this.epoch
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null
        if (this.current(epoch)) void this.refreshDocuments(true)
      }, delay)
    },
    cleanupDownloads() {
      this.downloadResources.forEach((resource) => {
        clearTimeout(resource.timer)
        URL.revokeObjectURL(resource.url)
      })
      this.downloadResources = []
    },
    async initialize() {
      const epoch = ++this.epoch
      this.stopPolling()
      this.cleanupDownloads()
      this.listRequest++
      this.chunkRequest++
      this.previewRequest++
      this.kb = null
      this.documents = []
      this.selectedId = ''
      this.chunks = []
      this.chunksLoading = false
      this.chunksError = ''
      this.uploads = []
      this.uploading = false
      this.fileErrors = []
      this.actionErrors = {}
      this.downloadIds = []
      this.deleteVisible = false
      this.deleteTarget = null
      this.deleting = false
      this.deleteError = ''
      this.processVisible = false
      this.processTarget = null
      this.processConfig = null
      this.processSubmitting = false
      this.processError = ''
      this.documentsError = ''
      this.documentsLoading = false
      this.pageError = ''
      this.success = ''
      this.loading = true
      this.documentSearch = ''
      this.statusFilter = 'all'
      this.dragging = false
      this.invalidatePreview()
      try {
        if (!this.kbId) throw new Error('知识库地址无效。')
        const knowledge = await api.knowledgeBases()
        if (!this.current(epoch)) return
        const kb = knowledge.find((item) => item.id === this.kbId)
        if (!kb) throw new Error('知识库不存在、已被删除，或你没有访问权限。')
        if (!this.auth.user || (!this.auth.isAdmin && kb.ownerId !== this.auth.user.id))
          throw new Error('你没有访问此知识库的权限。')
        this.kb = kb
        await this.refreshDocuments()
      } catch (error) {
        if (this.current(epoch)) this.pageError = messageOf(error)
      } finally {
        if (this.current(epoch)) this.loading = false
      }
    },
    async refreshDocuments(silent = false) {
      if (!this.kb || this.disposed) return
      this.stopPolling()
      const epoch = this.epoch
      const request = ++this.listRequest
      const revision = this.documentRevision
      const kbId = this.kb.id
      this.documentsLoading = true
      if (!silent) this.documentsError = ''
      try {
        const documents = await api.documents(kbId)
        if (!this.current(epoch) || request !== this.listRequest) return
        // 上传、删除或重新处理后，旧快照不得覆盖本地刚收到的结果。
        if (revision !== this.documentRevision) {
          this.schedulePoll(500)
          return
        }
        const previous = this.selectedDocument
        this.documents = documents
        this.documentsError = ''
        this.synchronizeSelection(previous)
        this.schedulePoll()
      } catch (error) {
        if (this.current(epoch) && request === this.listRequest) {
          this.documentsError = `文档状态更新失败：${messageOf(error)} 自动轮询已暂停，请重试；后台处理可能仍在继续。`
          this.stopPolling()
        }
      } finally {
        if (this.current(epoch) && request === this.listRequest) this.documentsLoading = false
      }
    },
    synchronizeSelection(previous: DocumentRecord | null) {
      const selected = this.selectedDocument
      if (!selected) {
        this.selectDocument(this.documents[0]?.id || '')
        return
      }
      if (
        !previous ||
        selected.id !== previous.id ||
        selected.version !== previous.version ||
        selected.status !== previous.status
      ) {
        this.selectDocument(selected.id)
      }
    },
    upsertDocument(doc: DocumentRecord) {
      this.documentRevision++
      const previous = this.selectedDocument
      const index = this.documents.findIndex((item) => item.id === doc.id)
      if (index < 0) this.documents.unshift(doc)
      else this.documents.splice(index, 1, doc)
      this.synchronizeSelection(previous)
      this.schedulePoll()
    },
    selectDocument(id: string) {
      this.selectedId = id
      this.chunkRequest++
      this.chunks = []
      this.chunksError = ''
      this.chunksLoading = false
      this.invalidatePreview()
      this.chunkMode = 'stored'
      this.chunkFirst = 0
      const doc = this.selectedDocument
      this.chunkForm = {
        chunkSize: doc?.chunkSize ?? this.kb?.chunkSize ?? 500,
        chunkOverlap: doc?.chunkOverlap ?? this.kb?.chunkOverlap ?? 50,
      }
      if (doc?.status === 'ready') void this.loadChunks()
    },
    async loadChunks() {
      const doc = this.selectedDocument
      if (!doc || doc.status !== 'ready') return
      const epoch = this.epoch
      const request = ++this.chunkRequest
      this.chunksLoading = true
      this.chunksError = ''
      try {
        const chunks = await api.chunks(doc.id)
        if (
          !this.current(epoch) ||
          request !== this.chunkRequest ||
          this.selectedDocument?.id !== doc.id ||
          this.selectedDocument.status !== 'ready' ||
          this.selectedDocument.version !== doc.version
        )
          return
        if (chunks.some((chunk) => chunk.documentId !== doc.id || chunk.version !== doc.version))
          throw new Error('片段版本与当前文档不一致，请先刷新文档列表，再重新加载片段。')
        this.chunks = chunks
        this.chunkFirst = 0
      } catch (error) {
        if (this.current(epoch) && request === this.chunkRequest)
          this.chunksError = messageOf(error)
      } finally {
        if (this.current(epoch) && request === this.chunkRequest) this.chunksLoading = false
      }
    },
    invalidatePreview() {
      this.previewRequest++
      this.previewConfig = null
      this.previewChunks = []
      this.previewError = ''
      this.previewLoading = false
      this.configError = ''
      this.chunkMode = 'stored'
      this.chunkFirst = 0
    },
    setChunkMode(mode: 'stored' | 'preview') {
      this.chunkMode = mode
      this.chunkFirst = 0
    },
    async preview() {
      const doc = this.selectedDocument
      if (
        !doc ||
        !this.canManage ||
        this.selectedProcessing ||
        this.previewLoading ||
        this.processSubmitting
      )
        return
      let config: ChunkConfig
      try {
        config = checkedConfig(this.chunkForm)
        this.configError = ''
      } catch (error) {
        this.configError = messageOf(error)
        return
      }
      const epoch = this.epoch
      const request = ++this.previewRequest
      this.previewLoading = true
      this.previewError = ''
      this.previewConfig = null
      this.previewChunks = []
      try {
        const chunks = await api.preview(doc.id, config)
        if (
          !this.current(epoch) ||
          request !== this.previewRequest ||
          this.selectedId !== doc.id ||
          this.selectedProcessing
        )
          return
        this.previewChunks = chunks
        this.previewConfig = { ...config }
        this.chunkMode = 'preview'
        this.chunkFirst = 0
      } catch (error) {
        if (this.current(epoch) && request === this.previewRequest)
          this.previewError = messageOf(error)
      } finally {
        if (this.current(epoch) && request === this.previewRequest) this.previewLoading = false
      }
    },
    prepareProcess() {
      const doc = this.selectedDocument
      if (
        !doc ||
        !this.canManage ||
        this.selectedProcessing ||
        !this.previewMatches ||
        this.processSubmitting
      )
        return
      try {
        this.processConfig = checkedConfig(this.chunkForm)
        this.processTarget = { ...doc }
        this.processError = ''
        this.processVisible = true
      } catch (error) {
        this.configError = messageOf(error)
      }
    },
    prepareRetry(doc: DocumentRecord) {
      if (!this.canManage || doc.status !== 'failed' || this.processSubmitting) return
      try {
        this.processConfig = checkedConfig(doc)
        this.processTarget = { ...doc }
        this.processError = ''
        this.processVisible = true
      } catch (error) {
        this.actionErrors[doc.id] = messageOf(error)
      }
    },
    async confirmProcess() {
      const target = this.processTarget
      const config = this.processConfig
      if (!target || !config || !this.canManage || this.processSubmitting) return
      const epoch = this.epoch
      this.processSubmitting = true
      this.processError = ''
      this.success = ''
      try {
        const latest = this.documents.find((doc) => doc.id === target.id)
        if (!latest) throw new Error('文档已被删除，请关闭对话框并刷新列表。')
        if (this.isProcessing(latest.status))
          throw new Error('文档已经在处理中，请等待当前任务完成。')
        if (
          latest.version !== target.version ||
          latest.chunkSize !== target.chunkSize ||
          latest.chunkOverlap !== target.chunkOverlap
        )
          throw new Error('文档版本或参数已更新，请关闭对话框后重新预览并确认。')
        const result = await api.process(target.id, { ...config })
        if (!this.current(epoch)) return
        this.upsertDocument(result)
        if (this.selectedId !== result.id) this.selectDocument(result.id)
        this.invalidatePreview()
        this.processVisible = false
        delete this.actionErrors[target.id]
        this.success = '处理请求已提交。以文档实际状态为准；完成前不展示新版本片段。'
      } catch (error) {
        if (this.current(epoch)) this.processError = messageOf(error)
      } finally {
        if (this.current(epoch)) this.processSubmitting = false
      }
    },
    openFilePicker() {
      if (!this.canManage || this.loading) return
      ;(this.$refs.fileInput as HTMLInputElement | undefined)?.click()
    },
    onFileInput(event: Event) {
      const input = event.target as HTMLInputElement
      if (input.files) this.addFiles(Array.from(input.files))
      input.value = ''
    },
    onDrop(event: DragEvent) {
      this.dragging = false
      if (event.dataTransfer) this.addFiles(Array.from(event.dataTransfer.files))
    },
    addFiles(files: File[]) {
      if (!this.canManage || this.loading) return
      const errors: string[] = []
      for (const file of files) {
        try {
          checkFile(file)
          if (
            this.uploads.some(
              (item) =>
                item.state !== 'uploaded' &&
                item.file.name === file.name &&
                item.file.size === file.size &&
                item.file.lastModified === file.lastModified,
            )
          ) {
            errors.push(`${file.name}：已在上传队列中。`)
            continue
          }
          this.uploads.push({
            id: ++this.uploadSequence,
            file,
            state: 'queued',
            progress: 0,
            error: '',
          })
        } catch (error) {
          errors.push(`${file.name}：${messageOf(error)}`)
        }
      }
      this.fileErrors = errors
    },
    removeUpload(id: number) {
      this.uploads = this.uploads.filter((item) => item.id !== id || item.state === 'uploading')
    },
    clearUploaded() {
      this.uploads = this.uploads.filter((item) => item.state !== 'uploaded')
    },
    retryUpload(item: UploadItem) {
      if (!this.canManage || item.state !== 'failed') return
      item.state = 'queued'
      item.progress = 0
      item.error = ''
      if (!this.uploading) void this.startUploads()
    },
    async startUploads() {
      if (!this.canManage || !this.kb || this.uploading || !this.queuedCount) return
      const epoch = this.epoch
      const kbId = this.kb.id
      this.uploading = true
      this.success = ''
      try {
        while (this.current(epoch) && this.canManage) {
          const item = this.uploads.find((upload) => upload.state === 'queued')
          if (!item) break
          item.state = 'uploading'
          item.progress = 0
          item.error = ''
          try {
            checkFile(item.file)
            const doc = await api.upload(kbId, item.file, (value) => {
              if (this.current(epoch) && item.state === 'uploading')
                item.progress = Math.max(item.progress, this.percent(value))
            })
            if (!this.current(epoch)) return
            item.state = 'uploaded'
            item.progress = 100
            this.upsertDocument(doc)
          } catch (error) {
            if (!this.current(epoch)) return
            item.state = 'failed'
            item.error = messageOf(error)
          }
        }
      } finally {
        if (this.current(epoch)) {
          this.uploading = false
          this.success = this.failedUploads
            ? '本轮上传已结束，失败文件可单独重试。上传成功不代表文档处理完成。'
            : '上传队列已执行完毕。请在文档列表查看后续处理状态。'
        }
      }
    },
    mockDownload(doc: DocumentRecord): boolean {
      return (this.isMock || !!doc.simulated) && /\.(pdf|docx)$/i.test(doc.name)
    },
    async download(doc: DocumentRecord) {
      if (this.downloadIds.includes(doc.id)) return
      const epoch = this.epoch
      this.downloadIds.push(doc.id)
      delete this.actionErrors[doc.id]
      try {
        let blob = await api.download(doc.id)
        if (!this.current(epoch)) return
        let name = doc.name
        if (this.mockDownload(doc)) {
          blob = new Blob(
            [
              `模拟下载说明\n\n文档名称：${doc.name}\n此文档的 PDF / DOCX 为占位内容，不参与真实检索，当前演示不提供原始文件。\n本文件只是模拟能力说明，不是原文，不包含真实 PDF / DOCX 内容。\n请连接真实后端后使用原文下载。\n`,
            ],
            { type: 'text/plain;charset=utf-8' },
          )
          name = `${doc.name}.模拟说明.txt`
        }
        const url = URL.createObjectURL(blob)
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url)
          this.downloadResources = this.downloadResources.filter((resource) => resource.url !== url)
        }, 1500)
        this.downloadResources.push({ url, timer })
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        anchor.style.display = 'none'
        document.body.appendChild(anchor)
        try {
          anchor.click()
        } finally {
          anchor.remove()
        }
        this.success = this.mockDownload(doc)
          ? '已发起模拟说明 TXT 下载；这不是 PDF / Word 原文。'
          : `已发起“${doc.name}”下载，请在浏览器中确认保存结果。`
      } catch (error) {
        if (this.current(epoch)) this.actionErrors[doc.id] = `下载失败：${messageOf(error)}`
      } finally {
        if (this.current(epoch)) this.downloadIds = this.downloadIds.filter((id) => id !== doc.id)
      }
    },
    askDelete(doc: DocumentRecord) {
      if (!this.canManage || this.deleting || this.processSubmitting) return
      this.deleteTarget = { ...doc }
      this.deleteError = ''
      this.deleteVisible = true
    },
    async confirmDelete() {
      const target = this.deleteTarget
      if (!target || !this.canManage || this.deleting) return
      const epoch = this.epoch
      this.deleting = true
      this.deleteError = ''
      this.success = ''
      try {
        await api.deleteDocument(target.id)
        if (!this.current(epoch)) return
        this.documentRevision++
        const previous = this.selectedDocument
        this.documents = this.documents.filter((doc) => doc.id !== target.id)
        this.synchronizeSelection(previous)
        delete this.actionErrors[target.id]
        this.deleteVisible = false
        this.success = `已删除文档“${target.name}”及其片段。`
        this.schedulePoll()
      } catch (error) {
        if (this.current(epoch)) this.deleteError = messageOf(error)
      } finally {
        if (this.current(epoch)) this.deleting = false
      }
    },
  },
})
</script>

<template>
  <section class="knowledge-detail">
    <RouterLink to="/knowledge" class="back-link"
      ><i class="pi pi-arrow-left" aria-hidden="true" /> 返回知识库</RouterLink
    >
    <div v-if="loading" class="empty-state panel" role="status">
      <ProgressSpinner class="small-spinner" aria-label="正在加载知识库详情" />
      <p>正在加载知识库与文档…</p>
    </div>
    <div v-else-if="pageError" class="empty-state panel">
      <i class="pi pi-exclamation-circle empty-icon" aria-hidden="true" />
      <h1>暂时无法打开知识库</h1>
      <p class="error-copy" role="alert">{{ pageError }}</p>
      <Button label="重试加载" icon="pi pi-refresh" @click="initialize" />
    </div>
    <template v-else-if="kb">
      <header class="page-header">
        <div class="detail-heading">
          <p class="eyebrow">KNOWLEDGE / DOCUMENTS</p>
          <h1>{{ kb.name }}</h1>
          <p class="muted">{{ kb.description || '管理文档处理流程，预览可检索的知识片段。' }}</p>
        </div>
        <Tag :value="canManage ? '可管理' : '只读'" severity="secondary" />
      </header>
      <div v-if="isMock" class="mock-notice" role="note">
        <i class="pi pi-info-circle" aria-hidden="true" />
        <div>
          <strong>真实正文切分 · 上传阶段模拟 · 检索与回答能力分开标注</strong>
          <p>
            TXT / MD 按真实正文切分；PDF / DOCX 仅为占位内容，不参与真实检索，下载只提供说明 TXT。
            上传、向量化、入库的阶段进度仍为模拟；local 模式在检索时使用固定 BGE 进行本地 CPU
            真实计算，demo 模式仅演示固定分数。回答仍是模板模拟，种子资料为虚构内容。
            原模型管理配置未自动接通，不执行 Rerank。服务不可用时不会自动降级 demo。请勿上传敏感文件。
          </p>
        </div>
      </div>
      <div v-if="success" class="success-notice" role="status">{{ success }}</div>
      <div class="stat-grid detail-stats" aria-label="当前知识库统计">
        <div class="stat-card">
          <span class="muted">文档总数</span><strong>{{ documents.length }}</strong
          ><small class="muted">{{ formatSize(totalSize) }}</small>
        </div>
        <div class="stat-card">
          <span class="muted">已就绪</span><strong>{{ readyCount }}</strong
          ><small class="muted">{{ isMock ? '真实检索仅支持就绪 TXT / MD' : '可用于知识检索' }}</small>
        </div>
        <div class="stat-card">
          <span class="muted">处理中 / 失败</span
          ><strong
            >{{ processingCount }} <span class="stat-divider">/</span>
            <span :class="{ 'error-copy': failedCount > 0 }">{{ failedCount }}</span></strong
          ><small class="muted">失败文档可重新处理</small>
        </div>
        <div class="stat-card">
          <span class="muted">就绪文档片段</span><strong>{{ storedChunkCount }}</strong
          ><small class="muted">统计来自当前文档列表</small>
        </div>
      </div>
      <div v-if="documentsError" class="error-banner" role="alert">
        <span>{{ documentsError }} 当前统计可能不是最新数据。</span
        ><Button
          label="重试并恢复轮询"
          icon="pi pi-refresh"
          severity="secondary"
          size="small"
          :loading="documentsLoading"
          @click="refreshDocuments()"
        />
      </div>

      <section v-if="canManage" class="panel upload-panel" aria-labelledby="upload-title">
        <div class="section-heading">
          <div>
            <h2 id="upload-title">上传文档</h2>
            <p class="muted">
              默认切分 {{ kb.chunkSize }} 字符，重叠 {{ kb.chunkOverlap }} 字符；单文件最大 20 MiB。
            </p>
          </div>
          <Tag v-if="isMock" value="上传与阶段进度模拟" severity="warn" />
        </div>
        <input
          ref="fileInput"
          class="native-file"
          type="file"
          multiple
          accept=".pdf,.docx,.md,.txt"
          aria-label="选择待上传文档"
          tabindex="-1"
          @change="onFileInput"
        />
        <div
          class="drop-zone"
          :class="{ dragging }"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <i class="pi pi-cloud-upload" aria-hidden="true" />
          <div>
            <strong>拖放文件到这里，或选择多个文件</strong>
            <p class="muted">PDF · DOCX · MD · TXT · 每份 ≤ 20 MiB</p>
          </div>
          <Button
            label="选择文件"
            icon="pi pi-plus"
            severity="secondary"
            outlined
            @click="openFilePicker"
          />
        </div>
        <ul v-if="fileErrors.length" class="error-banner file-errors" role="alert">
          <li v-for="(error, index) in fileErrors" :key="index">{{ error }}</li>
        </ul>
        <div v-if="uploads.length" class="upload-queue">
          <div class="queue-heading">
            <span
              >{{ uploads.length }} 个文件 · {{ queuedCount }} 个待上传<span v-if="failedUploads">
                · {{ failedUploads }} 个上传失败</span
              ></span
            >
            <div class="button-row">
              <Button
                v-if="uploads.some((item) => item.state === 'uploaded')"
                label="清除已上传记录"
                size="small"
                severity="secondary"
                text
                @click="clearUploaded"
              /><Button
                :label="uploading ? '正在上传' : `开始上传（${queuedCount}）`"
                icon="pi pi-upload"
                :loading="uploading"
                :disabled="!queuedCount && !uploading"
                @click="startUploads"
              />
            </div>
          </div>
          <article v-for="item in uploads" :key="item.id" class="upload-row">
            <div class="upload-info">
              <strong>{{ item.file.name }}</strong
              ><small class="muted">{{ formatSize(item.file.size) }}</small>
              <div class="transfer-progress">
                <span>上传进度 {{ item.progress }}%</span
                ><ProgressBar
                  :value="item.progress"
                  :show-value="false"
                  :aria-label="`${item.file.name} 上传进度 ${item.progress}%`"
                />
              </div>
              <small v-if="item.state === 'uploading' && item.progress === 100" class="muted"
                >{{ isMock ? '模拟上传进度完成，正在保存正文…' : '传输完成，等待服务端确认…' }}</small
              >
              <p v-if="item.error" class="error-copy" role="alert">{{ item.error }}</p>
            </div>
            <div class="upload-actions">
              <Tag
                :value="
                  item.state === 'queued'
                    ? '待上传'
                    : item.state === 'uploading'
                      ? '传输中'
                      : item.state === 'uploaded'
                        ? '上传成功，处理见下方'
                        : '上传失败'
                "
                :severity="
                  item.state === 'failed'
                    ? 'danger'
                    : item.state === 'uploaded'
                      ? 'success'
                      : 'secondary'
                "
              /><Button
                v-if="item.state === 'failed'"
                label="重试上传"
                size="small"
                severity="secondary"
                @click="retryUpload(item)"
              /><Button
                v-if="item.state !== 'uploading'"
                icon="pi pi-times"
                :aria-label="`移除 ${item.file.name} 的上传记录`"
                severity="secondary"
                text
                @click="removeUpload(item.id)"
              />
            </div>
          </article>
          <p class="muted queue-note">
            {{ isMock ? '上传百分比与下方处理阶段均为模拟，不表示已建立真实向量索引。' : '上传进度仅表示文件传输；下方流水线才是处理进度。' }}
            离开页面会停止本地排队与状态更新，已发出的请求无法在此取消；返回后请刷新确认。
          </p>
        </div>
      </section>

      <div class="document-workspace">
        <section
          class="panel documents-panel"
          aria-labelledby="documents-title"
          :aria-busy="documentsLoading"
        >
          <div class="section-heading">
            <div>
              <h2 id="documents-title">
                文档 <span class="muted">{{ documents.length }}</span>
              </h2>
              <p class="muted">选择文档，在右侧查看片段与切分参数。</p>
            </div>
            <Button
              icon="pi pi-refresh"
              label="刷新"
              severity="secondary"
              text
              :loading="documentsLoading"
              @click="refreshDocuments()"
            />
          </div>
          <div class="toolbar document-toolbar">
            <InputText
              v-model="documentSearch"
              placeholder="搜索文档名称"
              aria-label="搜索文档名称"
            /><Select
              v-model="statusFilter"
              :options="statusOptions"
              option-label="label"
              option-value="value"
              aria-label="按文档状态筛选"
            />
          </div>
          <p class="poll-state muted" role="status">
            <i
              :class="
                documentsError
                  ? 'pi pi-exclamation-triangle'
                  : processingCount
                    ? 'pi pi-clock'
                    : 'pi pi-check-circle'
              "
              aria-hidden="true"
            />{{
              documentsError
                ? '轮询已暂停，请重试更新'
                : documentsLoading
                  ? '正在同步文档状态…'
                  : processingCount
                    ? '每 2 秒同步处理状态，离开页面自动停止'
                    : '当前没有正在处理的文档'
            }}
          </p>
          <div v-if="!filteredDocuments.length" class="empty-state document-empty">
            <i class="pi pi-file empty-icon" aria-hidden="true" />
            <h3>
              {{
                documentsError
                  ? '文档列表暂不可用'
                  : documents.length
                    ? '没有匹配的文档'
                    : '还没有文档'
              }}
            </h3>
            <p class="muted">
              {{
                documentsError
                  ? '请使用上方重试按钮重新加载。'
                  : documents.length
                    ? '调整关键词或状态筛选后重试。'
                    : '上传第一份文件，即可查看处理流水线和知识片段。'
              }}
            </p>
            <Button
              v-if="documents.length && !documentsError"
              label="清除筛选"
              severity="secondary"
              outlined
              @click="clearDocumentFilters"
            />
          </div>
          <div v-else class="document-list">
            <article
              v-for="doc in filteredDocuments"
              :key="doc.id"
              class="document-card"
              :class="{ selected: selectedId === doc.id }"
            >
              <button
                class="document-select"
                type="button"
                :aria-pressed="selectedId === doc.id"
                @click="selectDocument(doc.id)"
              >
                <span class="file-mark">{{ extension(doc.name) }}</span
                ><span class="document-title"
                  ><strong>{{ doc.name }}</strong
                  ><small
                    >{{ formatSize(doc.size) }} · 版本 {{ doc.version }} ·
                    {{ doc.chunkCount }} 个片段</small
                  ></span
                ><i
                  v-if="selectedId === doc.id"
                  class="pi pi-check-circle selected-check"
                  aria-hidden="true"
                />
              </button>
              <div class="document-badges">
                <Tag :value="statusLabel(doc.status)" :severity="severity(doc.status)" /><Tag
                  v-if="isMock || doc.simulated"
                  :value="mockDownload(doc) ? '占位内容 · 不参与真实检索' : '真实正文切分 · 阶段模拟'"
                  severity="warn"
                /><small class="muted">{{ formatDate(doc.createdAt) }}</small>
              </div>
              <ol class="pipeline" :aria-label="`处理流水线：${statusLabel(doc.status)}`">
                <li
                  v-for="(stage, index) in stages"
                  :key="stage.value"
                  :class="stageClass(doc, index)"
                >
                  <span class="stage-dot" /><span>{{ stage.label }}</span>
                </li>
              </ol>
              <div class="processing-progress">
                <div>
                  <span>处理进度</span><strong>{{ percent(doc.progress) }}%</strong>
                </div>
                <ProgressBar
                  :value="percent(doc.progress)"
                  :show-value="false"
                  :class="{ 'failed-progress': doc.status === 'failed' }"
                  :aria-label="`${doc.name} 处理进度 ${percent(doc.progress)}%`"
                />
              </div>
              <p v-if="doc.status === 'failed'" class="document-error" role="alert">
                {{ doc.error || '处理未完成，服务端未提供具体原因。'
                }}<span> 可按原参数重试，或选择文档后修改参数。</span>
              </p>
              <p v-if="actionErrors[doc.id]" class="document-error" role="alert">
                {{ actionErrors[doc.id] }}
              </p>
              <div class="document-actions">
                <Button
                  v-if="doc.status === 'failed' && canManage"
                  label="重试处理"
                  icon="pi pi-replay"
                  size="small"
                  severity="warn"
                  :disabled="processSubmitting || deleting"
                  @click="prepareRetry(doc)"
                /><Button
                  :label="mockDownload(doc) ? '下载模拟说明 TXT' : '下载原文'"
                  icon="pi pi-download"
                  severity="secondary"
                  text
                  size="small"
                  :loading="downloadIds.includes(doc.id)"
                  @click="download(doc)"
                /><Button
                  v-if="canManage"
                  icon="pi pi-trash"
                  label="删除"
                  severity="danger"
                  text
                  size="small"
                  :disabled="deleting || processSubmitting"
                  @click="askDelete(doc)"
                />
              </div>
            </article>
          </div>
        </section>

        <aside class="panel preview-panel" aria-labelledby="preview-title">
          <div class="section-heading">
            <div>
              <p class="eyebrow">CHUNK EXPLORER</p>
              <h2 id="preview-title">内容与切分预览</h2>
            </div>
            <Tag
              v-if="selectedDocument"
              :value="`V${selectedDocument.version}`"
              severity="secondary"
            />
          </div>
          <div v-if="!selectedDocument" class="empty-state preview-empty">
            <i class="pi pi-align-left empty-icon" aria-hidden="true" />
            <h3>选择一份文档</h3>
            <p class="muted">处理就绪后，在这里逐片查看内容、长度、页码和章节。</p>
          </div>
          <template v-else>
            <div class="selected-summary">
              <h3>{{ selectedDocument.name }}</h3>
              <div class="button-row">
                <Tag
                  :value="statusLabel(selectedDocument.status)"
                  :severity="severity(selectedDocument.status)"
                /><Tag
                  v-if="isMock || selectedDocument.simulated"
                  :value="mockDownload(selectedDocument) ? '占位内容 · 不参与真实检索' : '真实正文切分 · 阶段模拟'"
                  severity="warn"
                />
              </div>
              <p class="muted">
                当前参数：{{ selectedDocument.chunkSize }} 字符 / 重叠
                {{ selectedDocument.chunkOverlap }} 字符
              </p>
            </div>
            <form class="config-form" @submit.prevent="preview">
              <div class="form-grid config-grid">
                <div class="field">
                  <label for="doc-chunk-size">切分长度（字符）</label
                  ><InputNumber
                    v-model="chunkForm.chunkSize"
                    input-id="doc-chunk-size"
                    :use-grouping="false"
                    :max-fraction-digits="0"
                    :disabled="!canManage || selectedProcessing || processSubmitting"
                    :invalid="!!configError"
                  /><small class="muted">50～4000，按字符而非 Token。</small>
                </div>
                <div class="field">
                  <label for="doc-overlap">重叠长度（字符）</label
                  ><InputNumber
                    v-model="chunkForm.chunkOverlap"
                    input-id="doc-overlap"
                    :use-grouping="false"
                    :max-fraction-digits="0"
                    :disabled="!canManage || selectedProcessing || processSubmitting"
                    :invalid="!!configError"
                  /><small class="muted">非负整数，小于切分长度。</small>
                </div>
              </div>
              <p v-if="configError" class="error-copy" role="alert">{{ configError }}</p>
              <div v-if="canManage" class="button-row config-actions">
                <Button
                  type="submit"
                  label="预览切分"
                  icon="pi pi-eye"
                  severity="secondary"
                  outlined
                  :loading="previewLoading"
                  :disabled="selectedProcessing || processSubmitting"
                /><Button
                  label="确认重新处理"
                  icon="pi pi-sync"
                  :disabled="
                    !previewMatches ||
                    selectedProcessing ||
                    previewLoading ||
                    processSubmitting ||
                    deleting
                  "
                  @click="prepareProcess"
                />
              </div>
              <p class="muted config-note">
                {{
                  canManage
                    ? '修改参数后先预览，再显式确认重新处理。预览不覆盖正式片段，不参与真实检索；失败文档也可直接按原参数重试。'
                    : '当前为只读模式，不能修改参数或重新处理。'
                }}
              </p>
            </form>
            <div v-if="previewError" class="error-banner" role="alert">
              <span>预览失败：{{ previewError }}</span
              ><Button
                label="重试预览"
                size="small"
                severity="secondary"
                :disabled="selectedProcessing || processSubmitting"
                @click="preview"
              />
            </div>
            <div v-if="selectedProcessing" class="processing-notice" role="status">
              <i class="pi pi-spin pi-spinner" aria-hidden="true" />
              <div>
                <strong
                  >正在{{ statusLabel(selectedDocument.status) }} ·
                  {{ percent(selectedDocument.progress) }}%</strong
                >
                <p>等待处理成功后读取内容片段，不将旧版本当作新结果展示。</p>
              </div>
            </div>
            <div v-else-if="selectedDocument.status === 'failed'" class="error-banner" role="alert">
              <span>{{ selectedDocument.error || '文档处理失败，暂不读取内容片段。' }}</span
              ><Button
                v-if="canManage"
                label="按原参数重试"
                size="small"
                severity="warn"
                :disabled="processSubmitting || deleting"
                @click="prepareRetry(selectedDocument)"
              />
            </div>
            <div class="chunk-tabs" role="group" aria-label="选择片段来源">
              <Button
                label="已提交片段"
                size="small"
                :outlined="chunkMode !== 'stored'"
                :severity="chunkMode === 'stored' ? undefined : 'secondary'"
                :aria-pressed="chunkMode === 'stored'"
                @click="setChunkMode('stored')"
              /><Button
                :label="`参数预览${previewConfig ? ` · ${previewChunks.length}` : ''}`"
                size="small"
                :outlined="chunkMode !== 'preview'"
                :severity="chunkMode === 'preview' ? undefined : 'secondary'"
                :disabled="!previewConfig"
                :aria-pressed="chunkMode === 'preview'"
                @click="setChunkMode('preview')"
              />
            </div>
            <p v-if="chunkMode === 'preview'" class="preview-warning" role="note">
              仅预览 · {{ previewConfig?.chunkSize }} / {{ previewConfig?.chunkOverlap }} 字符 ·
              尚未提交，不参与真实检索。{{
                isMock || selectedDocument.simulated
                  ? mockDownload(selectedDocument)
                    ? 'PDF / DOCX 仅展示占位内容。'
                    : 'TXT / MD 使用实际正文字符切分，阶段进度仍为模拟。'
                  : ''
              }}
            </p>
            <div
              v-if="previewLoading || (chunkMode === 'stored' && chunksLoading)"
              class="empty-state chunk-loading"
              role="status"
            >
              <ProgressSpinner class="small-spinner" aria-label="正在加载文档片段" />
              <p>{{ previewLoading ? '正在生成切分预览…' : '正在读取就绪片段…' }}</p>
            </div>
            <div
              v-else-if="chunkMode === 'stored' && chunksError"
              class="error-banner"
              role="alert"
            >
              <span>片段加载失败：{{ chunksError }}</span
              ><Button label="重新加载片段" size="small" severity="secondary" @click="loadChunks" />
            </div>
            <div v-else-if="!visibleChunks.length" class="empty-state chunk-empty">
              <p class="muted">
                {{
                  chunkMode === 'preview'
                    ? '当前预览没有生成片段，请检查文档内容或调整参数。'
                    : selectedDocument.status === 'ready'
                      ? '此文档没有可展示的内容片段。'
                      : '处理成功后才会读取内容片段。'
                }}
              </p>
            </div>
            <div v-else class="chunk-list">
              <div class="chunk-count muted">
                共 {{ visibleChunks.length }} 个片段 · 当前显示 {{ chunkFirst + 1 }}～{{
                  Math.min(chunkFirst + chunkRows, visibleChunks.length)
                }}
              </div>
              <article
                v-for="(chunk, index) in pagedChunks"
                :key="`${chunkMode}-${chunk.id}-${chunk.version}`"
                class="chunk-card"
              >
                <header>
                  <strong>片段 {{ chunkFirst + index + 1 }}</strong
                  ><span>{{ Array.from(chunk.content).length }} 字符</span>
                </header>
                <div class="chunk-meta">
                  <span>源序号 {{ chunk.index }}</span
                  ><span>版本 {{ chunk.version }}</span
                  ><span>{{ chunk.page === null ? '无页码信息' : `第 ${chunk.page} 页` }}</span
                  ><span v-if="chunk.section">{{ chunk.section }}</span>
                </div>
                <p class="chunk-content">{{ chunk.content }}</p>
              </article>
              <Paginator
                v-if="visibleChunks.length > chunkRows"
                :first="chunkFirst"
                :rows="chunkRows"
                :total-records="visibleChunks.length"
                :rows-per-page-options="[5, 10, 20]"
                template="PrevPageLink PageLinks NextPageLink RowsPerPageDropdown"
                aria-label="文档片段分页"
                @page="onChunkPage"
              />
            </div>
          </template>
        </aside>
      </div>
      <KnowledgeRetrievalPanel :knowledge-base-id="kbId" />
    </template>

    <Dialog
      v-model:visible="deleteVisible"
      modal
      header="删除文档"
      :style="{ width: '460px', maxWidth: '95vw' }"
      :closable="!deleting"
      :close-on-escape="!deleting"
      :draggable="false"
      ><p class="dialog-copy">
        确定删除“<strong>{{ deleteTarget?.name }}</strong
        >”？
      </p>
      <p class="muted">文档及其内容片段将被删除，无法撤销。历史对话中的相关引用可能失效。</p>
      <div v-if="deleteError" class="error-banner" role="alert">{{ deleteError }}</div>
      <template #footer
        ><Button
          label="取消"
          severity="secondary"
          outlined
          :disabled="deleting"
          @click="deleteVisible = false" /><Button
          label="确认删除"
          icon="pi pi-trash"
          severity="danger"
          :loading="deleting"
          @click="confirmDelete" /></template
    ></Dialog>
    <Dialog
      v-model:visible="processVisible"
      modal
      :header="processTarget?.status === 'failed' ? '确认重试处理' : '确认重新处理'"
      :style="{ width: '520px', maxWidth: '95vw' }"
      :closable="!processSubmitting"
      :close-on-escape="!processSubmitting"
      :draggable="false"
      ><p class="dialog-copy">
        文档：<strong>{{ processTarget?.name }}</strong>
      </p>
      <dl class="process-summary">
        <div>
          <dt>切分长度</dt>
          <dd>{{ processTarget?.chunkSize }} → {{ processConfig?.chunkSize }} 字符</dd>
        </div>
        <div>
          <dt>重叠长度</dt>
          <dd>{{ processTarget?.chunkOverlap }} → {{ processConfig?.chunkOverlap }} 字符</dd>
        </div>
      </dl>
      <p class="muted">
        提交参数后请等待处理成功，新版本才会生效；不会把本次预览直接覆盖为正式片段。
      </p>
      <p v-if="isMock || processTarget?.simulated" class="preview-warning">
        Mock 模式：TXT / MD 重新切分实际正文，PDF / DOCX 仍为占位内容；上传处理阶段模拟，
        此流程不调用模型、不建立真实向量索引。local 检索时才按需进行本地 CPU 向量计算。
      </p>
      <div v-if="processError" class="error-banner" role="alert">{{ processError }}</div>
      <template #footer
        ><Button
          label="取消"
          severity="secondary"
          outlined
          :disabled="processSubmitting"
          @click="processVisible = false" /><Button
          :label="processTarget?.status === 'failed' ? '提交重试' : '开始重新处理'"
          icon="pi pi-sync"
          :loading="processSubmitting"
          @click="confirmProcess" /></template
    ></Dialog>
  </section>
</template>

<style scoped>
.knowledge-detail {
  display: grid;
  gap: 1.35rem;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  width: fit-content;
  color: #64748b;
  text-decoration: none;
  font-size: 0.875rem;
}
.back-link:hover {
  color: #2563eb;
}
.page-header {
  align-items: flex-start;
}
.detail-heading {
  min-width: 0;
}
.detail-heading h1 {
  margin: 0.3rem 0 0.65rem;
  overflow-wrap: anywhere;
}
.detail-heading > p:last-child {
  max-width: 900px;
  line-height: 1.65;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mock-notice,
.success-notice,
.processing-notice {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem;
  border-radius: 10px;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  color: #1e40af;
  font-size: 0.875rem;
  line-height: 1.6;
}
.mock-notice i,
.processing-notice > i {
  margin-top: 0.3rem;
}
.mock-notice p,
.processing-notice p {
  margin: 0.25rem 0 0;
}
.success-notice {
  background: #f0fdf4;
  border-color: #bbf7d0;
  color: #166534;
}
.detail-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
}
.detail-stats .stat-card {
  display: grid;
  gap: 0.65rem;
  padding: 1.2rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}
.stat-card > span {
  font-size: 0.8125rem;
}
.stat-card > strong {
  font-size: 1.8rem;
  font-weight: 650;
  line-height: 1.2;
  color: #0f172a;
}
.stat-card > small {
  font-size: 0.75rem;
}
.stat-divider {
  color: #cbd5e1;
  font-weight: 400;
}
.upload-panel,
.documents-panel,
.preview-panel {
  padding: 1.25rem;
  border: 1px solid #e2e8f0;
  background: #fff;
  border-radius: 12px;
  min-width: 0;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  margin-bottom: 1.1rem;
}
.section-heading h2 {
  margin: 0;
  font-size: 1.05rem;
  color: #0f172a;
}
.section-heading p {
  margin: 0.4rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.5;
}
.section-heading .eyebrow {
  margin: 0 0 0.4rem;
  font-size: 0.7rem;
}
.native-file {
  display: none;
}
.drop-zone {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.35rem;
  border: 1px dashed #cbd5e1;
  background: #f8fafc;
  border-radius: 10px;
  transition:
    background 0.15s,
    border-color 0.15s;
}
.drop-zone.dragging {
  border-color: #3b82f6;
  background: #eff6ff;
}
.drop-zone > i {
  font-size: 2rem;
  color: #3b82f6;
}
.drop-zone > div {
  flex: 1;
}
.drop-zone strong {
  font-size: 0.9rem;
}
.drop-zone p {
  margin: 0.5rem 0 0;
  font-size: 0.8125rem;
}
.file-errors {
  display: block;
  padding: 1rem 1rem 1rem 2rem;
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
.upload-queue {
  margin-top: 1rem;
}
.queue-heading,
.upload-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 0;
}
.queue-heading {
  flex-wrap: wrap;
  font-size: 0.8125rem;
}
.upload-row {
  border-top: 1px solid #f1f5f9;
}
.upload-info {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 0.4rem;
}
.upload-info > strong {
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
.upload-info p {
  margin: 0.3rem 0;
  font-size: 0.8125rem;
}
.upload-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 0.4rem;
  flex-wrap: wrap;
  max-width: 45%;
}
.transfer-progress {
  max-width: 360px;
  display: grid;
  gap: 0.4rem;
  font-size: 0.75rem;
  color: #64748b;
}
.transfer-progress :deep(.p-progressbar) {
  height: 5px;
}
.queue-note {
  font-size: 0.75rem;
  line-height: 1.6;
  margin-bottom: 0;
}
.document-workspace {
  display: grid;
  grid-template-columns: minmax(340px, 0.95fr) minmax(390px, 1.05fr);
  align-items: start;
  gap: 1.25rem;
}
.document-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 130px;
  gap: 0.6rem;
}
.document-toolbar :deep(.p-inputtext) {
  width: 100%;
  min-width: 0;
}
.poll-state {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  margin: 1rem 0;
  line-height: 1.5;
}
.document-list {
  display: grid;
  gap: 0.85rem;
}
.document-card {
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  padding: 0.95rem;
  min-width: 0;
}
.document-card.selected {
  border-color: #60a5fa;
  background: #f8fbff;
  box-shadow: inset 3px 0 #3b82f6;
}
.document-select {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 0;
  width: 100%;
  color: inherit;
  cursor: pointer;
  font: inherit;
}
.document-select:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 5px;
  border-radius: 4px;
}
.file-mark {
  display: grid;
  place-items: center;
  min-width: 40px;
  height: 44px;
  border: 1px solid #dbeafe;
  background: #eff6ff;
  color: #2563eb;
  border-radius: 7px;
  font-size: 0.65rem;
  font-weight: 700;
}
.document-title {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 0.4rem;
}
.document-title strong {
  overflow-wrap: anywhere;
  font-size: 0.875rem;
}
.document-title small {
  color: #64748b;
  font-size: 0.7rem;
}
.selected-check {
  color: #2563eb;
}
.document-badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.85rem;
}
.document-badges small {
  font-size: 0.65rem;
  margin-left: auto;
}
.pipeline {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  list-style: none;
  padding: 0;
  margin: 1.05rem 0;
}
.pipeline li {
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
  gap: 0.45rem;
  color: #94a3b8;
  font-size: 0.65rem;
}
.pipeline li:not(:last-child)::after {
  content: '';
  position: absolute;
  left: calc(50% + 6px);
  right: calc(-50% + 6px);
  top: 4px;
  height: 1px;
  background: #e2e8f0;
}
.stage-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #e2e8f0;
}
.pipeline .stage-done {
  color: #15803d;
}
.stage-done .stage-dot {
  background: #22c55e;
}
.pipeline .stage-done::after {
  background: #86efac;
}
.pipeline .stage-active {
  color: #2563eb;
  font-weight: 600;
}
.stage-active .stage-dot {
  background: #3b82f6;
  box-shadow: 0 0 0 3px #dbeafe;
}
.pipeline .stage-unknown {
  color: #94a3b8;
}
.processing-progress > div:first-child {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.4rem;
  font-size: 0.7rem;
  color: #64748b;
}
.processing-progress :deep(.p-progressbar) {
  height: 5px;
}
.failed-progress :deep(.p-progressbar-value) {
  background: #ef4444;
}
.document-error {
  color: #b91c1c;
  background: #fef2f2;
  border-radius: 6px;
  padding: 0.6rem;
  margin: 0.75rem 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.document-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.15rem;
  margin-top: 0.65rem;
}
.selected-summary {
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 0.9rem;
  margin-bottom: 1rem;
}
.selected-summary h3 {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  overflow-wrap: anywhere;
}
.selected-summary p {
  margin: 0.65rem 0 0;
  font-size: 0.75rem;
}
.config-form {
  display: grid;
  gap: 0.85rem;
  padding: 0.9rem;
  background: #f8fafc;
  border-radius: 8px;
  margin-bottom: 1rem;
}
.config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.8rem;
}
.config-grid .field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}
.config-grid label {
  font-size: 0.8125rem;
}
.config-grid small {
  font-size: 0.7rem;
}
.config-grid :deep(.p-inputnumber-input) {
  width: 100%;
}
.button-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.config-note {
  font-size: 0.75rem;
  line-height: 1.6;
  margin: 0;
}
.chunk-tabs {
  display: flex;
  gap: 0.5rem;
  margin: 1.15rem 0 0.85rem;
  flex-wrap: wrap;
}
.preview-warning {
  padding: 0.7rem 0.85rem;
  font-size: 0.75rem;
  line-height: 1.6;
  color: #92400e;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 7px;
}
.chunk-list {
  display: grid;
  gap: 0.85rem;
}
.chunk-count {
  font-size: 0.75rem;
}
.chunk-card {
  padding: 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  min-width: 0;
}
.chunk-card > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.chunk-card > header span {
  color: #64748b;
  font-size: 0.7rem;
}
.chunk-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin: 0.6rem 0;
  color: #64748b;
  font-size: 0.65rem;
  overflow-wrap: anywhere;
}
.chunk-meta > span {
  background: #f1f5f9;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}
.chunk-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0.8rem 0 0;
  font-size: 0.8125rem;
  line-height: 1.85;
  color: #334155;
  max-height: 440px;
  overflow-y: auto;
}
.preview-panel :deep(.p-paginator) {
  padding: 0.5rem 0 0;
  flex-wrap: wrap;
  gap: 0.2rem;
}
.error-copy {
  color: #b91c1c;
  overflow-wrap: anywhere;
}
.error-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.65rem;
  font-size: 0.8125rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.dialog-copy {
  overflow-wrap: anywhere;
}
.process-summary {
  display: grid;
  gap: 0.75rem;
  padding: 1rem;
  border-radius: 8px;
  background: #f8fafc;
  font-size: 0.875rem;
}
.process-summary > div {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
}
.process-summary dt {
  color: #64748b;
}
.process-summary dd {
  margin: 0;
}
.small-spinner {
  width: 34px;
  height: 34px;
}
.empty-icon {
  font-size: 2rem;
  color: #94a3b8;
}
.document-empty,
.preview-empty {
  padding: 3rem 1rem;
}
.chunk-empty,
.chunk-loading {
  padding: 2rem 1rem;
}
@media (min-width: 1500px) {
  .document-workspace {
    grid-template-columns: minmax(380px, 0.8fr) minmax(500px, 1.2fr);
  }
}
@media (max-width: 1100px) {
  .document-workspace {
    grid-template-columns: minmax(0, 1fr);
  }
  .document-list {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
  }
}
@media (max-width: 680px) {
  .detail-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.65rem;
  }
  .detail-stats .stat-card {
    padding: 0.9rem;
  }
  .drop-zone {
    flex-wrap: wrap;
    padding: 1rem;
  }
  .drop-zone > div {
    flex-basis: calc(100% - 55px);
  }
  .drop-zone > button {
    width: 100%;
  }
  .upload-row {
    align-items: flex-start;
    flex-direction: column;
  }
  .upload-actions {
    max-width: 100%;
  }
  .upload-info {
    width: 100%;
  }
  .upload-panel,
  .documents-panel,
  .preview-panel {
    padding: 1rem;
  }
  .config-grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .document-toolbar {
    grid-template-columns: minmax(0, 1fr);
  }
  .queue-heading .button-row {
    width: 100%;
  }
}
</style>
