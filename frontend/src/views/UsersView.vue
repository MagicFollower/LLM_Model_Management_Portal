<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Dialog from 'primevue/dialog'
import DataTable from 'primevue/datatable'
import Column from 'primevue/column'
import Tag from 'primevue/tag'
import ToggleSwitch from 'primevue/toggleswitch'
import { api, isMock } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { User, UserInput, Model, ModelType, Role } from '@/types'

const roleOptions = [
  { label: '普通用户', value: 'user' },
  { label: '管理员', value: 'admin' },
]
function newForm() {
  return {
    username: '',
    name: '',
    role: 'user' as Role,
    enabled: true,
    modelIds: [] as string[],
    password: '',
    passwordConfirm: '',
  }
}
function errorText(error: unknown): string {
  const response = error as {
    response?: { data?: { error?: { message?: string } } }
    message?: string
  } | null
  return response?.response?.data?.error?.message || response?.message || '请求失败，请稍后重试。'
}
function userInput(user: User): UserInput {
  return {
    username: user.username,
    name: user.name,
    role: user.role,
    enabled: user.enabled,
    modelIds: [...user.modelIds],
  }
}

export default defineComponent({
  name: 'UsersView',
  components: {
    Button,
    InputText,
    Select,
    MultiSelect,
    Dialog,
    DataTable,
    Column,
    Tag,
    ToggleSwitch,
  },
  data() {
    return {
      auth: useAuthStore(),
      isMock,
      roleOptions,
      statusOptions: [
        { label: '已启用', value: 'enabled' },
        { label: '已停用', value: 'disabled' },
      ],
      users: [] as User[],
      models: [] as Model[],
      loading: true,
      loaded: false,
      modelsLoaded: false,
      requestVersion: 0,
      error: '',
      modelError: '',
      success: '',
      busyId: '',
      busyAction: '',
      toggleRevision: 0,
      search: '',
      roleFilter: null as Role | null,
      statusFilter: null as string | null,
      first: 0,
      rows: 10,
      dialogVisible: false,
      editingId: undefined as string | undefined,
      form: newForm(),
      formErrors: {} as Record<string, string>,
      formError: '',
      saving: false,
      resetVisible: false,
      resetTarget: null as User | null,
      newPassword: '',
      confirmPassword: '',
      resetError: '',
      resetErrors: {} as Record<string, string>,
      resetSaving: false,
    }
  },
  computed: {
    canManage(): boolean {
      return this.auth.isAdmin && !!this.auth.user?.enabled
    },
    filteredUsers(): User[] {
      const query = this.search.trim().toLocaleLowerCase()
      return this.users.filter(
        (user) =>
          (!this.roleFilter || user.role === this.roleFilter) &&
          (!this.statusFilter || user.enabled === (this.statusFilter === 'enabled')) &&
          (!query ||
            [user.username, user.name].some((value) => value.toLocaleLowerCase().includes(query))),
      )
    },
    enabledCount(): number {
      return this.users.filter((user) => user.enabled).length
    },
    adminCount(): number {
      return this.users.filter((user) => user.role === 'admin' && user.enabled).length
    },
    hasFilters(): boolean {
      return !!(this.search.trim() || this.roleFilter || this.statusFilter)
    },
    actionLocked(): boolean {
      return this.loading || this.saving || this.resetSaving || !!this.busyId
    },
    editorLocked(): boolean {
      return this.actionLocked || !this.loaded || !this.modelsLoaded
    },
    modelOptions(): { id: string; label: string }[] {
      const options = this.models.map((model) => ({
        id: model.id,
        label: `${model.name} · ${this.typeLabel(model.type)}${model.enabled ? '' : '（已停用）'}`,
      }))
      const knownIds = new Set(options.map((option) => option.id))
      this.form.modelIds.forEach((id) => {
        if (!knownIds.has(id)) {
          options.push({ id, label: `不可用模型（${id}）` })
          knownIds.add(id)
        }
      })
      return options
    },
  },
  watch: {
    search() {
      this.first = 0
    },
    roleFilter() {
      this.first = 0
    },
    statusFilter() {
      this.first = 0
    },
    rows() {
      this.first = 0
    },
    canManage(allowed: boolean) {
      if (!allowed) {
        this.requestVersion += 1
        this.users = []
        this.models = []
        this.loaded = false
        this.modelsLoaded = false
        this.loading = false
        this.dialogVisible = false
        this.resetVisible = false
        this.clearForm()
        this.clearReset()
      } else void this.loadData()
    },
  },
  mounted() {
    void this.loadData()
  },
  beforeUnmount() {
    this.requestVersion += 1
    this.clearPasswords()
    this.clearReset()
  },
  methods: {
    typeLabel(type: ModelType): string {
      return type === 'chat' ? '对话' : type === 'embedding' ? '向量' : '重排'
    },
    formatDate(value: string): string {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN')
    },
    modelLabel(id: string): string {
      return this.models.find((model) => model.id === id)?.name || `不可用模型（${id}）`
    },
    grantSummary(user: User): string {
      return user.modelIds.map((id) => this.modelLabel(id)).join('、')
    },
    resetFilters() {
      this.search = ''
      this.roleFilter = null
      this.statusFilter = null
      this.first = 0
    },
    clampPage() {
      this.first = Math.min(
        this.first,
        Math.max(0, Math.ceil(this.filteredUsers.length / this.rows) - 1) * this.rows,
      )
    },
    async loadData() {
      if (!this.canManage) {
        this.loading = false
        return
      }
      if (this.saving || this.resetSaving || this.busyId) return
      const version = ++this.requestVersion
      this.loading = true
      this.loaded = false
      this.modelsLoaded = false
      this.users = []
      this.models = []
      this.error = ''
      this.modelError = ''
      try {
        const [users, models] = await Promise.allSettled([api.users(), api.models()])
        if (version !== this.requestVersion || !this.canManage) return
        if (users.status === 'fulfilled') {
          this.users = users.value
          this.loaded = true
        } else this.error = `用户列表加载失败：${errorText(users.reason)}`
        if (models.status === 'fulfilled') {
          this.models = models.value
          this.modelsLoaded = true
        } else this.modelError = `授权模型列表加载失败：${errorText(models.reason)}`
        this.clampPage()
      } catch (error) {
        if (version === this.requestVersion) this.error = errorText(error)
      } finally {
        if (version === this.requestVersion) this.loading = false
      }
    },
    clearPasswords() {
      this.form.password = ''
      this.form.passwordConfirm = ''
    },
    clearForm() {
      this.clearPasswords()
      this.form = newForm()
      this.formErrors = {}
      this.formError = ''
      this.editingId = undefined
    },
    openCreate() {
      if (!this.canManage || this.editorLocked) return
      this.clearForm()
      this.dialogVisible = true
    },
    openEdit(user: User) {
      if (!this.canManage || this.editorLocked) return
      this.clearForm()
      this.editingId = user.id
      this.form = {
        username: user.username,
        name: user.name,
        role: user.role,
        enabled: user.enabled,
        modelIds: [...user.modelIds],
        password: '',
        passwordConfirm: '',
      }
      this.dialogVisible = true
    },
    closeDialog() {
      if (!this.saving) {
        this.dialogVisible = false
        this.clearForm()
      }
    },
    validatePassword(password: string): string {
      if (!password.trim()) return '请输入非空密码。'
      if (password.length < 8 || password.length > 128) return '密码长度须为 8–128 个字符。'
      return ''
    },
    validateForm(): boolean {
      const errors: Record<string, string> = {}
      if (!this.form.username.trim()) errors.username = '请输入登录账号。'
      else if (/\s/.test(this.form.username.trim())) errors.username = '登录账号不能包含空白字符。'
      else if (this.form.username.trim().length > 64)
        errors.username = '登录账号不能超过 64 个字符。'
      if (!this.form.name.trim()) errors.name = '请输入用户姓名。'
      else if (this.form.name.trim().length > 100) errors.name = '姓名不能超过 100 个字符。'
      if (!roleOptions.some((option) => option.value === this.form.role))
        errors.role = '请选择有效角色。'
      if (!this.editingId) {
        const passwordError = this.validatePassword(this.form.password)
        if (passwordError) errors.password = passwordError
        if (!this.form.passwordConfirm) errors.passwordConfirm = '请再次输入密码。'
        else if (this.form.password !== this.form.passwordConfirm)
          errors.passwordConfirm = '两次输入的密码不一致。'
      }
      if (!this.modelsLoaded)
        errors.modelIds = '模型列表尚未加载，无法安全更新授权。请关闭窗口后重试加载。'
      this.formErrors = errors
      return Object.keys(errors).length === 0
    },
    updateSavedUser(saved: User) {
      const exists = this.users.some((user) => user.id === saved.id)
      this.users = exists
        ? this.users.map((user) => (user.id === saved.id ? saved : user))
        : [saved, ...this.users]
      this.clampPage()
      if (saved.id === this.auth.user?.id)
        this.auth.user = { ...saved, modelIds: [...saved.modelIds] }
    },
    async submitUser() {
      if (!this.canManage || this.actionLocked) return
      this.formError = ''
      if (!this.validateForm()) return
      const editingId = this.editingId
      const input: UserInput = {
        username: this.form.username.trim(),
        name: this.form.name.trim(),
        role: this.form.role,
        enabled: this.form.enabled,
        modelIds: [...new Set(this.form.modelIds)],
      }
      if (!editingId) input.password = this.form.password
      this.saving = true
      this.error = ''
      this.success = ''
      try {
        const pending = api.saveUser(input, editingId)
        this.clearPasswords()
        const saved = await pending
        this.updateSavedUser(saved)
        this.success = editingId
          ? `用户“${saved.name}”的资料与模型授权已保存。`
          : this.isMock
            ? `用户“${saved.name}”已创建，演示登录密码为 demo123。`
            : `用户“${saved.name}”已创建。`
        this.dialogVisible = false
        this.clearForm()
      } catch (error) {
        this.formError = `${errorText(error)}${!editingId ? ' 密码已清空，请重新输入后重试。' : ''}`
      } finally {
        this.clearPasswords()
        delete input.password
        this.saving = false
      }
    },
    async toggleUser(user: User) {
      if (!this.canManage || this.actionLocked) return
      this.busyId = user.id
      this.busyAction = 'toggle'
      this.error = ''
      this.success = ''
      try {
        const saved = await api.saveUser({ ...userInput(user), enabled: !user.enabled }, user.id)
        this.updateSavedUser(saved)
        this.success = `用户“${saved.name}”已${saved.enabled ? '启用' : '停用'}。`
      } catch (error) {
        this.error = `更新用户状态失败：${errorText(error)}`
      } finally {
        this.toggleRevision += 1
        this.busyId = ''
        this.busyAction = ''
      }
    },
    async deleteUser(user: User) {
      if (!this.canManage || this.actionLocked) return
      if (
        !window.confirm(
          `确定删除用户“${user.name}”（${user.username}）？此操作不可撤销，资源归属与管理员约束由服务端校验。`,
        )
      )
        return
      this.busyId = user.id
      this.busyAction = 'delete'
      this.error = ''
      this.success = ''
      try {
        await api.deleteUser(user.id)
        this.users = this.users.filter((item) => item.id !== user.id)
        this.clampPage()
        this.success = `用户“${user.name}”已删除。`
        if (user.id === this.auth.user?.id) this.auth.user = null
      } catch (error) {
        this.error = `删除用户失败：${errorText(error)}`
      } finally {
        this.busyId = ''
        this.busyAction = ''
      }
    },
    clearReset() {
      this.newPassword = ''
      this.confirmPassword = ''
      this.resetError = ''
      this.resetErrors = {}
      this.resetTarget = null
    },
    openReset(user: User) {
      if (!this.canManage || this.actionLocked) return
      this.clearReset()
      this.resetTarget = { ...user, modelIds: [...user.modelIds] }
      this.resetVisible = true
    },
    closeReset() {
      if (!this.resetSaving) {
        this.resetVisible = false
        this.clearReset()
      }
    },
    async resetPassword() {
      if (!this.canManage || this.actionLocked || !this.resetTarget) return
      this.resetError = ''
      const errors: Record<string, string> = {}
      const passwordError = this.validatePassword(this.newPassword)
      if (passwordError) errors.password = passwordError
      if (!this.confirmPassword) errors.confirm = '请再次输入新密码。'
      else if (this.newPassword !== this.confirmPassword) errors.confirm = '两次输入的密码不一致。'
      this.resetErrors = errors
      if (Object.keys(errors).length) return
      const target = this.users.find((user) => user.id === this.resetTarget?.id)
      if (!target) {
        this.resetError = '该用户已不在当前列表中，请关闭窗口并刷新。'
        return
      }
      const input: UserInput = { ...userInput(target), password: this.newPassword }
      this.resetSaving = true
      this.error = ''
      this.success = ''
      try {
        const pending = api.saveUser(input, target.id)
        this.newPassword = ''
        this.confirmPassword = ''
        const saved = await pending
        this.updateSavedUser(saved)
        this.success = this.isMock
          ? `已完成“${saved.name}”的演示密码重置操作；这不代表真实认证凭据已更新。`
          : `用户“${saved.name}”的密码已重置，请通过安全渠道告知本人。`
        this.resetVisible = false
        this.clearReset()
      } catch (error) {
        this.resetError = `${errorText(error)} 密码输入已清空，请重新输入后重试。`
      } finally {
        this.newPassword = ''
        this.confirmPassword = ''
        delete input.password
        this.resetSaving = false
      }
    },
  },
})
</script>

