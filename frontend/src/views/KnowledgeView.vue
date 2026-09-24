<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import Dialog from 'primevue/dialog'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Textarea from 'primevue/textarea'
import Select from 'primevue/select'
import Tag from 'primevue/tag'
import ProgressSpinner from 'primevue/progressspinner'
import { api, isMock } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { KnowledgeBase, KnowledgeInput, Model } from '@/types'

type KnowledgeForm = Omit<KnowledgeInput, 'chunkSize' | 'chunkOverlap'> & {
  chunkSize: number | null
  chunkOverlap: number | null
}
const emptyForm = (): KnowledgeForm => ({
  name: '',
  description: '',
  embeddingModelId: '',
  rerankModelId: '',
  chunkSize: 500,
  chunkOverlap: 50,
})
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : '请求失败，请稍后重试。'

export default defineComponent({
  name: 'KnowledgeView',
  components: { Button, Dialog, InputText, InputNumber, Textarea, Select, Tag, ProgressSpinner },
  data() {
    return {
      auth: useAuthStore(),
      isMock,
      knowledgeBases: [] as KnowledgeBase[],
      models: [] as Model[],
      search: '',
      loading: false,
      loadError: '',
      modelsError: '',
      success: '',
      counts: {} as Record<string, number>,
      countErrors: {} as Record<string, string>,
      dialogVisible: false,
      editing: null as KnowledgeBase | null,
      form: emptyForm(),
      formErrors: {} as Record<string, string>,
      formError: '',
      saving: false,
      checkingDocuments: false,
      checkedDocumentCount: null as number | null,
      documentCheckError: '',
      formSession: 0,
      deleteTarget: null as KnowledgeBase | null,
      deleteVisible: false,
      deleting: false,
      deleteError: '',
      alive: true,
      loadRequest: 0,
    }
  },
  computed: {
    visibleKnowledge(): KnowledgeBase[] {
      const query = this.search.trim().toLocaleLowerCase()
      return this.knowledgeBases.filter(
        (kb) =>
          (this.auth.isAdmin || kb.ownerId === this.auth.user?.id) &&
          (!query || `${kb.name} ${kb.description}`.toLocaleLowerCase().includes(query)),
      )
    },
    availableModels(): Model[] {
      return this.models.filter(
        (model) =>
          model.enabled && (this.auth.isAdmin || !!this.auth.user?.modelIds.includes(model.id)),
      )
    },
    embeddingOptions(): { label: string; value: string }[] {
      const options = this.availableModels
        .filter((model) => model.type === 'embedding')
        .map((model) => ({ label: model.name, value: model.id }))
      if (
        this.editing &&
        !options.some((option) => option.value === this.editing?.embeddingModelId)
      ) {
        options.unshift({
          label: `${this.modelName(this.editing.embeddingModelId)}（保留当前配置）`,
          value: this.editing.embeddingModelId,
        })
      }
      return options
    },
    rerankOptions(): { label: string; value: string }[] {
      const options = this.availableModels
        .filter((model) => model.type === 'rerank')
        .map((model) => ({ label: model.name, value: model.id }))
      if (
        this.editing?.rerankModelId &&
        !options.some((option) => option.value === this.editing?.rerankModelId)
      ) {
        options.unshift({
          label: `${this.modelName(this.editing.rerankModelId)}（保留当前配置）`,
          value: this.editing.rerankModelId,
        })
      }
      return [{ label: '不使用 Rerank', value: '' }, ...options]
    },
    embeddingLocked(): boolean {
      return (
        !!this.editing &&
        (this.checkingDocuments ||
          this.checkedDocumentCount === null ||
          this.checkedDocumentCount > 0)
      )
    },
    totalCount(): number {
      return this.knowledgeBases.filter(
        (kb) => this.auth.isAdmin || kb.ownerId === this.auth.user?.id,
      ).length
    },
  },
  mounted() {
    void this.load()
  },
  beforeUnmount() {
    this.alive = false
    this.loadRequest++
    this.formSession++
  },
  methods: {
    canManage(kb: KnowledgeBase): boolean {
      return this.auth.isAdmin || kb.ownerId === this.auth.user?.id
    },
    modelName(id: string): string {
      return this.models.find((model) => model.id === id)?.name || '模型不可用或未授权'
    },
    date(value: string): string {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '日期未知' : date.toLocaleDateString('zh-CN')
    },
    async load() {
      const request = ++this.loadRequest
      this.loading = true
      this.loadError = ''
      this.modelsError = ''
      const [knowledge, models] = await Promise.allSettled([api.knowledgeBases(), api.models()])
      if (!this.alive || request !== this.loadRequest) return
      if (knowledge.status === 'fulfilled') {
        this.knowledgeBases = knowledge.value.filter((kb) => this.canManage(kb))
        this.counts = {}
        this.countErrors = {}
      } else this.loadError = errorMessage(knowledge.reason)
      if (models.status === 'fulfilled') this.models = models.value
      else {
        this.models = []
        this.modelsError = errorMessage(models.reason)
      }
      this.loading = false
      if (knowledge.status === 'fulfilled') {
        await Promise.all(
          this.knowledgeBases.map(async (kb) => {
            try {
              const documents = await api.documents(kb.id)
              if (
                this.alive &&
                request === this.loadRequest &&
                this.knowledgeBases.some((item) => item.id === kb.id)
              )
                this.counts[kb.id] = documents.length
            } catch (error) {
              if (this.alive && request === this.loadRequest)
                this.countErrors[kb.id] = errorMessage(error)
            }
          }),
        )
      }
    },
    async openForm(kb?: KnowledgeBase) {
      if (!this.auth.user || (kb && !this.canManage(kb))) return
      this.formSession++
      this.editing = kb || null
      this.form = kb
        ? {
            name: kb.name,
            description: kb.description,
            embeddingModelId: kb.embeddingModelId,
            rerankModelId: kb.rerankModelId,
            chunkSize: kb.chunkSize,
            chunkOverlap: kb.chunkOverlap,
          }
        : emptyForm()
      this.formError = ''
      this.formErrors = {}
      this.documentCheckError = ''
      this.checkedDocumentCount = null
      this.checkingDocuments = false
      this.dialogVisible = true
      if (kb) await this.checkDocuments()
    },
    async checkDocuments() {
      const kb = this.editing
      if (!kb) return
      const session = this.formSession
      this.checkingDocuments = true
      this.documentCheckError = ''
      this.checkedDocumentCount = null
      try {
        const documents = await api.documents(kb.id)
        if (!this.alive || session !== this.formSession || !this.dialogVisible) return
        this.checkedDocumentCount = documents.length
        this.counts[kb.id] = documents.length
        delete this.countErrors[kb.id]
        if (documents.length) this.form.embeddingModelId = kb.embeddingModelId
      } catch (error) {
        if (this.alive && session === this.formSession)
          this.documentCheckError = errorMessage(error)
      } finally {
        if (this.alive && session === this.formSession) this.checkingDocuments = false
      }
    },
    validate(): KnowledgeInput | null {
      const errors: Record<string, string> = {}
      const name = this.form.name.trim()
      if (!name) errors.name = '请输入知识库名称。'
      if (name.length > 100) errors.name = '名称不能超过 100 个字符。'
      if (!this.form.embeddingModelId) errors.embeddingModelId = '必须选择 Embedding 模型。'
      else if (
        this.form.embeddingModelId !== this.editing?.embeddingModelId &&
        !this.availableModels.some(
          (model) => model.id === this.form.embeddingModelId && model.type === 'embedding',
        )
      ) {
        errors.embeddingModelId = '请选择已启用且获授权的 Embedding 模型。'
      }
      if (
        this.form.rerankModelId &&
        this.form.rerankModelId !== this.editing?.rerankModelId &&
        !this.availableModels.some(
          (model) => model.id === this.form.rerankModelId && model.type === 'rerank',
        )
      ) {
        errors.rerankModelId = '请选择已启用且获授权的 Rerank 模型，或不使用重排。'
      }
      const size = this.form.chunkSize
      const overlap = this.form.chunkOverlap
      if (size === null || !Number.isInteger(size) || size < 50 || size > 4000)
        errors.chunkSize = '切分长度必须为 50～4000 的整数。'
      if (
        overlap === null ||
        !Number.isInteger(overlap) ||
        overlap < 0 ||
        size === null ||
        overlap >= size
      )
        errors.chunkOverlap = '重叠长度必须为非负整数，且小于切分长度。'
      this.formErrors = errors
      if (Object.keys(errors).length || size === null || overlap === null) return null
      return {
        name,
        description: this.form.description.trim(),
        embeddingModelId: this.form.embeddingModelId,
        rerankModelId: this.form.rerankModelId,
        chunkSize: size,
        chunkOverlap: overlap,
      }
    },
    async save() {
      if (this.saving || !this.auth.user || (this.editing && !this.canManage(this.editing))) return
      const input = this.validate()
      if (!input) return
      this.saving = true
      this.formError = ''
      this.success = ''
      try {
        if (this.editing && input.embeddingModelId !== this.editing.embeddingModelId) {
          const documents = await api.documents(this.editing.id)
          if (!this.alive) return
          this.checkedDocumentCount = documents.length
          if (documents.length) {
            this.form.embeddingModelId = this.editing.embeddingModelId
            throw new Error('知识库已有文档，不能更换 Embedding 模型。已恢复原模型。')
          }
        }
        const saved = await api.saveKnowledge(input, this.editing?.id)
        if (!this.alive) return
        const index = this.knowledgeBases.findIndex((kb) => kb.id === saved.id)
        if (index >= 0) this.knowledgeBases.splice(index, 1, saved)
        else {
          this.knowledgeBases.unshift(saved)
          this.counts[saved.id] = 0
        }
        this.dialogVisible = false
        this.success = this.editing
          ? '知识库配置已更新。已有文档须在详情页显式重新处理后应用新切分参数。'
          : '知识库已创建，可以进入详情上传文档。'
      } catch (error) {
        if (this.alive) this.formError = errorMessage(error)
      } finally {
        if (this.alive) this.saving = false
      }
    },
    askDelete(kb: KnowledgeBase) {
      if (!this.canManage(kb)) return
      this.deleteTarget = kb
      this.deleteError = ''
      this.deleteVisible = true
    },
    async removeKnowledge() {
      const target = this.deleteTarget
      if (!target || !this.canManage(target) || this.deleting) return
      this.deleting = true
      this.deleteError = ''
      this.success = ''
      try {
        await api.deleteKnowledge(target.id)
        if (!this.alive) return
        this.knowledgeBases = this.knowledgeBases.filter((kb) => kb.id !== target.id)
        delete this.counts[target.id]
        delete this.countErrors[target.id]
        this.deleteVisible = false
        this.success = `已删除知识库“${target.name}”。`
      } catch (error) {
        if (this.alive) this.deleteError = errorMessage(error)
      } finally {
        if (this.alive) this.deleting = false
      }
    },
  },
})
</script>

