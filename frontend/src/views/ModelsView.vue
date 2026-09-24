<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import Dialog from 'primevue/dialog'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import Textarea from 'primevue/textarea'
import ToggleSwitch from 'primevue/toggleswitch'
import { api, isMock } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { Model, ModelInput, ModelType } from '@/types'

const typeOptions = [
  { label: '对话模型', value: 'chat' },
  { label: '向量模型', value: 'embedding' },
  { label: '重排模型', value: 'rerank' },
]
function newForm() {
  return {
    name: '',
    type: 'chat' as ModelType,
    provider: '',
    baseUrl: '',
    modelName: '',
    description: '',
    dimension: '',
    enabled: true,
    apiKey: '',
    clearApiKey: false,
  }
}
function errorText(error: unknown): string {
  const response = error as {
    response?: { data?: { error?: { message?: string } } }
    message?: string
  } | null
  return response?.response?.data?.error?.message || response?.message || '请求失败，请稍后重试。'
}
function modelInput(model: Model): ModelInput {
  return {
    name: model.name,
    type: model.type,
    provider: model.provider,
    baseUrl: model.baseUrl,
    modelName: model.modelName,
    description: model.description,
    enabled: model.enabled,
    dimension: model.dimension,
  }
}

export default defineComponent({
  name: 'ModelsView',
  components: { Button, InputText, Select, Dialog, DataTable, Column, Tag, Textarea, ToggleSwitch },
  data() {
    return {
      auth: useAuthStore(),
      isMock,
      typeOptions,
      statusOptions: [
        { label: '已启用', value: 'enabled' },
        { label: '已停用', value: 'disabled' },
      ],
      models: [] as Model[],
      loading: true,
      loaded: false,
      requestVersion: 0,
      search: '',
      typeFilter: null as ModelType | null,
      statusFilter: null as string | null,
      first: 0,
      rows: 10,
      error: '',
      success: '',
      busyId: '',
      busyAction: '',
      toggleRevision: 0,
      dialogVisible: false,
      editingId: undefined as string | undefined,
      existingHasKey: false,
      form: newForm(),
      formErrors: {} as Record<string, string>,
      formError: '',
      saving: false,
      testResult: null as {
        id: string
        name: string
        message: string
        latency: number | null
      } | null,
    }
  },
  computed: {
    accessibleModels(): Model[] {
      return this.auth.isAdmin
        ? this.models
        : this.models.filter(
            (model) => model.enabled && this.auth.user?.modelIds.includes(model.id),
          )
    },
    filteredModels(): Model[] {
      const query = this.search.trim().toLocaleLowerCase()
      return this.accessibleModels.filter(
        (model) =>
          (!this.typeFilter || model.type === this.typeFilter) &&
          (!this.statusFilter || model.enabled === (this.statusFilter === 'enabled')) &&
          (!query ||
            [model.name, model.modelName, model.provider, model.description, model.baseUrl].some(
              (value) => value.toLocaleLowerCase().includes(query),
            )),
      )
    },
    enabledCount(): number {
      return this.accessibleModels.filter((model) => model.enabled).length
    },
    hasFilters(): boolean {
      return !!(this.search.trim() || this.typeFilter || this.statusFilter)
    },
    actionLocked(): boolean {
      return this.loading || this.saving || !!this.busyId
    },
  },
  watch: {
    search() {
      this.first = 0
    },
    typeFilter() {
      this.first = 0
    },
    statusFilter() {
      this.first = 0
    },
    rows() {
      this.first = 0
    },
    'form.clearApiKey'(clear: boolean) {
      if (clear) this.form.apiKey = ''
    },
    'auth.isAdmin'(isAdmin: boolean) {
      if (!isAdmin) {
        this.dialogVisible = false
        this.testResult = null
        this.clearForm()
      }
    },
  },
  mounted() {
    void this.loadModels()
  },
  beforeUnmount() {
    this.requestVersion += 1
    this.form.apiKey = ''
  },
  methods: {
    typeLabel(type: ModelType): string {
      return typeOptions.find((option) => option.value === type)?.label || type
    },
    typeSeverity(type: ModelType): 'info' | 'success' | 'warn' {
      return type === 'chat' ? 'info' : type === 'embedding' ? 'success' : 'warn'
    },
    formatDate(value: string): string {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN')
    },
    resetFilters() {
      this.search = ''
      this.typeFilter = null
      this.statusFilter = null
      this.first = 0
    },
    clampPage() {
      const lastPage = Math.max(0, Math.ceil(this.filteredModels.length / this.rows) - 1)
      this.first = Math.min(this.first, lastPage * this.rows)
    },
    async loadModels() {
      if (this.saving || this.busyId) return
      const version = ++this.requestVersion
      this.loading = true
      this.error = ''
      this.loaded = false
      this.models = []
      this.testResult = null
      try {
        const models = await api.models()
        if (version !== this.requestVersion) return
        this.models = models
        this.loaded = true
        this.clampPage()
      } catch (error) {
        if (version === this.requestVersion) this.error = `加载模型失败：${errorText(error)}`
      } finally {
        if (version === this.requestVersion) this.loading = false
      }
    },
    clearForm() {
      this.form.apiKey = ''
      this.form = newForm()
      this.formError = ''
      this.formErrors = {}
      this.editingId = undefined
      this.existingHasKey = false
    },
    openCreate() {
      if (!this.auth.isAdmin || this.actionLocked || !this.loaded) return
      this.clearForm()
      this.dialogVisible = true
    },
    openEdit(model: Model) {
      if (!this.auth.isAdmin || this.actionLocked) return
      this.clearForm()
      this.editingId = model.id
      this.existingHasKey = model.hasApiKey
      this.form = {
        name: model.name,
        type: model.type,
        provider: model.provider,
        baseUrl: model.baseUrl,
        modelName: model.modelName,
        description: model.description,
        dimension: model.dimension === undefined ? '' : String(model.dimension),
        enabled: model.enabled,
        apiKey: '',
        clearApiKey: false,
      }
      this.dialogVisible = true
    },
    closeDialog() {
      if (!this.saving) {
        this.dialogVisible = false
        this.clearForm()
      }
    },
    validateForm(): boolean {
      const errors: Record<string, string> = {}
      if (!this.form.name.trim()) errors.name = '请输入模型显示名称。'
      else if (this.form.name.trim().length > 100) errors.name = '显示名称不能超过 100 个字符。'
      if (!typeOptions.some((option) => option.value === this.form.type))
        errors.type = '请选择有效的模型类型。'
      if (!this.form.provider.trim()) errors.provider = '请输入服务提供方。'
      else if (this.form.provider.trim().length > 100)
        errors.provider = '提供方名称不能超过 100 个字符。'
      if (!this.form.modelName.trim()) errors.modelName = '请输入供应商提供的模型 identifier。'
      else if (this.form.modelName.trim().length > 200)
        errors.modelName = '模型 identifier 不能超过 200 个字符。'
      if (!this.form.baseUrl.trim()) errors.baseUrl = '请输入服务基础地址。'
      else {
        try {
          const url = new URL(this.form.baseUrl.trim())
          if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
            errors.baseUrl = '请输入有效的 HTTP 或 HTTPS 地址。'
          else if (url.username || url.password || url.hash)
            errors.baseUrl = '地址不能包含用户名、密码或片段标识。'
        } catch {
          errors.baseUrl = '请输入完整地址，例如 https://api.example.com/v1。'
        }
      }
      if (this.form.type === 'embedding' && this.form.dimension.trim()) {
        const dimension = Number(this.form.dimension)
        if (!Number.isSafeInteger(dimension) || dimension <= 0)
          errors.dimension = '向量维度必须为正整数。'
      }
      if (this.form.description.length > 1000) errors.description = '描述不能超过 1000 个字符。'
      if (!this.isMock && this.form.apiKey && !this.form.apiKey.trim())
        errors.apiKey = '密钥不能仅包含空格。'
      this.formErrors = errors
      return Object.keys(errors).length === 0
    },
    async submitModel() {
      if (!this.auth.isAdmin || this.saving || this.busyId || this.loading) return
      this.formError = ''
      if (!this.validateForm()) return
      const editingId = this.editingId
      const input: ModelInput = {
        name: this.form.name.trim(),
        type: this.form.type,
        provider: this.form.provider.trim(),
        baseUrl: this.form.baseUrl.trim(),
        modelName: this.form.modelName.trim(),
        description: this.form.description.trim(),
        enabled: this.form.enabled,
        dimension:
          this.form.type === 'embedding' && this.form.dimension.trim()
            ? Number(this.form.dimension)
            : undefined,
      }
      if (!this.isMock) {
        if (this.form.clearApiKey) input.clearApiKey = true
        else if (this.form.apiKey.trim()) input.apiKey = this.form.apiKey.trim()
      }
      this.saving = true
      this.error = ''
      this.success = ''
      try {
        const pending = api.saveModel(input, editingId)
        this.form.apiKey = ''
        const saved = await pending
        this.models = editingId
          ? this.models.map((model) => (model.id === editingId ? saved : model))
          : [saved, ...this.models]
        this.success = editingId ? `模型“${saved.name}”已更新。` : `模型“${saved.name}”已创建。`
        this.testResult = null
        this.clampPage()
        this.dialogVisible = false
        this.clearForm()
      } catch (error) {
        this.formError = `${errorText(error)}${input.apiKey ? ' 密钥输入已清空，如需重试请重新输入。' : ''}`
      } finally {
        this.form.apiKey = ''
        delete input.apiKey
        this.saving = false
      }
    },
    async toggleModel(model: Model) {
      if (!this.auth.isAdmin || this.actionLocked) return
      this.busyId = model.id
      this.busyAction = 'toggle'
      this.error = ''
      this.success = ''
      try {
        const saved = await api.saveModel(
          { ...modelInput(model), enabled: !model.enabled },
          model.id,
        )
        this.models = this.models.map((item) => (item.id === model.id ? saved : item))
        this.success = `模型“${saved.name}”已${saved.enabled ? '启用' : '停用'}。`
        if (this.testResult?.id === model.id) this.testResult = null
        this.clampPage()
      } catch (error) {
        this.error = `更新模型状态失败：${errorText(error)}`
      } finally {
        this.toggleRevision += 1
        this.busyId = ''
        this.busyAction = ''
      }
    },
    async deleteModel(model: Model) {
      if (!this.auth.isAdmin || this.actionLocked) return
      if (
        !window.confirm(
          `确定删除模型“${model.name}”？此操作不可撤销；存在资源引用时，服务端可能拒绝删除。`,
        )
      )
        return
      this.busyId = model.id
      this.busyAction = 'delete'
      this.error = ''
      this.success = ''
      try {
        await api.deleteModel(model.id)
        this.models = this.models.filter((item) => item.id !== model.id)
        if (this.testResult?.id === model.id) this.testResult = null
        this.success = `模型“${model.name}”已删除。`
        this.clampPage()
      } catch (error) {
        this.error = `删除模型失败：${errorText(error)}`
      } finally {
        this.busyId = ''
        this.busyAction = ''
      }
    },
    async testConnection(model: Model) {
      if (!this.auth.isAdmin || this.actionLocked) return
      this.busyId = model.id
      this.busyAction = 'test'
      this.error = ''
      this.success = ''
      this.testResult = null
      try {
        const result = await api.testModel(model.id)
        this.testResult = {
          id: model.id,
          name: model.name,
          message: result.message,
          latency: Number.isFinite(result.latency) && result.latency >= 0 ? result.latency : null,
        }
      } catch (error) {
        this.error = `模型“${model.name}”连接测试失败：${errorText(error)}`
      } finally {
        this.busyId = ''
        this.busyAction = ''
      }
    },
  },
})
</script>