<template>
  <div class="users-view">
    <header class="page-header">
      <div>
        <span class="eyebrow">组织管理 / 成员与权限</span>
        <h1>用户管理</h1>
        <p class="muted">管理团队成员、访问角色与模型使用权限。</p>
      </div>
      <div v-if="canManage" class="button-row">
        <Button
          label="刷新"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          :loading="loading"
          :disabled="saving || resetSaving || !!busyId"
          @click="loadData"
        /><Button
          label="添加用户"
          icon="pi pi-user-plus"
          :disabled="editorLocked"
          @click="openCreate"
        />
      </div>
    </header>
    <section v-if="!canManage" class="panel empty-state access-denied">
      <span class="denied-icon"><i class="pi pi-lock" aria-hidden="true"></i></span>
      <h2>此页面仅对启用中的管理员开放</h2>
      <p class="muted">你当前没有管理用户的权限。如需调整授权，请联系管理员。</p>
      <Button label="返回工作台" icon="pi pi-arrow-left" @click="$router.push('/dashboard')" />
    </section>
    <template v-else>
      <div v-if="isMock" class="notice mock-notice" role="note">
        <i class="pi pi-info-circle" aria-hidden="true"></i
        ><span
          >当前为演示模式，不保存输入的密码；新建用户统一使用 demo123
          登录，重置操作不改变演示口令。请勿输入真实密码或敏感个人信息。</span
        >
      </div>
      <div v-if="error" class="error-banner feedback" role="alert">
        <span>{{ error }}</span
        ><Button
          v-if="!loaded"
          label="重新加载"
          text
          severity="danger"
          :disabled="actionLocked"
          @click="loadData"
        /><Button
          v-else
          icon="pi pi-times"
          text
          rounded
          severity="danger"
          aria-label="关闭错误提示"
          @click="error = ''"
        />
      </div>
      <div v-if="modelError" class="error-banner feedback" role="alert">
        <div>
          {{ modelError }}
          <p class="error-detail">
            为避免误改授权，已暂停新增和编辑。现有账号的启停、密码重置仍会保留原授权。
          </p>
        </div>
        <Button
          label="重试"
          icon="pi pi-refresh"
          text
          severity="danger"
          :disabled="actionLocked"
          @click="loadData"
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
      <section class="stat-grid user-stats" aria-label="团队用户统计" :aria-busy="loading">
        <article class="stat-card user-stat">
          <span class="stat-symbol blue"><i class="pi pi-users" aria-hidden="true"></i></span>
          <div>
            <span class="muted">团队成员</span><strong>{{ loaded ? users.length : '—' }}</strong>
          </div>
        </article>
        <article class="stat-card user-stat">
          <span class="stat-symbol green"><i class="pi pi-user" aria-hidden="true"></i></span>
          <div>
            <span class="muted">已启用账号</span><strong>{{ loaded ? enabledCount : '—' }}</strong>
          </div>
        </article>
        <article class="stat-card user-stat">
          <span class="stat-symbol violet"><i class="pi pi-shield" aria-hidden="true"></i></span>
          <div>
            <span class="muted">已启用管理员</span><strong>{{ loaded ? adminCount : '—' }}</strong>
          </div>
        </article>
      </section>
      <section class="panel users-panel" aria-label="用户列表" :aria-busy="loading">
        <div class="list-heading">
          <div>
            <h2>
              团队成员 <span class="count-badge">{{ loaded ? users.length : '—' }}</span>
            </h2>
            <p class="muted">清晰的角色边界，精确到模型的使用授权</p>
          </div>
          <Tag value="仅管理员可管理" severity="secondary" icon="pi pi-shield" />
        </div>
        <div class="toolbar users-toolbar">
          <div class="search-control">
            <i class="pi pi-search" aria-hidden="true"></i
            ><InputText v-model="search" placeholder="搜索姓名或登录账号…" aria-label="搜索用户" />
          </div>
          <Select
            v-model="roleFilter"
            :options="roleOptions"
            option-label="label"
            option-value="value"
            show-clear
            placeholder="全部角色"
            aria-label="按角色筛选"
            class="filter-control"
          />
          <Select
            v-model="statusFilter"
            :options="statusOptions"
            option-label="label"
            option-value="value"
            show-clear
            placeholder="全部状态"
            aria-label="按用户状态筛选"
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
          找到 {{ filteredUsers.length }} 位匹配成员
        </div>
        <DataTable
          v-model:first="first"
          v-model:rows="rows"
          :value="filteredUsers"
          data-key="id"
          :loading="loading"
          paginator
          :rows-per-page-options="[10, 20, 50]"
          paginator-template="FirstPageLink PrevPageLink PageLinks NextPageLink LastPageLink CurrentPageReport RowsPerPageDropdown"
          current-page-report-template="第 {first}–{last} 条，共 {totalRecords} 条"
          :table-style="{ minWidth: '990px' }"
          scrollable
          striped-rows
          removable-sort
        >
          <template #empty
            ><div class="empty-state table-empty">
              <i
                :class="!loaded && !loading ? 'pi pi-exclamation-circle' : 'pi pi-users'"
                aria-hidden="true"
              ></i>
              <h3>
                {{
                  loading
                    ? '正在加载用户…'
                    : !loaded
                      ? '用户列表加载失败'
                      : hasFilters
                        ? '没有找到匹配用户'
                        : '暂无用户'
                }}
              </h3>
              <p class="muted">
                {{
                  loading
                    ? '正在读取团队成员，请稍候。'
                    : !loaded
                      ? '请稍后重试，或确认当前账号权限。'
                      : hasFilters
                        ? '调整关键词或筛选条件后重试。'
                        : '添加团队成员，并为其授予所需模型权限。'
                }}
              </p>
              <Button v-if="!loading && !loaded" label="重新加载" text @click="loadData" /><Button
                v-else-if="hasFilters && !loading"
                label="清除筛选"
                text
                @click="resetFilters"
              /><Button
                v-else-if="!loading"
                label="添加用户"
                icon="pi pi-user-plus"
                :disabled="editorLocked"
                @click="openCreate"
              /></div
          ></template>
          <Column field="name" header="成员" sortable style="min-width: 210px; max-width: 280px"
            ><template #body="{ data }"
              ><div class="user-cell">
                <span class="user-avatar" :class="{ administrator: data.role === 'admin' }">{{
                  Array.from(data.name || data.username)[0]
                }}</span>
                <div class="user-identity">
                  <div>
                    <strong>{{ data.name }}</strong
                    ><Tag
                      v-if="data.id === auth.user?.id"
                      value="当前账号"
                      severity="secondary"
                      class="self-tag"
                    />
                  </div>
                  <span class="muted">{{ data.username }}</span>
                </div>
              </div></template
            ></Column
          >
          <Column field="role" header="角色" sortable style="min-width: 115px"
            ><template #body="{ data }"
              ><Tag
                :value="data.role === 'admin' ? '管理员' : '普通用户'"
                :severity="data.role === 'admin' ? 'info' : 'secondary'"
                :icon="data.role === 'admin' ? 'pi pi-shield' : 'pi pi-user'" /></template
          ></Column>
          <Column field="enabled" header="账号状态" sortable style="min-width: 145px"
            ><template #body="{ data }"
              ><div class="status-cell">
                <ToggleSwitch
                  :key="`${data.id}-${toggleRevision}`"
                  :model-value="data.enabled"
                  :disabled="actionLocked"
                  :aria-label="`${data.enabled ? '停用' : '启用'}用户 ${data.name}`"
                  @update:model-value="toggleUser(data)"
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
          <Column header="模型使用权限" style="min-width: 240px; max-width: 310px"
            ><template #body="{ data }"
              ><Tag
                v-if="data.role === 'admin'"
                value="全部模型 · 管理员权限"
                severity="info"
              /><span v-else-if="!modelsLoaded" class="muted grant-caption"
                >{{ data.modelIds.length }} 项授权（模型名称暂不可用）</span
              >
              <div v-else-if="data.modelIds.length" class="grant-tags" :title="grantSummary(data)">
                <Tag
                  v-for="id in data.modelIds.slice(0, 2)"
                  :key="id"
                  :value="modelLabel(id)"
                  severity="secondary"
                /><Button
                  v-if="data.modelIds.length > 2"
                  :label="`另 ${data.modelIds.length - 2} 项`"
                  :aria-label="`查看 ${data.name} 的全部 ${data.modelIds.length} 项授权`"
                  text
                  size="small"
                  :disabled="editorLocked"
                  @click="openEdit(data)"
                />
              </div>
              <span v-else class="muted grant-caption">暂未授予模型权限</span></template
            ></Column
          >
          <Column field="createdAt" header="创建日期" sortable style="min-width: 115px"
            ><template #body="{ data }"
              ><span class="muted date-cell">{{ formatDate(data.createdAt) }}</span></template
            ></Column
          >
          <Column header="操作" frozen align-frozen="right" style="min-width: 150px"
            ><template #body="{ data }"
              ><div class="row-actions">
                <Button
                  icon="pi pi-pencil"
                  text
                  rounded
                  severity="secondary"
                  :disabled="editorLocked"
                  :aria-label="`编辑用户 ${data.name} 与模型授权`"
                  title="编辑资料与模型授权"
                  @click="openEdit(data)"
                /><Button
                  icon="pi pi-key"
                  text
                  rounded
                  :disabled="actionLocked"
                  :aria-label="`重置 ${data.name} 的密码`"
                  title="重置密码"
                  @click="openReset(data)"
                /><Button
                  icon="pi pi-trash"
                  text
                  rounded
                  severity="danger"
                  :loading="busyId === data.id && busyAction === 'delete'"
                  :disabled="actionLocked"
                  :aria-label="`删除用户 ${data.name}`"
                  title="删除用户"
                  @click="deleteUser(data)"
                /></div></template
          ></Column>
        </DataTable>
        <div class="table-footnote muted">
          <i class="pi pi-shield" aria-hidden="true"></i
          ><span
            >最后一个启用管理员等账号约束由服务端校验；操作被拒绝时会展示具体原因。普通用户只能使用已启用且获授权的模型。</span
          >
        </div>
      </section>
    </template>

    <Dialog
      v-model:visible="dialogVisible"
      modal
      :header="editingId ? '编辑用户与授权' : '添加团队成员'"
      :style="{ width: '660px', maxWidth: 'calc(100vw - 2rem)' }"
      :closable="!saving"
      :close-on-escape="!saving"
      :draggable="false"
      @hide="clearForm"
    >
      <form
        id="user-editor-form"
        class="user-form"
        novalidate
        :aria-busy="saving"
        @submit.prevent="submitUser"
      >
        <p class="dialog-intro muted">
          {{
            editingId
              ? '维护成员信息及模型使用范围。密码请通过列表中的“重置密码”单独更新。'
              : '创建账号并分配角色，可同时授予多个模型。'
          }}
          标有 * 的字段为必填。
        </p>
        <div v-if="formError" class="error-banner" role="alert">{{ formError }}</div>
        <div class="form-grid user-form-grid">
          <div class="field">
            <label for="user-username">登录账号 *</label
            ><InputText
              id="user-username"
              v-model="form.username"
              autofocus
              autocomplete="off"
              :disabled="saving"
              :invalid="!!formErrors.username"
              aria-describedby="user-username-error"
              maxlength="64"
              placeholder="例如：zhang.san"
            /><small v-if="formErrors.username" id="user-username-error" class="field-error">{{
              formErrors.username
            }}</small>
          </div>
          <div class="field">
            <label for="user-name">姓名 *</label
            ><InputText
              id="user-name"
              v-model="form.name"
              :disabled="saving"
              :invalid="!!formErrors.name"
              aria-describedby="user-name-error"
              maxlength="100"
              placeholder="成员的显示名称"
            /><small v-if="formErrors.name" id="user-name-error" class="field-error">{{
              formErrors.name
            }}</small>
          </div>
          <div class="field full-width">
            <label for="user-role">角色 *</label
            ><Select
              v-model="form.role"
              input-id="user-role"
              :options="roleOptions"
              option-label="label"
              option-value="value"
              :disabled="saving"
              :invalid="!!formErrors.role"
              aria-describedby="user-role-help user-role-error"
            /><small id="user-role-help" class="muted">{{
              form.role === 'admin'
                ? '管理员可管理模型、用户及资源，并可访问全部模型。请谨慎授予。'
                : '普通用户可使用被授权且已启用的模型，以及自己有权访问的资源。'
            }}</small
            ><small v-if="formErrors.role" id="user-role-error" class="field-error">{{
              formErrors.role
            }}</small>
          </div>
          <template v-if="!editingId">
            <div v-if="isMock" class="password-warning full-width">
              <i class="pi pi-info-circle" aria-hidden="true"></i>
              仅输入虚构的演示密码，禁止填写真实密码。
            </div>
            <div class="field">
              <label for="user-initial-password">初始密码 *</label
              ><InputText
                id="user-initial-password"
                v-model="form.password"
                type="password"
                autocomplete="new-password"
                :disabled="saving"
                :invalid="!!formErrors.password"
                aria-describedby="user-password-help user-password-error"
                maxlength="128"
                placeholder="8–128 个字符"
              /><small id="user-password-help" class="muted"
                >提交后立即清空；服务端可能执行更严格的密码策略。</small
              ><small v-if="formErrors.password" id="user-password-error" class="field-error">{{
                formErrors.password
              }}</small>
            </div>
            <div class="field">
              <label for="user-password-confirm">确认初始密码 *</label
              ><InputText
                id="user-password-confirm"
                v-model="form.passwordConfirm"
                type="password"
                autocomplete="new-password"
                :disabled="saving"
                :invalid="!!formErrors.passwordConfirm"
                aria-describedby="user-password-confirm-error"
                maxlength="128"
                placeholder="再次输入初始密码"
              /><small
                v-if="formErrors.passwordConfirm"
                id="user-password-confirm-error"
                class="field-error"
                >{{ formErrors.passwordConfirm }}</small
              >
            </div>
          </template>
        </div>
        <section class="grant-section" aria-label="模型授权设置">
          <div class="grant-heading">
            <strong><i class="pi pi-box" aria-hidden="true"></i> 模型授权</strong
            ><Tag :value="`已选择 ${form.modelIds.length} 项`" severity="info" />
          </div>
          <div class="field">
            <label for="user-model-grants">允许使用的模型</label
            ><MultiSelect
              v-model="form.modelIds"
              input-id="user-model-grants"
              :options="modelOptions"
              option-label="label"
              option-value="id"
              display="chip"
              filter
              filter-placeholder="搜索模型名称"
              placeholder="选择一个或多个模型"
              :max-selected-labels="3"
              selected-items-label="已选择 {0} 个模型"
              :disabled="saving || !modelsLoaded"
              :invalid="!!formErrors.modelIds"
              aria-describedby="user-grants-help user-grants-error"
              empty-message="暂无可分配模型"
              empty-filter-message="没有匹配的模型"
              :show-toggle-all="true"
            /><small id="user-grants-help" class="muted"
              >停用模型可预先授权，但启用前无法使用。留空表示不分配任何模型。不可用的原授权不会被静默删除。</small
            ><small v-if="formErrors.modelIds" id="user-grants-error" class="field-error">{{
              formErrors.modelIds
            }}</small>
          </div>
          <p v-if="form.role === 'admin'" class="grant-note">
            管理员默认拥有全部模型访问权限；此处保留的显式授权将在其改为普通用户后决定可用模型。
          </p>
          <div class="grant-actions">
            <Button
              label="选择全部模型"
              size="small"
              text
              :disabled="saving || !models.length"
              @click="
                form.modelIds = [...new Set([...form.modelIds, ...models.map((model) => model.id)])]
              "
            /><Button
              label="清空授权"
              size="small"
              text
              severity="secondary"
              :disabled="saving || !form.modelIds.length"
              @click="form.modelIds = []"
            /><span v-if="!models.length && modelsLoaded" class="muted"
              >暂无模型，可稍后补充授权。</span
            >
          </div>
        </section>
        <div class="switch-row">
          <ToggleSwitch v-model="form.enabled" input-id="user-enabled" :disabled="saving" />
          <div>
            <label for="user-enabled">启用账号</label
            ><small class="muted">停用后不能继续访问系统，最终会话控制由服务端执行。</small>
          </div>
        </div>
        <p class="constraint-note muted">
          <i class="pi pi-shield" aria-hidden="true"></i>
          管理员保留与账号操作约束在保存时由服务端校验。
        </p>
      </form>
      <template #footer
        ><Button
          label="取消"
          severity="secondary"
          outlined
          :disabled="saving"
          @click="closeDialog" /><Button
          :label="editingId ? '保存资料与授权' : '创建用户'"
          icon="pi pi-check"
          type="submit"
          form="user-editor-form"
          :loading="saving"
          :disabled="!canManage || !modelsLoaded"
      /></template>
    </Dialog>

    <Dialog
      v-model:visible="resetVisible"
      modal
      header="重置用户密码"
      :style="{ width: '480px', maxWidth: 'calc(100vw - 2rem)' }"
      :closable="!resetSaving"
      :close-on-escape="!resetSaving"
      :draggable="false"
      @hide="clearReset"
    >
      <form
        id="user-password-form"
        class="password-form"
        novalidate
        :aria-busy="resetSaving"
        @submit.prevent="resetPassword"
      >
        <div class="reset-target">
          <span class="stat-symbol blue"><i class="pi pi-key" aria-hidden="true"></i></span>
          <div>
            <strong>{{ resetTarget?.name }}</strong
            ><span class="muted">{{ resetTarget?.username }}</span>
          </div>
        </div>
        <p class="dialog-intro muted">
          设置新密码，不显示旧密码。请通过安全渠道告知本人；不会修改角色、启停状态或模型授权。
        </p>
        <div v-if="isMock" class="password-warning">
          演示模式仅接受虚构的演示密码，请勿输入真实密码。
        </div>
        <div v-if="resetError" class="error-banner" role="alert">{{ resetError }}</div>
        <div class="field">
          <label for="user-reset-password">新密码 *</label
          ><InputText
            id="user-reset-password"
            v-model="newPassword"
            autofocus
            type="password"
            autocomplete="new-password"
            :disabled="resetSaving"
            :invalid="!!resetErrors.password"
            aria-describedby="user-reset-help user-reset-error"
            maxlength="128"
            placeholder="输入 8–128 个字符的新密码"
          /><small id="user-reset-help" class="muted"
            >提交后输入立即清空；服务端可能执行更严格的密码策略。</small
          ><small v-if="resetErrors.password" id="user-reset-error" class="field-error">{{
            resetErrors.password
          }}</small>
        </div>
        <div class="field">
          <label for="user-reset-confirm">确认新密码 *</label
          ><InputText
            id="user-reset-confirm"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            :disabled="resetSaving"
            :invalid="!!resetErrors.confirm"
            aria-describedby="user-reset-confirm-error"
            maxlength="128"
            placeholder="再次输入新密码"
          /><small v-if="resetErrors.confirm" id="user-reset-confirm-error" class="field-error">{{
            resetErrors.confirm
          }}</small>
        </div>
      </form>
      <template #footer
        ><Button
          label="取消"
          severity="secondary"
          outlined
          :disabled="resetSaving"
          @click="closeReset" /><Button
          label="确认重置"
          icon="pi pi-key"
          type="submit"
          form="user-password-form"
          :loading="resetSaving"
          :disabled="!canManage"
      /></template>
    </Dialog>
  </div>
