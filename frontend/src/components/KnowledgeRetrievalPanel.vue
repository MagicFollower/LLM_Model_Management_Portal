<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import InputNumber from 'primevue/inputnumber'
import Tag from 'primevue/tag'
import ToggleSwitch from 'primevue/toggleswitch'
import ProgressSpinner from 'primevue/progressspinner'
import {
  RETRIEVAL_MODEL_ID,
  getRetrievalMode,
  retrievalHealth,
  loadRetrievalModel,
} from '@/api/retrieval'
import { searchKnowledgeBases } from '@/mock'
import type { KnowledgeSearchResult, RetrievalHealth } from '@/types/retrieval'

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : '检索服务发生未知错误。'

export default defineComponent({
  name: 'KnowledgeRetrievalPanel',
  components: { Button, InputText, InputNumber, Tag, ToggleSwitch, ProgressSpinner },
  props: {
    knowledgeBaseId: { type: String, required: true },
  },
  data() {
    return {
      modelId: RETRIEVAL_MODEL_ID,
      health: null as RetrievalHealth | null,
      healthError: '',
      healthLoading: false,
      loadingModel: false,
      loadError: '',
      pollTimer: null as ReturnType<typeof setInterval> | null,
      query: '',
      topK: 5,
      minScore: 0.3,
      enableBm25: false,
      enableRerank: false,
      searching: false,
      searchError: '',
      result: null as KnowledgeSearchResult | null,
      searched: false,
      retrievalMode: getRetrievalMode(),
    }
  },
  computed: {
    isLocal(): boolean {
      return this.retrievalMode === 'local'
    },
    rerankerStatus(): { label: string; severity: 'success' | 'info' | 'warn' | 'danger' } | null {
      const r = this.health?.reranker
      if (!r) return null
      switch (r.status) {
        case 'ready': return { label: 'Reranker 就绪', severity: 'success' }
        case 'loading': return { label: 'Reranker 加载中', severity: 'warn' }
        case 'error': return { label: 'Reranker 加载失败', severity: 'danger' }
        default: return { label: 'Reranker 未加载', severity: 'info' }
      }
    },
    canSearch(): boolean {
      return (
        this.isLocal &&
        this.health?.status === 'ready' &&
        !this.searching &&
        this.query.trim().length > 0
      )
    },
    statusSeverity(): 'info' | 'success' | 'warn' | 'danger' | 'secondary' {
      if (!this.health) return 'secondary'
      switch (this.health.status) {
        case 'ready':
          return 'success'
        case 'loading':
          return 'warn'
        case 'error':
          return 'danger'
        default:
          return 'info'
      }
    },
    statusLabel(): string {
      if (!this.health) return '未检测'
      switch (this.health.status) {
        case 'ready':
          return '模型就绪'
        case 'loading':
          return '模型加载中'
        case 'error':
          return '模型加载失败'
        default:
          return '模型未加载'
      }
    },
    /** 根据启用的检索模式返回分数范围配置 */
    minScoreConfig(): { min: number; max: number; step: number; hint: string; default: number } {
      if (this.enableRerank) {
        // Reranker 归一化分数 [0, 1]（优先级最高，因为最终分数来自 Reranker）
        return { min: 0, max: 1, step: 0.05, default: 0.3, hint: 'Reranker 归一化分数 ∈ [0, 1]' }
      }
      if (this.enableBm25) {
        // RRF 融合分数范围 (0, 0.02]，minScore 不适用
        return { min: 0, max: 0.05, step: 0.001, default: 0, hint: 'RRF 融合模式：分数为排名加权，已自动按 topK 截断，无需阈值' }
      }
      // 纯向量检索：余弦相似度 [-1, 1]
      return { min: -1, max: 1, step: 0.05, default: 0.3, hint: '向量余弦相似度 ∈ [-1, 1]' }
    },
  },
  watch: {
    enableBm25() { this._syncMinScore() },
    enableRerank() { this._syncMinScore() },
  },
  mounted() {
    if (this.isLocal) void this.checkHealth()
  },
  beforeUnmount() {
    this.clearPoll()
  },
  methods: {
    async checkHealth() {
      if (!this.isLocal) return
      this.healthLoading = true
      this.healthError = ''
      try {
        this.health = await retrievalHealth()
      } catch (error) {
        this.health = null
        this.healthError = errorMessage(error)
      } finally {
        this.healthLoading = false
      }
    },
    async loadModel() {
      if (!this.isLocal || this.loadingModel) return
      this.loadingModel = true
      this.loadError = ''
      try {
        const status = await loadRetrievalModel()
        this.health = status
        if (status.status === 'loading') this.startPoll()
        else if (status.status === 'error')
          this.loadError = status.error ?? '模型加载失败，请检查网络或模型路径。'
      } catch (error) {
        this.loadError = errorMessage(error)
      } finally {
        this.loadingModel = false
      }
    },
    startPoll() {
      this.clearPoll()
      this.pollTimer = setInterval(async () => {
        if (!this.isLocal) {
          this.clearPoll()
          return
        }
        try {
          const status = await retrievalHealth()
          this.health = status
          if (status.status !== 'loading') this.clearPoll()
        } catch {
          /* 轮询期间网络抖动不中断，下次轮询再试 */
        }
      }, 2000)
    },
    clearPoll() {
      if (this.pollTimer !== null) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    },
    async runSearch() {
      if (!this.canSearch) return
      this.searching = true
      this.searchError = ''
      this.result = null
      const controller = new AbortController()
      try {
        this.result = await searchKnowledgeBases(
          [this.knowledgeBaseId],
          this.query.trim(),
          {
            topK: this.topK,
            minScore: this.minScore,
            enableBm25: this.enableBm25,
            enableRerank: this.enableRerank,
          },
          controller.signal,
        )
        this.searched = true
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          this.searchError = '检索已中止。'
        } else {
          this.searchError = errorMessage(error)
        }
        this.result = null
      } finally {
        this.searching = false
      }
    },
    cancelSearch() {
      this.searching = false
    },
    severityForScore(score: number): 'success' | 'info' | 'warn' | 'danger' {
      if (score >= 0.7) return 'success'
      if (score >= 0.5) return 'info'
      if (score >= 0.3) return 'warn'
      return 'danger'
    },
    _syncMinScore() {
      const cfg = this.minScoreConfig
      if (this.minScore < cfg.min || this.minScore > cfg.max) {
        this.minScore = cfg.default
      }
    },
  },
})
</script>

