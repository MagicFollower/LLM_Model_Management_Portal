<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import Skeleton from 'primevue/skeleton'
import { api, isMock } from '@/api'
import { useAuthStore } from '@/stores/auth'
import type { Model, KnowledgeBase, Conversation, DocumentRecord } from '@/types'

function errorText(error: unknown): string {
  const response = error as {
    response?: { data?: { error?: { message?: string } } }
    message?: string
  } | null
  return response?.response?.data?.error?.message || response?.message || '请求失败，请稍后重试。'
}

export default defineComponent({
  name: 'DashboardView',
  components: { Button, Tag, Skeleton },
  data() {
    return {
      auth: useAuthStore(),
      isMock,
      loading: true,
      requestVersion: 0,
      models: [] as Model[],
      knowledgeBases: [] as KnowledgeBase[],
      conversations: [] as Conversation[],
      documents: [] as DocumentRecord[],
      loaded: { models: false, knowledge: false, conversations: false, documents: false },
      errors: [] as string[],
      documentFailures: 0,
      documentSuccesses: 0,
      failedKnowledgeNames: [] as string[],
      lastUpdated: '',
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
    enabledModels(): number {
      return this.accessibleModels.filter((model) => model.enabled).length
    },
    readyDocuments(): number {
      return this.documents.filter((document) => document.status === 'ready').length
    },
    processingDocuments(): number {
      return this.documents.filter((document) =>
        ['parsing', 'splitting', 'embedding', 'indexing'].includes(document.status),
      ).length
    },
    failedDocuments(): number {
      return this.documents.filter((document) => document.status === 'failed').length
    },
    documentCount(): string {
      if (!this.loaded.documents) return '—'
      return `${this.documentFailures ? '≥ ' : ''}${this.documents.length.toLocaleString('zh-CN')}`
    },
    stats() {
      return [
        {
          title: '可访问模型',
          value: this.loaded.models ? this.accessibleModels.length.toLocaleString('zh-CN') : '—',
          icon: 'pi pi-box',
          color: 'blue',
          detail: this.loaded.models
            ? `${this.enabledModels} 个已启用 · 按当前权限展示`
            : '模型数据暂不可用',
          route: '/models',
        },
        {
          title: '知识库',
          value: this.loaded.knowledge ? this.knowledgeBases.length.toLocaleString('zh-CN') : '—',
          icon: 'pi pi-book',
          color: 'violet',
          detail: this.loaded.knowledge ? '当前账号可访问的知识空间' : '知识库数据暂不可用',
          route: '/knowledge',
        },
        {
          title: '文档总数',
          value: this.documentCount,
          icon: 'pi pi-file',
          color: 'teal',
          detail: this.loaded.documents
            ? this.documentFailures
              ? `${this.documentFailures} 个知识库读取失败，当前为已知下限`
              : `${this.readyDocuments} 个已就绪 · ${this.processingDocuments} 个处理中`
            : '文档统计暂不可用',
          route: '/knowledge',
        },
        {
          title: '我的会话',
          value: this.loaded.conversations
            ? this.conversations.length.toLocaleString('zh-CN')
            : '—',
          icon: 'pi pi-comments',
          color: 'amber',
          detail: this.loaded.conversations ? '属于当前账号的对话记录' : '会话数据暂不可用',
          route: '/chat',
        },
      ]
    },
    modelTypes() {
      return [
        { name: '对话模型', type: 'chat', icon: 'pi pi-comments' },
        { name: '向量模型', type: 'embedding', icon: 'pi pi-th-large' },
        { name: '重排模型', type: 'rerank', icon: 'pi pi-sort-amount-down' },
      ].map((item) => ({
        ...item,
        count: this.accessibleModels.filter((model) => model.type === item.type).length,
      }))
    },
    documentStates() {
      return [
        { label: '已就绪', count: this.readyDocuments, className: 'ready' },
        { label: '处理中', count: this.processingDocuments, className: 'processing' },
        { label: '处理失败', count: this.failedDocuments, className: 'failed' },
      ]
    },
    recentKnowledge(): KnowledgeBase[] {
      return [...this.knowledgeBases]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, 4)
    },
    recentConversations(): Conversation[] {
      return [...this.conversations]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, 4)
    },
  },
  mounted() {
    void this.refresh()
  },
  beforeUnmount() {
    this.requestVersion += 1
  },
  methods: {
    formatDate(value: string): string {
      const date = new Date(value)
      return Number.isNaN(date.getTime())
        ? '日期不可用'
        : date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
    },
    modelName(id: string): string {
      return this.accessibleModels.find((model) => model.id === id)?.name || '模型不可访问或已移除'
    },
    async refresh() {
      const version = ++this.requestVersion
      this.loading = true
      this.errors = []
      this.loaded = { models: false, knowledge: false, conversations: false, documents: false }
      this.models = []
      this.knowledgeBases = []
      this.conversations = []
      this.documents = []
      this.documentFailures = 0
      this.documentSuccesses = 0
      this.failedKnowledgeNames = []
      this.lastUpdated = ''
      try {
        const [models, knowledge, conversations] = await Promise.allSettled([
          api.models(),
          api.knowledgeBases(),
          api.conversations(),
        ])
        if (version !== this.requestVersion) return
        if (models.status === 'fulfilled') {
          this.models = models.value
          this.loaded.models = true
        } else this.errors.push(`模型读取失败：${errorText(models.reason)}`)
        if (conversations.status === 'fulfilled') {
          this.conversations = conversations.value
          this.loaded.conversations = true
        } else this.errors.push(`会话读取失败：${errorText(conversations.reason)}`)
        if (knowledge.status === 'fulfilled') {
          this.knowledgeBases = knowledge.value
          this.loaded.knowledge = true
          const results = await Promise.allSettled(
            knowledge.value.map(async (kb) => ({
              kbId: kb.id,
              documents: await api.documents(kb.id),
            })),
          )
          if (version !== this.requestVersion) return
          const uniqueDocuments = new Map<string, DocumentRecord>()
          results.forEach((result, index) => {
            if (result.status === 'fulfilled') {
              this.documentSuccesses += 1
              result.value.documents.forEach((document) =>
                uniqueDocuments.set(document.id, document),
              )
            } else {
              this.documentFailures += 1
              const name = knowledge.value[index]?.name || '未知知识库'
              this.failedKnowledgeNames.push(name)
              this.errors.push(`知识库“${name}”的文档读取失败：${errorText(result.reason)}`)
            }
          })
          this.documents = [...uniqueDocuments.values()]
          this.loaded.documents = knowledge.value.length === 0 || this.documentSuccesses > 0
        } else this.errors.push(`知识库及文档统计读取失败：${errorText(knowledge.reason)}`)
        this.lastUpdated = new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      } catch (error) {
        if (version === this.requestVersion) this.errors.push(errorText(error))
      } finally {
        if (version === this.requestVersion) this.loading = false
      }
    },
  },
})
</script>