<template>
  <section class="knowledge-view">
    <header class="page-header">
      <div>
        <p class="eyebrow">KNOWLEDGE LIBRARY</p>
        <h1>知识库</h1>
        <p class="muted">将团队文档整理为可检索的知识，为对话提供有据可循的上下文。</p>
      </div>
      <Button
        label="新建知识库"
        icon="pi pi-plus"
        :disabled="!auth.user || loading"
        @click="openForm()"
      />
    </header>
    <div v-if="isMock" class="mock-notice" role="note">
      <i class="pi pi-info-circle" aria-hidden="true" /><span
        ><strong>演示模式</strong> · 文档解析、向量化和入库为模拟能力，不调用真实模型；PDF / Word
        使用示例文本，请勿上传敏感文件。</span
      >
    </div>
    <div v-if="success" class="success-notice" role="status">{{ success }}</div>
    <div v-if="loadError" class="error-banner" role="alert">
      <span>{{ loadError }}</span
      ><Button label="重新加载" size="small" :loading="loading" @click="load" />
    </div>
    <div v-if="modelsError" class="error-banner" role="alert">
      <span>模型列表加载失败：{{ modelsError }}。当前无法选择新模型。</span
      ><Button label="重试加载" size="small" :loading="loading" @click="load" />
    </div>
    <div class="toolbar library-toolbar">
      <div class="search-box">
        <i class="pi pi-search" aria-hidden="true" /><InputText
          v-model="search"
          aria-label="搜索知识库名称或描述"
          placeholder="搜索知识库名称、描述…"
        />
      </div>
      <div class="toolbar-tail">
        <span class="muted">共 {{ totalCount }} 个知识库</span
        ><Button
          icon="pi pi-refresh"
          label="刷新"
          severity="secondary"
          outlined
          :loading="loading"
          :disabled="saving || deleting"
          @click="load"
        />
      </div>
    </div>
    <div v-if="loading" class="empty-state" role="status">
      <ProgressSpinner class="small-spinner" aria-label="正在加载知识库" />
      <p>正在加载知识库…</p>
    </div>
    <div v-else-if="!visibleKnowledge.length && !loadError" class="empty-state panel">
      <i class="pi pi-folder-open empty-icon" aria-hidden="true" />
      <h2>{{ search ? '没有匹配的知识库' : '从第一份知识开始' }}</h2>
      <p class="muted">
        {{
          search
            ? '试试其他关键词，或清除当前搜索。'
            : '创建知识库，选择 Embedding 模型，然后上传你的团队文档。'
        }}
      </p>
      <Button v-if="search" label="清除搜索" severity="secondary" @click="search = ''" />
      <Button
        v-else
        label="创建知识库"
        icon="pi pi-plus"
        :disabled="!auth.user"
        @click="openForm()"
      />
    </div>
    <div v-else class="knowledge-grid">
      <article v-for="kb in visibleKnowledge" :key="kb.id" class="panel knowledge-card">
        <div class="card-top">
          <div class="folder-mark"><i class="pi pi-folder" aria-hidden="true" /></div>
          <Tag
            :value="kb.ownerId === auth.user?.id ? '我的知识库' : '管理员治理'"
            severity="secondary"
          />
        </div>
        <h2>
          <RouterLink :to="{ path: `/knowledge/${encodeURIComponent(kb.id)}` }">{{
            kb.name
          }}</RouterLink>
        </h2>
        <p class="card-description muted">
          {{ kb.description || '暂无描述。进入知识库开始整理文档。' }}
        </p>
        <dl class="card-meta">
          <div>
            <dt>Embedding</dt>
            <dd>{{ modelName(kb.embeddingModelId) }}</dd>
          </div>
          <div>
            <dt>Rerank</dt>
            <dd>{{ kb.rerankModelId ? modelName(kb.rerankModelId) : '未启用' }}</dd>
          </div>
          <div>
            <dt>切分 / 重叠</dt>
            <dd>{{ kb.chunkSize }} / {{ kb.chunkOverlap }} 字符</dd>
          </div>
        </dl>
        <div class="card-footnote">
          <span v-if="counts[kb.id] !== undefined">{{ counts[kb.id] }} 份文档</span
          ><span v-else-if="countErrors[kb.id]" class="count-warning" :title="countErrors[kb.id]"
            >文档数加载失败，请刷新</span
          ><span v-else>文档数加载中…</span
          ><time :datetime="kb.createdAt">{{ date(kb.createdAt) }}</time>
        </div>
        <div class="card-actions">
          <RouterLink class="open-link" :to="{ path: `/knowledge/${encodeURIComponent(kb.id)}` }"
            >打开知识库 <i class="pi pi-arrow-right" aria-hidden="true"
          /></RouterLink>
          <div v-if="canManage(kb)" class="button-row">
            <Button
              icon="pi pi-pencil"
              severity="secondary"
              text
              :aria-label="`编辑 ${kb.name}`"
              @click="openForm(kb)"
            /><Button
              icon="pi pi-trash"
              severity="danger"
              text
              :aria-label="`删除 ${kb.name}`"
              @click="askDelete(kb)"
            />
          </div>
        </div>
      </article>
    </div>

    <Dialog
      v-model:visible="dialogVisible"
      modal
      :header="editing ? '管理知识库' : '创建知识库'"
      :style="{ width: '640px', maxWidth: '95vw' }"
      :closable="!saving"
      :close-on-escape="!saving"
      :draggable="false"
    >
      <form class="knowledge-form" @submit.prevent="save">
        <div v-if="formError" class="error-banner" role="alert">{{ formError }}</div>
        <div v-if="modelsError" class="error-banner" role="alert">
          模型信息暂不可用，请关闭弹窗后重试加载。已保存的模型配置可以保留。
        </div>
        <div class="field">
          <label for="kb-name">知识库名称 <span class="required">*</span></label
          ><InputText
            id="kb-name"
            v-model="form.name"
            :disabled="saving"
            :invalid="!!formErrors.name"
            maxlength="100"
            autocomplete="off"
            :aria-describedby="formErrors.name ? 'kb-name-error' : undefined"
          /><small v-if="formErrors.name" id="kb-name-error" class="field-error">{{
            formErrors.name
          }}</small>
        </div>
        <div class="field">
          <label for="kb-description">描述</label
          ><Textarea
            id="kb-description"
            v-model="form.description"
            :disabled="saving"
            :rows="3"
            auto-resize
            placeholder="这份知识库收录什么内容？"
          />
        </div>
        <div class="form-grid">
          <div class="field">
            <label for="kb-embedding">Embedding 模型 <span class="required">*</span></label
            ><Select
              v-model="form.embeddingModelId"
              input-id="kb-embedding"
              :options="embeddingOptions"
              option-label="label"
              option-value="value"
              placeholder="必选，用于文档向量化"
              :disabled="saving || embeddingLocked || !!modelsError"
              :invalid="!!formErrors.embeddingModelId"
            /><small v-if="formErrors.embeddingModelId" class="field-error">{{
              formErrors.embeddingModelId
            }}</small
            ><small v-if="!embeddingOptions.length && !modelsError" class="field-error"
              >暂无可用 Embedding 模型，请联系管理员启用并授权。</small
            >
          </div>
          <div class="field">
            <label for="kb-rerank">Rerank 模型</label
            ><Select
              v-model="form.rerankModelId"
              input-id="kb-rerank"
              :options="rerankOptions"
              option-label="label"
              option-value="value"
              :disabled="saving || !!modelsError"
              :invalid="!!formErrors.rerankModelId"
            /><small v-if="formErrors.rerankModelId" class="field-error">{{
              formErrors.rerankModelId
            }}</small>
          </div>
        </div>
        <p v-if="checkingDocuments" class="muted" role="status">
          正在检查已有文档，暂不可更换 Embedding 模型…
        </p>
        <div v-else-if="documentCheckError" class="error-banner" role="alert">
          <span>无法检查文档，已锁定 Embedding 模型：{{ documentCheckError }}</span
          ><Button
            label="重新检查"
            size="small"
            severity="secondary"
            :disabled="saving"
            @click="checkDocuments"
          />
        </div>
        <p v-else-if="editing && embeddingLocked" class="lock-notice">
          <i class="pi pi-lock" aria-hidden="true" /> 已有
          {{ checkedDocumentCount }} 份文档，禁止更换 Embedding 模型，以避免索引维度不一致。
        </p>
        <div class="form-grid">
          <div class="field">
            <label for="kb-chunk-size">默认切分长度</label
            ><InputNumber
              v-model="form.chunkSize"
              input-id="kb-chunk-size"
              :use-grouping="false"
              :max-fraction-digits="0"
              :disabled="saving"
              :invalid="!!formErrors.chunkSize"
            /><small class="muted">50～4000 字符，非 Token 数。</small
            ><small v-if="formErrors.chunkSize" class="field-error">{{
              formErrors.chunkSize
            }}</small>
          </div>
          <div class="field">
            <label for="kb-overlap">默认重叠长度</label
            ><InputNumber
              v-model="form.chunkOverlap"
              input-id="kb-overlap"
              :use-grouping="false"
              :max-fraction-digits="0"
              :disabled="saving"
              :invalid="!!formErrors.chunkOverlap"
            /><small class="muted">至少为 0，且小于切分长度。</small
            ><small v-if="formErrors.chunkOverlap" class="field-error">{{
              formErrors.chunkOverlap
            }}</small>
          </div>
        </div>
        <p v-if="editing" class="muted">
          默认参数用于新上传文档；已有文档请在详情页预览并确认重新处理。
        </p>
        <div class="button-row dialog-actions">
          <Button
            label="取消"
            severity="secondary"
            outlined
            :disabled="saving"
            @click="dialogVisible = false"
          /><Button
            type="submit"
            :label="editing ? '保存配置' : '创建知识库'"
            :loading="saving"
            :disabled="checkingDocuments"
          />
        </div>
      </form>
    </Dialog>

    <Dialog
      v-model:visible="deleteVisible"
      modal
      header="删除知识库"
      :style="{ width: '460px', maxWidth: '95vw' }"
      :closable="!deleting"
      :close-on-escape="!deleting"
      :draggable="false"
    >
      <p class="delete-copy">
        确认删除“<strong>{{ deleteTarget?.name }}</strong
        >”？
      </p>
      <p class="muted">此操作不可撤销，库内文档、片段及索引将被移除，相关历史引用可能失效。</p>
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
          @click="removeKnowledge"
      /></template>
    </Dialog>
  </section>