<template>
  <section v-if="isLocal" class="retrieval-panel panel" aria-label="知识库检索测试区">
    <header class="retrieval-header">
      <div>
        <h2>检索测试</h2>
        <p class="muted">
          使用本地 {{ modelId }} 实际计算向量与相似度，回答仍为模板模拟。
        </p>
      </div>
      <Tag :value="statusLabel" :severity="statusSeverity" />
    </header>

    <div v-if="healthError" class="retrieval-error" role="alert">
      <span>{{ healthError }}</span>
      <Button label="重试检测" size="small" :loading="healthLoading" @click="checkHealth" />
    </div>

    <div v-if="health" class="health-info">
      <dl class="health-meta">
        <div><dt>模型</dt><dd>{{ health.modelId }}</dd></div>
        <div><dt>维度</dt><dd>{{ health.dimension }}</dd></div>
        <div><dt>设备</dt><dd>{{ health.device }}</dd></div>
      </dl>
      <div v-if="rerankerStatus" class="reranker-status">
        <Tag :value="rerankerStatus.label" :severity="rerankerStatus.severity" />
        <span v-if="health.reranker?.error" class="muted">{{ health.reranker.error }}</span>
      </div>
      <div v-if="health.status === 'error' && health.error" class="retrieval-error">
        {{ health.error }}
      </div>
      <div class="button-row">
        <Button
          v-if="health.status === 'unloaded' || health.status === 'error'"
          :label="health.status === 'error' ? '重试加载' : '加载模型'"
          icon="pi pi-download"
          size="small"
          :loading="loadingModel"
          @click="loadModel"
        />
        <Button
          v-if="health.status === 'loading'"
          label="加载中…"
          icon="pi pi-spin pi-spinner"
          size="small"
          severity="secondary"
          disabled
        />
        <Button
          v-if="health.status === 'ready'"
          label="刷新状态"
          icon="pi pi-refresh"
          size="small"
          severity="secondary"
          outlined
          :loading="healthLoading"
          @click="checkHealth"
        />
      </div>
    </div>
    <div v-else-if="healthLoading" class="loading-row">
      <ProgressSpinner class="small-spinner" />
      <span class="muted">正在检测模型状态…</span>
    </div>

    <div v-if="loadError" class="retrieval-error" role="alert">{{ loadError }}</div>

    <div v-if="health?.status === 'ready'" class="search-controls">
      <div class="search-row">
        <InputText
          v-model="query"
          placeholder="输入检索问题，例如：差旅报销需要什么材料？"
          aria-label="检索查询"
          fluid
          :disabled="searching"
          @keydown.enter.prevent="runSearch"
        />
        <Button
          label="检索"
          icon="pi pi-search"
          :disabled="!canSearch"
          :loading="searching"
          @click="runSearch"
        />
      </div>
      <div class="param-row">
        <div class="param-field">
          <label for="retrieval-topk">Top-K</label>
          <InputNumber
            id="retrieval-topk"
            v-model="topK"
            :min="1"
            :max="20"
            :use-grouping="false"
            :max-fraction-digits="0"
            input-id="retrieval-topk"
            fluid
          />
        </div>
        <div class="param-field">
          <label for="retrieval-min-score">最低分数</label>
          <InputNumber
            id="retrieval-min-score"
            v-model="minScore"
            :min="minScoreConfig.min"
            :max="minScoreConfig.max"
            :step="minScoreConfig.step"
            :max-fraction-digits="minScoreConfig.step < 0.01 ? 3 : 2"
            :disabled="enableBm25"
            fluid
          />
          <span class="muted param-hint">{{ minScoreConfig.hint }}</span>
        </div>
      </div>
      <div class="toggle-row">
        <div class="toggle-field">
          <label for="retrieval-bm25">BM25 关键词检索</label>
          <ToggleSwitch
            id="retrieval-bm25"
            v-model="enableBm25"
            input-id="retrieval-bm25"
            :disabled="searching"
          />
          <span class="muted toggle-hint">字符 bigram 关键词召回，与向量检索 RRF 融合</span>
        </div>
        <div class="toggle-field">
          <label for="retrieval-rerank">Reranker 重排序</label>
          <ToggleSwitch
            id="retrieval-rerank"
            v-model="enableRerank"
            input-id="retrieval-rerank"
            :disabled="searching"
          />
          <span class="muted toggle-hint">bge-reranker-v2-m3 精排，对候选列表做交叉编码重排序</span>
        </div>
      </div>
    </div>

    <div v-if="searchError" class="retrieval-error" role="alert">
      <span>{{ searchError }}</span>
    </div>

    <div v-if="searching" class="loading-row" role="status">
      <ProgressSpinner class="small-spinner" />
      <span class="muted">正在执行向量检索…</span>
    </div>

    <div v-else-if="result" class="results-area">
      <div class="results-summary">
        <span class="muted">
          参与 {{ result.totalChunks }} 个片段，命中 {{ result.hits.length }} 条；
          耗时 {{ result.elapsedMs.toFixed(1) }} ms
          <template v-if="result.excludedDocuments > 0">
            ；已排除 {{ result.excludedDocuments }} 份 PDF/DOCX 占位文档
          </template>
        </span>
      </div>
      <div v-if="!result.hits.length" class="empty-results">
        <template v-if="result.totalChunks === 0">
          <p>没有可参与检索的就绪 TXT/MD 正文片段。请先上传并处理文档。</p>
        </template>
        <template v-else>
          <p>当前阈值下没有命中，可以降低最低分数或修改查询后重试。</p>
        </template>
      </div>
      <ol v-else class="hit-list">
        <li v-for="(hit, rank) in result.hits" :key="hit.chunkId" class="hit-card">
          <div class="hit-header">
            <Tag :value="`#${rank + 1}`" severity="secondary" />
            <span class="hit-document">{{ hit.documentName }}</span>
            <Tag :value="hit.score.toFixed(4)" :severity="severityForScore(hit.score)" />
          </div>
          <div class="hit-meta muted">
            <span>{{ hit.section }}</span>
            <span v-if="hit.page != null">· 页 {{ hit.page }}</span>
            <span>· 片段版本 v{{ hit.version }}</span>
          </div>
          <p class="hit-content">{{ hit.content }}</p>
        </li>
      </ol>
    </div>

    <div v-else-if="searched && !searchError" class="empty-results">
      <p>尚未执行检索。</p>
    </div>

    <div v-if="!isLocal" class="retrieval-error">
      检索模式不是 local，不展示本地检索面板。
    </div>
  </section>

  <section v-else class="panel retrieval-demo-notice" aria-label="演示检索说明">
    <p>
      <i class="pi pi-info-circle" aria-hidden="true" />
      当前为 demo 模式，不进行真实向量检索。如需体验本地 BGE 检索，请将
      <code>VITE_RETRIEVAL_MODE</code> 设为 <code>local</code> 并启动本地服务。
    </p>
  </section>