<template>
  <div class="dashboard-view" :aria-busy="loading">
    <header class="page-header">
      <div>
        <span class="eyebrow">工作空间 / 概览</span>
        <h1>工作台</h1>
        <p class="muted">连接模型与团队知识，从这里开启工作。</p>
      </div>
      <div class="button-row">
        <span v-if="lastUpdated" class="refresh-time muted">本次刷新完成于 {{ lastUpdated }}</span>
        <Button
          label="刷新数据"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          :loading="loading"
          @click="refresh"
        />
      </div>
    </header>

    <div v-if="isMock" class="mode-note" role="note">
      <i class="pi pi-info-circle" aria-hidden="true"></i>
      <span
        >当前为演示模式。统计来自当前账号可访问的演示业务数据，不代表真实模型调用或监控结果。</span
      >
    </div>
    <div v-if="errors.length" class="error-banner dashboard-errors" role="alert">
      <div>
        <strong>部分数据未能加载</strong>
        <ul>
          <li v-for="(error, index) in errors" :key="index">{{ error }}</li>
        </ul>
      </div>
      <Button
        label="重新加载"
        icon="pi pi-refresh"
        severity="danger"
        text
        :disabled="loading"
        @click="refresh"
      />
    </div>

    <section class="welcome-card">
      <div class="welcome-copy">
        <Tag :value="auth.isAdmin ? '管理员工作空间' : '个人工作空间'" severity="info" />
        <h2>你好，{{ auth.user?.name || auth.user?.username || '欢迎回来' }}</h2>
        <p>让每一个模型，连接有价值的知识。</p>
        <div class="button-row">
          <Button label="开始对话" icon="pi pi-arrow-up-right" @click="$router.push('/chat')" />
          <Button
            label="浏览知识库"
            icon="pi pi-book"
            severity="secondary"
            outlined
            @click="$router.push('/knowledge')"
          />
        </div>
      </div>
      <div class="welcome-visual" aria-hidden="true">
        <span class="visual-node node-one"><i class="pi pi-box"></i></span>
        <span class="visual-node node-two"><i class="pi pi-sparkles"></i></span>
        <span class="visual-node node-three"><i class="pi pi-book"></i></span>
        <span class="visual-caption">模型 · 知识 · 协作</span>
      </div>
    </section>

    <section class="stat-grid dashboard-stats" aria-label="授权资源统计">
      <article v-for="stat in stats" :key="stat.title" class="stat-card dashboard-stat">
        <div class="stat-top">
          <span>{{ stat.title }}</span
          ><span class="stat-icon" :class="stat.color"
            ><i :class="stat.icon" aria-hidden="true"></i
          ></span>
        </div>
        <Skeleton v-if="loading" width="5rem" height="2.6rem" class="stat-skeleton" />
        <strong v-else class="stat-number">{{ stat.value }}</strong>
        <div class="stat-bottom">
          <span class="muted">{{ stat.detail }}</span
          ><Button
            icon="pi pi-arrow-up-right"
            text
            rounded
            severity="secondary"
            :aria-label="`查看${stat.title}`"
            @click="$router.push(stat.route)"
          />
        </div>
      </article>
    </section>

    <section class="overview-grid">
      <article class="panel overview-panel">
        <div class="section-heading">
          <div>
            <h2>模型资源</h2>
            <p class="muted">按用途查看当前可访问的模型</p>
          </div>
          <Button
            label="全部模型"
            icon="pi pi-arrow-right"
            icon-pos="right"
            text
            size="small"
            @click="$router.push('/models')"
          />
        </div>
        <div v-if="loading" class="loading-stack">
          <Skeleton v-for="n in 3" :key="n" height="3.4rem" />
        </div>
        <div v-else-if="!loaded.models" class="empty-state">
          <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
          <p>暂时无法读取模型资源</p>
          <Button label="重试" text @click="refresh" />
        </div>
        <div v-else-if="!accessibleModels.length" class="empty-state">
          <i class="pi pi-box" aria-hidden="true"></i>
          <p>{{ auth.isAdmin ? '还没有接入模型' : '暂无可用的授权模型，请联系管理员' }}</p>
          <Button v-if="auth.isAdmin" label="管理模型" text @click="$router.push('/models')" />
        </div>
        <div v-else class="model-distribution">
          <div v-for="item in modelTypes" :key="item.type" class="model-type-row">
            <i :class="item.icon" aria-hidden="true"></i><span>{{ item.name }}</span>
            <div class="distribution-track" aria-hidden="true">
              <span :style="{ width: `${(item.count / accessibleModels.length) * 100}%` }"></span>
            </div>
            <strong>{{ item.count }}</strong>
          </div>
        </div>
        <p class="panel-footnote muted">
          {{
            auth.isAdmin
              ? '启停状态仅表示配置开关，不代表连接健康状况。'
              : '仅展示已启用且已授予当前账号的模型。'
          }}
        </p>
      </article>
      <article class="panel overview-panel">
        <div class="section-heading">
          <div>
            <h2>文档处理概览</h2>
            <p class="muted">逐个读取可访问知识库的文档状态</p>
          </div>
          <Tag v-if="documentFailures" value="统计不完整" severity="warn" />
        </div>
        <Skeleton v-if="loading" height="8.3rem" />
        <div v-else-if="!loaded.documents" class="empty-state">
          <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
          <p>暂时无法统计文档</p>
          <Button label="重试" text @click="refresh" />
        </div>
        <div v-else-if="!documents.length" class="empty-state">
          <i class="pi pi-file" aria-hidden="true"></i>
          <p>
            {{
              documentFailures
                ? '已读取的知识库中暂无文档，其他知识库读取失败'
                : '暂无文档，前往知识库上传第一份资料'
            }}
          </p>
          <Button label="前往知识库" text @click="$router.push('/knowledge')" />
        </div>
        <div v-else class="document-overview">
          <div class="document-total">
            <strong>{{ documentCount }}</strong
            ><span class="muted">份{{ documentFailures ? '已读取的' : '' }}文档</span>
          </div>
          <div class="document-bar" aria-hidden="true">
            <span
              v-for="state in documentStates"
              :key="state.label"
              :class="state.className"
              :style="{ width: `${(state.count / documents.length) * 100}%` }"
            ></span>
          </div>
          <div class="document-legend">
            <div v-for="state in documentStates" :key="state.label">
              <span class="legend-dot" :class="state.className"></span><span>{{ state.label }}</span
              ><strong>{{ state.count }}</strong>
            </div>
          </div>
        </div>
        <p class="panel-footnote muted">
          {{
            documentFailures
              ? `未统计知识库：${failedKnowledgeNames.join('、')}`
              : '这是文档业务状态快照，不是实时性能监控。'
          }}
        </p>
      </article>
    </section>

    <section class="overview-grid">
      <article class="panel overview-panel">
        <div class="section-heading">
          <div>
            <h2>最近创建的知识库</h2>
            <p class="muted">沉淀资料，让知识随时可用</p>
          </div>
          <Button label="查看全部" text size="small" @click="$router.push('/knowledge')" />
        </div>
        <div v-if="loading" class="loading-stack">
          <Skeleton v-for="n in 3" :key="n" height="3.5rem" />
        </div>
        <div v-else-if="!loaded.knowledge" class="empty-state">
          <p>知识库加载失败</p>
          <Button label="重试" text @click="refresh" />
        </div>
        <div v-else-if="!recentKnowledge.length" class="empty-state">
          <i class="pi pi-book" aria-hidden="true"></i>
          <p>还没有知识库</p>
          <Button label="前往创建" text @click="$router.push('/knowledge')" />
        </div>
        <div v-else class="resource-list">
          <RouterLink
            v-for="kb in recentKnowledge"
            :key="kb.id"
            :to="`/knowledge/${encodeURIComponent(kb.id)}`"
            class="resource-row"
          >
            <span class="resource-icon violet"><i class="pi pi-book" aria-hidden="true"></i></span>
            <div class="resource-copy">
              <strong>{{ kb.name }}</strong
              ><span class="muted">{{ kb.description || '暂无描述' }}</span>
            </div>
            <span class="resource-date muted">{{ formatDate(kb.createdAt) }}</span
            ><i class="pi pi-angle-right muted" aria-hidden="true"></i>
          </RouterLink>
        </div>
      </article>
      <article class="panel overview-panel">
        <div class="section-heading">
          <div>
            <h2>最近的对话</h2>
            <p class="muted">回到你的思考与探索</p>
          </div>
          <Button label="进入对话" text size="small" @click="$router.push('/chat')" />
        </div>
        <div v-if="loading" class="loading-stack">
          <Skeleton v-for="n in 3" :key="n" height="3.5rem" />
        </div>
        <div v-else-if="!loaded.conversations" class="empty-state">
          <p>会话加载失败</p>
          <Button label="重试" text @click="refresh" />
        </div>
        <div v-else-if="!recentConversations.length" class="empty-state">
          <i class="pi pi-comments" aria-hidden="true"></i>
          <p>还没有开始对话</p>
          <Button label="开始第一次对话" text @click="$router.push('/chat')" />
        </div>
        <div v-else class="resource-list">
          <div
            v-for="conversation in recentConversations"
            :key="conversation.id"
            class="resource-row"
          >
            <span class="resource-icon blue"><i class="pi pi-comment" aria-hidden="true"></i></span>
            <div class="resource-copy">
              <strong>{{ conversation.title }}</strong
              ><span class="muted">{{ modelName(conversation.modelId) }}</span>
            </div>
            <span class="resource-date muted">{{ formatDate(conversation.updatedAt) }}</span>
          </div>
        </div>
      </article>
    </section>
    <footer class="dashboard-footer">
      <span class="muted"
        ><i class="pi pi-shield" aria-hidden="true"></i>
        所有统计仅基于当前账号可访问的业务数据</span
      ><Button
        v-if="auth.isAdmin"
        label="管理团队权限"
        icon="pi pi-users"
        text
        size="small"
        @click="$router.push('/users')"
      />
    </footer>
  </div>