</template>

<style scoped>
.knowledge-view {
  display: grid;
  gap: 1.4rem;
}
.page-header h1 {
  margin: 0.25rem 0 0.6rem;
}
.mock-notice,
.success-notice {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  color: #1e40af;
  padding: 0.85rem 1rem;
  border-radius: 10px;
  font-size: 0.875rem;
  line-height: 1.65;
}
.mock-notice > i {
  margin-top: 0.3rem;
}
.success-notice {
  background: #f0fdf4;
  border-color: #bbf7d0;
  color: #166534;
}
.library-toolbar,
.toolbar-tail,
.card-top,
.card-actions,
.card-footnote {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.library-toolbar {
  flex-wrap: wrap;
}
.search-box {
  display: flex;
  align-items: center;
  position: relative;
  width: min(100%, 390px);
}
.search-box > i {
  position: absolute;
  left: 0.85rem;
  color: #64748b;
  z-index: 1;
}
.search-box :deep(input) {
  width: 100%;
  padding-left: 2.5rem;
}
.toolbar-tail {
  flex-wrap: wrap;
  font-size: 0.875rem;
}
.knowledge-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 1.2rem;
}
.knowledge-card {
  padding: 1.35rem;
  display: flex;
  flex-direction: column;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  background: #fff;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  min-width: 0;
}
.knowledge-card:hover {
  border-color: #93c5fd;
  box-shadow: 0 4px 14px #0f172a08;
}
.folder-mark {
  width: 42px;
  height: 42px;
  display: grid;
  place-items: center;
  background: #eff6ff;
  color: #2563eb;
  border-radius: 10px;
  font-size: 1.25rem;
}
.knowledge-card h2 {
  font-size: 1.1rem;
  margin: 1rem 0 0.55rem;
  overflow-wrap: anywhere;
}
.knowledge-card h2 a {
  color: #0f172a;
  text-decoration: none;
}
.knowledge-card h2 a:hover {
  color: #2563eb;
}
.card-description {
  margin: 0 0 1.3rem;
  min-height: 2.8rem;
  line-height: 1.6;
  font-size: 0.875rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.card-meta {
  display: grid;
  gap: 0.7rem;
  margin: auto 0 1.2rem;
  font-size: 0.8125rem;
}
.card-meta > div {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr);
  gap: 0.5rem;
}
.card-meta dt {
  color: #64748b;
}
.card-meta dd {
  margin: 0;
  text-align: right;
  overflow-wrap: anywhere;
  color: #334155;
}
.card-footnote {
  font-size: 0.75rem;
  color: #64748b;
  flex-wrap: wrap;
}
.card-actions {
  margin-top: 1rem;
  padding-top: 0.8rem;
  border-top: 1px solid #f1f5f9;
}
.open-link {
  color: #2563eb;
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
}
.knowledge-form {
  display: grid;
  gap: 1.2rem;
  padding-top: 0.4rem;
}
.knowledge-form .field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  min-width: 0;
}
.knowledge-form .form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}
.knowledge-form :deep(.p-inputnumber-input) {
  width: 100%;
}
.field-error,
.required {
  color: #b91c1c;
}
.lock-notice {
  padding: 0.8rem;
  background: #f8fafc;
  border-radius: 8px;
  color: #475569;
  font-size: 0.8125rem;
  line-height: 1.6;
  margin: 0;
}
.count-warning {
  color: #a16207;
}
.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.6rem;
  margin-top: 0.5rem;
}
.small-spinner {
  width: 36px;
  height: 36px;
}
.empty-icon {
  font-size: 2.5rem;
  color: #94a3b8;
}
.delete-copy {
  overflow-wrap: anywhere;
}
.error-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.6rem;
}
@media (max-width: 600px) {
  .knowledge-form .form-grid {
    grid-template-columns: 1fr;
  }
  .toolbar-tail,
  .search-box {
    width: 100%;
  }
  .knowledge-card {
    padding: 1rem;
  }
}
</style>