</template>

<style scoped>
.users-view {
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
  align-items: flex-start;
  gap: 0.65rem;
  border: 1px solid #bfdbfe;
  background: #eff6ff;
  border-radius: 10px;
  color: #1e40af;
  padding: 0.85rem 1rem;
  font-size: 0.82rem;
  line-height: 1.6;
}
.notice i {
  margin-top: 0.2rem;
}
.feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  overflow-wrap: anywhere;
}
.feedback :deep(button) {
  flex-shrink: 0;
}
.error-detail {
  font-size: 0.78rem;
  margin: 0.4rem 0 0;
  line-height: 1.6;
}
.success-notice {
  background: #f0fdf4;
  color: #166534;
  border: 1px solid #bbf7d0;
  border-radius: 10px;
  padding: 0.6rem 1rem;
  font-size: 0.85rem;
}
.user-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}
.user-stat {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1.3rem 1.5rem;
}
.user-stat > div {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.user-stat > div > span {
  font-size: 0.8rem;
}
.user-stat strong {
  font-size: 1.9rem;
  letter-spacing: -0.04em;
  color: #1e293b;
  font-variant-numeric: tabular-nums;
}
.stat-symbol {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  border-radius: 12px;
  flex-shrink: 0;
}
.stat-symbol i {
  font-size: 1.15rem;
}
.blue {
  background: #eff6ff;
  color: #2563eb;
}
.green {
  background: #f0fdfa;
  color: #0f766e;
}
.violet {
  background: #f5f3ff;
  color: #7c3aed;
}
.users-panel {
  padding: 0;
  overflow: hidden;
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
  margin: 0.5rem 0 0;
  font-size: 0.78rem;
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
.users-toolbar {
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
  min-width: 145px;
}
.filter-count {
  font-size: 0.8rem;
  padding: 0.75rem 1.5rem 0;
}
.user-cell {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.user-avatar {
  width: 39px;
  height: 39px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  background: #f1f5f9;
  color: #475569;
  border-radius: 50%;
  font-size: 0.95rem;
  font-weight: 600;
}
.user-avatar.administrator {
  background: #eff6ff;
  color: #2563eb;
}
.user-identity {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
}
.user-identity > div {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.user-identity strong {
  color: #1e293b;
  font-size: 0.86rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.user-identity > span {
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}
.self-tag {
  font-size: 0.65rem;
}
.status-cell {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}
.grant-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.grant-tags :deep(.p-tag) {
  max-width: 220px;
  font-size: 0.7rem;
}
.grant-tags :deep(.p-tag-label) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.grant-tags :deep(button) {
  padding: 0.25rem 0.4rem;
  font-size: 0.72rem;
}
.grant-caption,
.date-cell {
  font-size: 0.77rem;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 0.1rem;
}
.table-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 3.5rem 1rem;
}
.table-empty > i {
  color: #a7b5c8;
  font-size: 2rem;
  margin-bottom: 0.8rem;
}
.table-empty h3 {
  margin: 0.5rem 0;
  font-size: 1rem;
  color: #475569;
}
.table-empty p {
  font-size: 0.85rem;
  margin: 0.3rem 0 1rem;
}
.table-footnote {
  display: flex;
  gap: 0.55rem;
  align-items: baseline;
  padding: 1rem 1.5rem;
  border-top: 1px solid #eef2f6;
  font-size: 0.75rem;
  line-height: 1.6;
}
.access-denied {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 0.75rem;
  padding: 4rem 1.5rem;
}
.access-denied h2 {
  font-size: 1.3rem;
  margin: 0.75rem 0 0;
}
.access-denied p {
  line-height: 1.7;
  margin: 0 0 1rem;
}
.denied-icon {
  display: grid;
  place-items: center;
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: #f1f5f9;
  color: #64748b;
  font-size: 1.8rem;
}
.user-form,
.password-form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.dialog-intro {
  font-size: 0.82rem;
  line-height: 1.7;
  margin: 0;
}
.user-form-grid {
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
.field :deep(.p-select),
.field :deep(.p-multiselect) {
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
.password-warning {
  border-radius: 8px;
  padding: 0.8rem;
  font-size: 0.78rem;
  line-height: 1.6;
  color: #92400e;
  background: #fffbeb;
}
.password-warning i {
  margin-right: 0.3rem;
}
.grant-section {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
  border-radius: 10px;
  padding: 1rem;
}
.grant-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.grant-heading strong {
  color: #475569;
  font-size: 0.85rem;
}
.grant-heading i {
  margin-right: 0.35rem;
}
.grant-note {
  background: #eff6ff;
  color: #1d4ed8;
  border-radius: 6px;
  padding: 0.7rem;
  margin: 0;
  font-size: 0.76rem;
  line-height: 1.7;
}
.grant-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.75rem;
}
.switch-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.switch-row label {
  cursor: pointer;
  font-size: 0.85rem;
}
.switch-row small {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.75rem;
  line-height: 1.6;
}
.constraint-note {
  margin: 0;
  border-top: 1px solid #e2e8f0;
  padding-top: 1rem;
  font-size: 0.75rem;
  line-height: 1.7;
}
.constraint-note i {
  margin-right: 0.35rem;
}
.reset-target {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.9rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
}
.reset-target > div {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 0;
  overflow-wrap: anywhere;
}
.reset-target strong {
  font-size: 0.9rem;
}
.reset-target .muted {
  font-size: 0.78rem;
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
:deep(.p-multiselect-label) {
  flex-wrap: wrap;
}
@media (max-width: 850px) {
  .user-stat {
    padding: 1.1rem;
    gap: 0.75rem;
  }
  .user-stat .stat-symbol {
    width: 38px;
    height: 38px;
  }
}
@media (max-width: 680px) {
  .user-stats {
    grid-template-columns: 1fr;
    gap: 0.7rem;
  }
  .user-stat {
    padding: 1rem;
  }
  .user-stat > div {
    flex: 1;
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
  }
  .user-stat strong {
    font-size: 1.6rem;
  }
  .list-heading {
    padding: 1.2rem 1rem 1rem;
  }
  .list-heading > :deep(.p-tag) {
    display: none;
  }
  .users-toolbar {
    padding: 0.25rem 1rem 1rem;
  }
  .search-control {
    flex-basis: 100%;
  }
  .filter-control {
    flex: 1;
    min-width: 125px;
  }
  .table-footnote {
    padding: 1rem;
  }
  .feedback {
    align-items: flex-start;
  }
}
@media (max-width: 540px) {
  .user-form-grid {
    grid-template-columns: 1fr;
  }
  .user-form-grid .full-width {
    grid-column: auto;
  }
  .grant-section {
    padding: 0.85rem;
  }
}
</style>