</template>

<style scoped>
.dashboard-view {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.page-header h1 {
  margin: 0.4rem 0;
}
.page-header p {
  margin: 0;
}
.refresh-time {
  font-size: 0.75rem;
}
.mode-note {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  padding: 0.85rem 1rem;
  border: 1px solid #bfdbfe;
  border-radius: 10px;
  background: #eff6ff;
  color: #1e40af;
  font-size: 0.82rem;
  line-height: 1.6;
}
.mode-note i {
  margin-top: 0.25rem;
}
.dashboard-errors {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
}
.dashboard-errors ul {
  margin: 0.5rem 0 0;
  padding-left: 1.2rem;
  overflow-wrap: anywhere;
}
.welcome-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  overflow: hidden;
  min-height: 238px;
  padding: 2rem 2.25rem;
  border: 1px solid #dce7f5;
  border-radius: 16px;
  background: linear-gradient(110deg, #fff 25%, #f0f6ff 100%);
}
.welcome-copy h2 {
  font-size: clamp(1.5rem, 3vw, 2rem);
  letter-spacing: -0.035em;
  margin: 1rem 0 0.6rem;
  color: #172b4d;
}
.welcome-copy p {
  color: #64748b;
  margin: 0 0 1.5rem;
}
.welcome-visual {
  position: relative;
  flex: 0 0 270px;
  height: 190px;
  background: radial-gradient(ellipse, #dbeafe 0%, transparent 70%);
}
.visual-node {
  position: absolute;
  display: grid;
  place-items: center;
  background: #fff;
  border: 1px solid #dbe7f5;
  border-radius: 20px;
  color: #3b82f6;
  box-shadow: 0 12px 28px #1e40af0a;
}
.visual-node i {
  font-size: 1.8rem;
}
.node-one {
  width: 66px;
  height: 66px;
  top: 22px;
  left: 18px;
  transform: rotate(-12deg);
}
.node-two {
  width: 90px;
  height: 90px;
  top: 48px;
  left: 94px;
  z-index: 1;
  background: #2563eb;
  color: #fff;
}
.node-three {
  width: 64px;
  height: 64px;
  top: 14px;
  right: 10px;
  transform: rotate(12deg);
  color: #8b5cf6;
}
.visual-caption {
  position: absolute;
  bottom: 10px;
  left: 76px;
  font-size: 0.75rem;
  letter-spacing: 0.15em;
  color: #64748b;
}
.dashboard-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1rem;
}
.dashboard-stat {
  padding: 1.25rem;
  min-width: 0;
}
.stat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  color: #64748b;
  font-size: 0.85rem;
}
.stat-icon,
.resource-icon {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  flex-shrink: 0;
}
.blue {
  color: #2563eb;
  background: #eff6ff;
}
.violet {
  color: #7c3aed;
  background: #f5f3ff;
}
.teal {
  color: #0f766e;
  background: #f0fdfa;
}
.amber {
  color: #b45309;
  background: #fffbeb;
}
.stat-number {
  display: block;
  margin: 0.8rem 0 0.5rem;
  color: #182b49;
  font-size: 2.2rem;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.04em;
}
.stat-skeleton {
  margin: 0.8rem 0 0.5rem;
}
.stat-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  min-height: 38px;
  font-size: 0.72rem;
  line-height: 1.5;
}
.stat-bottom :deep(button) {
  flex-shrink: 0;
}
.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1.25rem;
}
.overview-panel {
  padding: 1.5rem;
  min-width: 0;
}
.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.6rem;
  margin-bottom: 1.3rem;
}
.section-heading h2 {
  font-size: 1rem;
  color: #1e293b;
  margin: 0 0 0.4rem;
}
.section-heading p {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.5;
}
.section-heading :deep(button) {
  flex-shrink: 0;
}
.loading-stack {
  display: grid;
  gap: 0.7rem;
}
.model-distribution {
  display: grid;
  gap: 1.5rem;
  padding: 0.5rem 0;
}
.model-type-row {
  display: grid;
  grid-template-columns: 20px 75px 1fr 30px;
  align-items: center;
  gap: 0.7rem;
  font-size: 0.85rem;
}
.model-type-row > i {
  color: #64748b;
}
.model-type-row strong {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.distribution-track {
  height: 6px;
  background: #f1f5f9;
  border-radius: 4px;
  overflow: hidden;
}
.distribution-track span {
  height: 100%;
  display: block;
  background: #60a5fa;
  border-radius: inherit;
}
.panel-footnote {
  border-top: 1px solid #eef2f6;
  padding-top: 1rem;
  margin: 1.4rem 0 0;
  font-size: 0.75rem;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.document-total {
  display: flex;
  align-items: baseline;
  gap: 0.65rem;
  margin-bottom: 1.2rem;
}
.document-total strong {
  font-size: 2.1rem;
  color: #1e293b;
}
.document-total span {
  font-size: 0.8rem;
}
.document-bar {
  display: flex;
  width: 100%;
  height: 10px;
  border-radius: 6px;
  overflow: hidden;
  background: #f1f5f9;
}
.ready {
  background: #14b8a6;
}
.processing {
  background: #60a5fa;
}
.failed {
  background: #f87171;
}
.document-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-top: 1.4rem;
  font-size: 0.8rem;
}
.document-legend > div {
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.legend-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
.resource-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 0;
  border-bottom: 1px solid #f1f5f9;
  color: inherit;
  text-decoration: none;
}
.resource-row:last-child {
  border-bottom: none;
}
a.resource-row:hover {
  background: #f8fafc;
}
a.resource-row:focus-visible {
  outline: 2px solid #3b82f6;
  outline-offset: 3px;
}
.resource-copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.resource-copy strong {
  font-size: 0.85rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resource-copy > span {
  font-size: 0.75rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resource-date {
  flex-shrink: 0;
  font-size: 0.72rem;
}
.empty-state {
  min-height: 150px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.45rem;
}
.empty-state > i {
  color: #94a3b8;
  font-size: 1.5rem;
}
.empty-state p {
  color: #64748b;
  font-size: 0.85rem;
  margin: 0.4rem 0;
}
.dashboard-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.6rem;
  font-size: 0.75rem;
}
.dashboard-footer i {
  margin-right: 0.4rem;
}
@media (max-width: 1100px) {
  .dashboard-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .welcome-visual {
    flex-basis: 240px;
  }
}
@media (max-width: 760px) {
  .overview-grid {
    grid-template-columns: 1fr;
  }
  .welcome-visual {
    display: none;
  }
  .welcome-card {
    padding: 1.5rem;
    min-height: auto;
  }
  .refresh-time {
    display: none;
  }
  .dashboard-errors {
    flex-direction: column;
  }
}
@media (max-width: 480px) {
  .dashboard-stats {
    grid-template-columns: 1fr;
  }
  .overview-panel {
    padding: 1rem;
  }
  .resource-date {
    display: none;
  }
  .section-heading {
    flex-wrap: wrap;
  }
}
</style>