<template>
  <div class="models-view">
    <header class="page-header">
      <div>
        <span class="eyebrow">工作空间 / 模型资源</span>
        <h1>模型管理</h1>
        <p class="muted">
          {{
            auth.isAdmin
              ? '统一接入模型服务，管理团队的智能能力。'
              : '浏览已授予你的可用模型，选择适合任务的能力。'
          }}
        </p>
      </div>
      <div class="button-row">
        <Button
          label="刷新"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          :loading="loading"
          :disabled="saving || !!busyId"
          @click="loadModels"
        /><Button
          v-if="auth.isAdmin"
          label="添加模型"
          icon="pi pi-plus"
          :disabled="actionLocked || !loaded"
          @click="openCreate"
        />
      </div>
    </header>
    <div v-if="isMock" class="notice mock-notice" role="note">
      <i class="pi pi-info-circle" aria-hidden="true"></i
      ><span
        >演示模式：连接测试为模拟结果，不会请求真实模型。密钥输入已禁用，请勿在任何字段填写真实密钥或敏感信息。</span
      >
    </div>
    <div v-if="!auth.isAdmin" class="notice readonly-notice">
      <i class="pi pi-lock" aria-hidden="true"></i
      ><span>只读视图 · 仅展示已启用且授权给你的模型。模型配置与连接测试由管理员操作。</span>
    </div>
    <div v-if="error" class="error-banner feedback" role="alert">
      <span>{{ error }}</span
      ><Button
        v-if="!loaded"
        label="重试"
        severity="danger"
        text
        :disabled="actionLocked"
        @click="loadModels"
      /><Button
        v-else
        icon="pi pi-times"
        severity="danger"
        text
        rounded
        aria-label="关闭错误提示"
        @click="error = ''"
      />
    </div>
    <div v-if="success" class="success-notice feedback" role="status">
      <span><i class="pi pi-check-circle" aria-hidden="true"></i> {{ success }}</span
      ><Button
        icon="pi pi-times"
        text
        rounded
        severity="success"
        aria-label="关闭成功提示"
        @click="success = ''"
      />
    </div>
    <div v-if="testResult" class="test-result" role="status">
      <div class="test-result-icon"><i class="pi pi-link" aria-hidden="true"></i></div>
      <div class="test-result-copy">
        <strong>{{ isMock ? '模拟连接测试结果' : '连接测试结果' }} · {{ testResult.name }}</strong>
        <p>{{ testResult.message }}</p>
        <span v-if="testResult.latency !== null" class="muted"
          >{{ isMock ? '模拟耗时' : '本次测试耗时' }}：{{
            testResult.latency.toLocaleString('zh-CN')
          }}
          ms</span
        ><span v-if="isMock" class="muted"> · 不代表真实连通性</span>
      </div>
      <Button
        icon="pi pi-times"
        text
        rounded
        severity="secondary"
        aria-label="关闭连接测试结果"
        @click="testResult = null"
      />
    </div>

    <section class="panel models-panel" aria-label="模型列表" :aria-busy="loading">
      <div class="list-heading">
        <div>
          <h2>
            模型目录 <span class="count-badge">{{ loaded ? accessibleModels.length : '—' }}</span>
          </h2>
          <p class="muted">
            {{
              loaded
                ? `${enabledCount} 个已启用，${accessibleModels.length - enabledCount} 个已停用`
                : loading
                  ? '正在获取当前可访问的模型'
                  : '模型目录暂不可用，请重试'
            }}
          </p>
        </div>
        <span class="muted list-hint">模型 identifier 保持供应商原文</span>
      </div>
      <div class="toolbar models-toolbar">
        <div class="search-control">
          <i class="pi pi-search" aria-hidden="true"></i
          ><InputText
            v-model="search"
            placeholder="搜索名称、identifier、提供方…"
            aria-label="搜索模型"
          />
        </div>
        <Select
          v-model="typeFilter"
          :options="typeOptions"
          option-label="label"
          option-value="value"
          show-clear
          placeholder="全部类型"
          aria-label="按模型类型筛选"
          class="filter-control"
        />
        <Select
          v-model="statusFilter"
          :options="statusOptions"
          option-label="label"
          option-value="value"
          show-clear
          placeholder="全部状态"
          aria-label="按启停状态筛选"
          class="filter-control"
        />
        <Button
          v-if="hasFilters"
          label="清除筛选"
          icon="pi pi-filter-slash"
          text
          severity="secondary"
          @click="resetFilters"
        />
      </div>
      <div v-if="hasFilters && loaded" class="filter-count muted" role="status">
        找到 {{ filteredModels.length }} 个匹配模型
      </div>
      <DataTable
        v-model:first="first"
        v-model:rows="rows"
        :value="filteredModels"
        data-key="id"
        :loading="loading"
        paginator
        :rows-per-page-options="[10, 20, 50]"
        paginator-template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink CurrentPageReport RowsPerPageDropdown"
        current-page-report-template="第 {first}–{last} 条，共 {totalRecords} 条"
        :table-style="{ minWidth: auth.isAdmin ? '1040px' : '860px' }"
        scrollable
        striped-rows
        removable-sort
      >
        <template #empty
          ><div class="empty-state table-empty">
            <i
              :class="!loaded && !loading ? 'pi pi-exclamation-circle' : 'pi pi-box'"
              aria-hidden="true"
            ></i>
            <h3>
              {{
                loading
                  ? '正在加载模型…'
                  : !loaded
                    ? '模型加载失败'
                    : hasFilters
                      ? '没有匹配的模型'
                      : '暂无可访问模型'
              }}
            </h3>
            <p class="muted">
              {{
                loading
                  ? '正在读取当前账号可访问的模型，请稍候。'
                  : !loaded
                    ? '请稍后重试，或检查当前账号权限。'
                    : hasFilters
                      ? '试试其他关键词，或清除筛选条件。'
                      : auth.isAdmin
                        ? '接入第一个模型，为团队启用智能能力。'
                        : '请联系管理员分配模型使用权限。'
              }}
            </p>
            <Button v-if="!loading && !loaded" label="重新加载" text @click="loadModels" /><Button
              v-else-if="hasFilters && !loading"
              label="清除筛选"
              text
              @click="resetFilters"
            /><Button
              v-else-if="auth.isAdmin && !loading"
              label="添加模型"
              icon="pi pi-plus"
              :disabled="actionLocked || !loaded"
              @click="openCreate"
            /></div
        ></template>
        <Column field="name" header="模型" sortable style="min-width: 240px; max-width: 310px"
          ><template #body="{ data }"
            ><div class="model-name-cell">
              <span class="model-avatar" :class="data.type"
                ><i
                  :class="
                    data.type === 'chat'
                      ? 'pi pi-comments'
                      : data.type === 'embedding'
                        ? 'pi pi-th-large'
                        : 'pi pi-sort-amount-down'
                  "
                  aria-hidden="true"
                ></i
              ></span>
              <div class="model-text">
                <strong>{{ data.name }}</strong
                ><code>{{ data.modelName }}</code>
              </div>
            </div>
            <p v-if="data.description" class="model-description muted" :title="data.description">
              {{ data.description }}
            </p></template
          ></Column
        >
        <Column field="type" header="类型" sortable style="min-width: 110px"
          ><template #body="{ data }"
            ><Tag :value="typeLabel(data.type)" :severity="typeSeverity(data.type)" /><small
              v-if="data.type === 'embedding' && data.dimension"
              class="dimension muted"
              >{{ data.dimension }} 维</small
            ></template
          ></Column
        >
        <Column
          field="provider"
          header="提供方 / 服务地址"
          sortable
          style="min-width: 210px; max-width: 280px"
          ><template #body="{ data }"
            ><div class="provider-cell">
              <strong>{{ data.provider }}</strong
              ><span class="muted endpoint">{{ data.baseUrl }}</span>
            </div></template
          ></Column
        >
        <Column field="enabled" header="状态" sortable style="min-width: 125px"
          ><template #body="{ data }"
            ><div class="status-cell">
              <ToggleSwitch
                v-if="auth.isAdmin"
                :key="`${data.id}-${toggleRevision}`"
                :model-value="data.enabled"
                :disabled="actionLocked"
                :aria-label="`${data.enabled ? '停用' : '启用'}模型 ${data.name}`"
                @update:model-value="toggleModel(data)"
              /><Tag
                :value="
                  busyId === data.id && busyAction === 'toggle'
                    ? '更新中'
                    : data.enabled
                      ? '已启用'
                      : '已停用'
                "
                :severity="data.enabled ? 'success' : 'secondary'"
              /></div></template
        ></Column>
        <Column header="凭据" style="min-width: 115px"
          ><template #body="{ data }"
            ><span class="credential-status" :class="{ configured: data.hasApiKey }"
              ><i
                :class="data.hasApiKey ? 'pi pi-lock' : 'pi pi-minus-circle'"
                aria-hidden="true"
              ></i
              >{{ data.hasApiKey ? '已配置密钥' : '未配置密钥' }}</span
            ></template
          ></Column
        >
        <Column field="createdAt" header="创建日期" sortable style="min-width: 110px"
          ><template #body="{ data }"
            ><span class="muted date-cell">{{ formatDate(data.createdAt) }}</span></template
          ></Column
        >
        <Column
          v-if="auth.isAdmin"
          header="操作"
          frozen
          align-frozen="right"
          style="min-width: 146px"
          ><template #body="{ data }"
            ><div class="row-actions">
              <Button
                icon="pi pi-pencil"
                text
                rounded
                severity="secondary"
                :disabled="actionLocked"
                :aria-label="`编辑模型 ${data.name}`"
                title="编辑模型"
                @click="openEdit(data)"
              /><Button
                icon="pi pi-link"
                text
                rounded
                :loading="busyId === data.id && busyAction === 'test'"
                :disabled="actionLocked"
                :aria-label="`测试模型 ${data.name} 的连接`"
                title="连接测试"
                @click="testConnection(data)"
              /><Button
                icon="pi pi-trash"
                text
                rounded
                severity="danger"
                :loading="busyId === data.id && busyAction === 'delete'"
                :disabled="actionLocked"
                :aria-label="`删除模型 ${data.name}`"
                title="删除模型"
                @click="deleteModel(data)"
              /></div></template
        ></Column>
      </DataTable>
      <div class="table-footnote muted">
        <i class="pi pi-info-circle" aria-hidden="true"></i>
        启用状态不代表服务健康；连接测试由业务服务端执行。{{
          auth.isAdmin ? '资源引用冲突与访问地址安全策略由服务端校验。' : ''
        }}
      </div>
    </section>

    <Dialog
      v-model:visible="dialogVisible"
      modal
      :header="editingId ? '编辑模型' : '添加模型'"
      :style="{ width: '680px', maxWidth: 'calc(100vw - 2rem)' }"
      :closable="!saving"
      :close-on-escape="!saving"
      :draggable="false"
      @hide="clearForm"
    >
      <form
        id="model-editor-form"
        class="model-form"
        novalidate
        :aria-busy="saving"
        @submit.prevent="submitModel"
      >
        <p class="dialog-intro muted">
          {{
            editingId
              ? '更新接入配置。已保存的密钥不会返回或回显。'
              : '配置兼容服务地址与模型标识，连接由服务端统一转发。'
          }}
          标有 * 的字段为必填。
        </p>
        <div v-if="formError" class="error-banner" role="alert">{{ formError }}</div>
        <div class="form-grid model-form-grid">
          <div class="field">
            <label for="model-display-name">显示名称 *</label
            ><InputText
              id="model-display-name"
              v-model="form.name"
              autofocus
              :disabled="saving"
              :invalid="!!formErrors.name"
              :aria-invalid="!!formErrors.name"
              aria-describedby="model-name-error"
              maxlength="100"
              placeholder="例如：团队通用对话模型"
            /><small v-if="formErrors.name" id="model-name-error" class="field-error">{{
              formErrors.name
            }}</small>
          </div>
          <div class="field">
            <label for="model-type">模型类型 *</label
            ><Select
              v-model="form.type"
              input-id="model-type"
              :options="typeOptions"
              option-label="label"
              option-value="value"
              :disabled="saving"
              :invalid="!!formErrors.type"
              aria-describedby="model-type-error"
            /><small v-if="formErrors.type" id="model-type-error" class="field-error">{{
              formErrors.type
            }}</small>
          </div>
          <div class="field">
            <label for="model-provider">服务提供方 *</label
            ><InputText
              id="model-provider"
              v-model="form.provider"
              :disabled="saving"
              :invalid="!!formErrors.provider"
              aria-describedby="model-provider-error"
              maxlength="100"
              placeholder="例如：OpenAI、内部推理服务"
            /><small v-if="formErrors.provider" id="model-provider-error" class="field-error">{{
              formErrors.provider
            }}</small>
          </div>
          <div class="field">
            <label for="model-identifier">模型 identifier *</label
            ><InputText
              id="model-identifier"
              v-model="form.modelName"
              :disabled="saving"
              :invalid="!!formErrors.modelName"
              aria-describedby="model-identifier-help model-identifier-error"
              maxlength="200"
              placeholder="例如：gpt-4.1-mini"
              spellcheck="false"
            /><small id="model-identifier-help" class="muted"
              >与供应商标识完全一致，不翻译、不改变大小写。</small
            ><small v-if="formErrors.modelName" id="model-identifier-error" class="field-error">{{
              formErrors.modelName
            }}</small>
          </div>
          <div class="field full-width">
            <label for="model-base-url">服务基础地址 *</label
            ><InputText
              id="model-base-url"
              v-model="form.baseUrl"
              type="url"
              :disabled="saving"
              :invalid="!!formErrors.baseUrl"
              aria-describedby="model-url-help model-url-error"
              placeholder="https://api.example.com/v1"
              spellcheck="false"
            /><small id="model-url-help" class="muted"
              >请勿在地址中放入密钥。生产环境使用 HTTPS；地址允许列表由服务端校验。</small
            ><small v-if="formErrors.baseUrl" id="model-url-error" class="field-error">{{
              formErrors.baseUrl
            }}</small>
          </div>
          <div v-if="form.type === 'embedding'" class="field">
            <label for="model-dimension">向量维度</label
            ><InputText
              id="model-dimension"
              v-model="form.dimension"
              type="number"
              min="1"
              step="1"
              :disabled="saving"
              :invalid="!!formErrors.dimension"
              aria-describedby="model-dimension-help model-dimension-error"
              placeholder="可选，例如 1536"
            /><small id="model-dimension-help" class="muted"
              >需与实际模型输出一致；留空由服务端处理。</small
            ><small v-if="formErrors.dimension" id="model-dimension-error" class="field-error">{{
              formErrors.dimension
            }}</small>
          </div>
          <div class="field full-width">
            <label for="model-description">描述</label
            ><Textarea
              id="model-description"
              v-model="form.description"
              rows="3"
              auto-resize
              :disabled="saving"
              :invalid="!!formErrors.description"
              aria-describedby="model-description-error"
              maxlength="1000"
              placeholder="适用场景、使用建议或配置备注"
            /><small
              v-if="formErrors.description"
              id="model-description-error"
              class="field-error"
              >{{ formErrors.description }}</small
            >
          </div>
        </div>
        <section class="credential-section" aria-label="模型密钥设置">
          <div class="credential-heading">
            <strong><i class="pi pi-shield" aria-hidden="true"></i> 访问凭据</strong
            ><Tag
              :value="existingHasKey ? '已配置，仅可替换或清除' : '未配置'"
              :severity="existingHasKey ? 'success' : 'secondary'"
            />
          </div>
          <p v-if="isMock" class="mock-key-note">
            演示模式禁止输入真实密钥，此字段已禁用，提交时不会发送密钥。
          </p>
          <div class="field">
            <label for="model-api-key">{{ existingHasKey ? '替换密钥' : 'API 密钥（可选）' }}</label
            ><InputText
              id="model-api-key"
              v-model="form.apiKey"
              type="password"
              autocomplete="new-password"
              :disabled="saving || isMock || form.clearApiKey"
              :invalid="!!formErrors.apiKey"
              aria-describedby="model-key-help model-key-error"
              :placeholder="
                isMock
                  ? '演示模式不可输入密钥'
                  : existingHasKey
                    ? '留空保留原密钥'
                    : '无鉴权服务可留空'
              "
            /><small id="model-key-help" class="muted"
              >仅通过业务 API
              提交，不回显、不持久化；发送后立即清空输入，失败重试需重新填写。</small
            ><small v-if="formErrors.apiKey" id="model-key-error" class="field-error">{{
              formErrors.apiKey
            }}</small>
          </div>
          <div v-if="existingHasKey" class="switch-row">
            <ToggleSwitch
              v-model="form.clearApiKey"
              input-id="model-clear-key"
              :disabled="saving || isMock"
            /><label for="model-clear-key">清除已保存的密钥</label>
          </div>
          <small v-if="form.clearApiKey" class="field-error"
            >保存后将移除服务端密钥，可能导致模型无法使用。</small
          >
        </section>
        <div class="switch-row enable-row">
          <ToggleSwitch v-model="form.enabled" input-id="model-enabled" :disabled="saving" />
          <div>
            <label for="model-enabled">启用模型</label
            ><small class="muted">停用后，普通用户将无法使用此模型。</small>
          </div>
        </div>
      </form>
      <template #footer
        ><Button
          label="取消"
          severity="secondary"
          outlined
          :disabled="saving"
          @click="closeDialog" /><Button
          :label="editingId ? '保存修改' : '创建模型'"
          icon="pi pi-check"
          type="submit"
          form="model-editor-form"
          :loading="saving"
          :disabled="!auth.isAdmin"
      /></template>
    </Dialog>
  </div>