</template>

<style scoped>
.retrieval-panel {
  display: grid;
  gap: 1rem;
  padding: 1.2rem;
  margin-top: 1.2rem;
}
.retrieval-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
}
.retrieval-header h2 {
  margin: 0 0 0.3rem;
  font-size: 1.1rem;
}
.health-info {
  display: grid;
  gap: 0.6rem;
  padding: 0.8rem;
  background: #f8fafc;
  border-radius: 8px;
}
.health-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin: 0;
  font-size: 0.8125rem;
}
.health-meta > div {
  display: flex;
  gap: 0.3rem;
}
.health-meta dt {
  color: #64748b;
}
.health-meta dd {
  margin: 0;
  font-weight: 600;
  color: #334155;
}
.search-controls {
  display: grid;
  gap: 0.8rem;
}
.search-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.search-row > :first-child {
  flex: 1;
}
.param-row {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}
.param-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  min-width: 120px;
}
.param-field label {
  font-size: 0.8125rem;
  color: #475569;
}
.param-field :deep(.p-inputnumber-input) {
  width: 100%;
}
.param-hint {
  font-size: 0.75rem;
  color: #94a3b8;
  line-height: 1.3;
}
.toggle-row {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
  padding-top: 0.3rem;
  border-top: 1px solid #e2e8f0;
}
.toggle-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  align-items: flex-start;
}
.toggle-field label {
  font-size: 0.8125rem;
  color: #475569;
  font-weight: 500;
}
.toggle-hint {
  font-size: 0.75rem;
  color: #94a3b8;
}
.reranker-status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.retrieval-error {
  padding: 0.7rem 0.85rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  color: #991b1b;
  border-radius: 8px;
  font-size: 0.875rem;
}
.loading-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.875rem;
}
.small-spinner {
  width: 28px;
  height: 28px;
}
.results-area {
  display: grid;
  gap: 0.8rem;
}
.results-summary {
  font-size: 0.8125rem;
}
.empty-results {
  padding: 1rem;
  background: #f8fafc;
  border-radius: 8px;
  color: #475569;
  font-size: 0.875rem;
}
.empty-results p {
  margin: 0;
}
.hit-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.8rem;
}
.hit-card {
  padding: 0.85rem;
  border: 1px solid #e2e8f0;
  border-radius: 10px;
  background: #fff;
}
.hit-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.4rem;
}
.hit-document {
  font-weight: 600;
  font-size: 0.875rem;
  color: #0f172a;
}
.hit-meta {
  font-size: 0.75rem;
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.hit-content {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.65;
  color: #334155;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 200px;
  overflow-y: auto;
  padding: 0.5rem;
  background: #f8fafc;
  border-radius: 6px;
}
.retrieval-demo-notice {
  margin-top: 1.2rem;
  padding: 1rem;
  font-size: 0.875rem;
  color: #475569;
}
.retrieval-demo-notice i {
  margin-right: 0.4rem;
}
.button-row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
@media (max-width: 600px) {
  .search-row {
    flex-direction: column;
    align-items: stretch;
  }
  .param-row {
    flex-direction: column;
  }
}
</style>