</template>

<style scoped>
.models-view {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.page-header h1 {
  margin: 0.4rem 0;
}
.page-header p {
  margin: 0;
}
.notice {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
  border: 1px solid #dbeafe;
  background: #eff6ff;
  border-radius: 10px;
  padding: 0.85rem 1rem;
  color: #1e40af;
  font-size: 0.82rem;
  line-height: 1.6;
}
.notice i {
  margin-top: 0.22rem;
}
.readonly-notice {
  background: #f8fafc;
  border-color: #e2e8f0;
  color: #475569;
}
.feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  overflow-wrap: anywhere;
}
.feedback > span {
  min-width: 0;
}
.feedback :deep(button) {
  flex-shrink: 0;
}
.success-notice {
  background: #f0fdf4;
  color: #166534;
  border: 1px solid #bbf7d0;
  border-radius: 10px;
  padding: 0.6rem 1rem;
  font-size: 0.85rem;
}
.test-result {
  display: flex;
  align-items: flex-start;
  gap: 0.9rem;
  padding: 1rem 1.2rem;
  background: #fff;
  border: 1px solid #bfdbfe;
  border-radius: 12px;
}
.test-result-icon {
  background: #eff6ff;
  color: #2563eb;
  border-radius: 10px;
  padding: 0.7rem;
}
.test-result-copy {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  overflow-wrap: anywhere;
}
.test-result-copy p {
  margin: 0.5rem 0;
}
.test-result-copy > span {
  font-size: 0.78rem;
}
.models-panel {
  overflow: hidden;
  padding: 0;
  min-width: 0;
}
.list-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding: 1.5rem 1.5rem 1rem;
}
.list-heading h2 {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin: 0;
  font-size: 1rem;
  color: #1e293b;
}
.list-heading p {
  font-size: 0.78rem;
  margin: 0.45rem 0 0;
}
.list-hint {
  font-size: 0.75rem;
}
.count-badge {
  display: inline-grid;
  place-items: center;
  min-width: 25px;
  height: 23px;
  padding: 0 0.4rem;
  border-radius: 6px;
  background: #eff6ff;
  color: #2563eb;
  font-size: 0.75rem;
  font-weight: 600;
}
.models-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding: 0.25rem 1.5rem 1.25rem;
  border-bottom: 1px solid #e9eef5;
}
.search-control {
  position: relative;
  flex: 1;
  min-width: 230px;
}
.search-control > i {
  position: absolute;
  left: 0.85rem;
  top: 50%;
  transform: translateY(-50%);
  color: #94a3b8;
  z-index: 1;
}
.search-control :deep(input) {
  width: 100%;
  padding-left: 2.4rem;
}
.filter-control {
  min-width: 155px;
}
.filter-count {
  font-size: 0.8rem;
  padding: 0.75rem 1.5rem 0;
}
.model-name-cell {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}
.model-avatar {
  flex: 0 0 37px;
  height: 37px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #2563eb;
  background: #eff6ff;
}
.model-avatar.embedding {
  color: #0f766e;
  background: #f0fdfa;
}
.model-avatar.rerank {
  color: #9333ea;
  background: #faf5ff;
}
.model-text {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
}
.model-text strong {
  color: #1e293b;
  font-weight: 600;
  font-size: 0.87rem;
  overflow-wrap: anywhere;
}
.model-text code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.75rem;
  color: #64748b;
  overflow-wrap: anywhere;
}
.model-description {
  font-size: 0.74rem;
  line-height: 1.5;
  margin: 0.6rem 0 0;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dimension {
  display: block;
  margin-top: 0.4rem;
  font-size: 0.74rem;
}
.provider-cell {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.provider-cell strong {
  font-size: 0.82rem;
  font-weight: 500;
  overflow-wrap: anywhere;
}
.endpoint {
  font-size: 0.74rem;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.status-cell {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.credential-status {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.74rem;
  color: #94a3b8;
}
.credential-status.configured {
  color: #64748b;
}
.credential-status i {
  font-size: 0.7rem;
}
.date-cell {
  font-size: 0.75rem;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 0.05rem;
}
.table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 3.5rem 1rem;
}
.table-empty > i {
  font-size: 2rem;
  color: #a7b5c8;
  margin-bottom: 0.8rem;
}
.table-empty h3 {
  font-size: 1rem;
  margin: 0.5rem 0;
  color: #475569;
}
.table-empty p {
  font-size: 0.85rem;
  margin: 0.3rem 0 1rem;
}
.table-footnote {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 1rem 1.5rem;
  border-top: 1px solid #eef2f6;
  font-size: 0.75rem;
  line-height: 1.6;
}
.model-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.dialog-intro {
  font-size: 0.82rem;
  line-height: 1.7;
  margin: 0;
}
.model-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.2rem;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  min-width: 0;
}
.field label {
  font-size: 0.85rem;
  font-weight: 500;
  color: #334155;
}
.field :deep(input),
.field :deep(textarea),
.field :deep(.p-select) {
  width: 100%;
}
.field small {
  font-size: 0.75rem;
  line-height: 1.6;
}
.full-width {
  grid-column: 1 / -1;
}
.field-error {
  color: #b91c1c;
  font-size: 0.75rem;
  line-height: 1.6;
}
.credential-section {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  background: #f8fafc;
  padding: 1rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}
.credential-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.credential-heading strong {
  font-size: 0.85rem;
  color: #475569;
}
.credential-heading i {
  margin-right: 0.4rem;
}
.mock-key-note {
  padding: 0.7rem;
  margin: 0;
  background: #fffbeb;
  color: #92400e;
  border-radius: 6px;
  font-size: 0.78rem;
  line-height: 1.6;
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: 0.85rem;
}
.switch-row label {
  cursor: pointer;
}
.switch-row small {
  display: block;
  margin-top: 0.3rem;
  font-size: 0.75rem;
}
.enable-row {
  border-top: 1px solid #e2e8f0;
  padding-top: 1rem;
}
:deep(.p-datatable-thead > tr > th) {
  font-size: 0.77rem;
  padding-top: 0.85rem;
  padding-bottom: 0.85rem;
}
:deep(.p-datatable-tbody > tr > td) {
  padding-top: 1rem;
  padding-bottom: 1rem;
}
:deep(.p-paginator) {
  font-size: 0.8rem;
  gap: 0.25rem;
  padding: 1rem;
}
@media (max-width: 760px) {
  .list-hint {
    display: none;
  }
  .models-toolbar {
    padding: 0.25rem 1rem 1rem;
  }
  .list-heading {
    padding: 1.25rem 1rem 1rem;
  }
  .search-control {
    flex-basis: 100%;
  }
  .filter-control {
    flex: 1;
    min-width: 130px;
  }
  .table-footnote {
    padding: 1rem;
  }
  .feedback {
    align-items: flex-start;
  }
}
@media (max-width: 540px) {
  .model-form-grid {
    grid-template-columns: 1fr;
  }
  .model-form-grid .full-width {
    grid-column: auto;
  }
  .credential-heading {
    align-items: flex-start;
  }
  .test-result {
    padding: 0.85rem;
  }
  .test-result-icon {
    display: none;
  }
}
</style>
