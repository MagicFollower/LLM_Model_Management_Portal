<template>
  <section class="chat-page" aria-label="知识对话工作台">
    <header class="page-header chat-heading">
      <div>
        <span class="eyebrow">KNOWLEDGE WORKSPACE</span>
        <h1>知识对话</h1>
        <p class="muted">让每一次回答，都有迹可循。</p>
      </div>
      <div class="button-row">
        <Tag :value="isMock ? 'Mock 数据 · 模板回答' : '真实 API 模式'" :severity="isMock ? 'warn' : 'info'" />
        <Button
          label="刷新"
          icon="pi pi-refresh"
          severity="secondary"
          outlined
          :disabled="interactionLocked"
          @click="loadPage"
        />
      </div>
    </header>

    <div v-if="isMock" class="mock-notice" role="note">
      <i class="pi pi-info-circle" aria-hidden="true"></i>
      <div>
        <strong>回答仍为模板模拟，不是 Chat 模型输出</strong>
        <span v-if="retrievalMode === 'local'">
          当前 local：关联知识库时使用固定 BGE 本地 CPU 真实检索；请先在知识库详情加载本地模型。
          服务不可用会报错，不会自动切换 demo；未关联知识库不需要检索服务。
        </span>
        <span v-else-if="retrievalMode === 'demo'">
          当前 demo：离线固定分数与引用演示，不进行真实向量检索，也不调用本地模型健康接口。
        </span>
        <span v-else>检索模式配置无效，请将 VITE_RETRIEVAL_MODE 设置为 local 或 demo 后重新启动。</span>
        <span>
          TXT / MD 为真实正文切分，上传与处理阶段仍模拟；PDF / DOCX 占位不参与真实检索。
          原模型管理配置未自动接通，本地测试固定使用 BAAI/bge-small-zh-v1.5，不执行 Rerank。
          历史 demo 引用仍为演示，不随当前模式改变。请勿输入敏感信息。
        </span>
      </div>
    </div>
    <div v-if="pageError" class="error-banner feedback" role="alert">
      <span>{{ pageError }}</span
      ><Button
        label="重新加载"
        icon="pi pi-refresh"
        size="small"
        :disabled="interactionLocked"
        @click="loadPage"
      />
    </div>
    <div v-if="pageLoading" class="loading-layout" aria-busy="true" aria-label="正在加载对话工作台">
      <div class="panel">
        <Skeleton width="70%" height="2rem" /><Skeleton v-for="n in 5" :key="n" height="3.5rem" />
      </div>
      <div class="panel">
        <Skeleton width="40%" height="2rem" /><Skeleton height="9rem" /><Skeleton
          width="75%"
          height="6rem"
        />
      </div>
    </div>

    <div
      v-else-if="initialized"
      class="chat-workspace"
      :class="{ 'with-citation': citationVisible && !narrow }"
    >
      <aside class="panel conversation-panel" aria-label="会话列表">
        <div class="sidebar-top">
          <div>
            <h2>我的会话</h2>
            <span class="muted">{{ conversations.length }} 个会话</span>
          </div>
          <Button
            icon="pi pi-plus"
            label="新建"
            size="small"
            :disabled="interactionLocked"
            @click="openCreate()"
          />
        </div>
        <div class="search-box">
          <i class="pi pi-search" aria-hidden="true"></i
          ><InputText v-model="search" aria-label="搜索会话标题" placeholder="搜索会话…" fluid />
        </div>
        <div v-if="listError" class="error-banner feedback sidebar-error" role="alert">
          <span>{{ listError }}</span
          ><Button
            label="重试列表"
            size="small"
            text
            :disabled="interactionLocked"
            @click="reloadList"
          />
        </div>
        <nav class="conversation-list" aria-label="选择会话">
          <div
            v-for="conversation in filteredConversations"
            :key="conversation.id"
            class="conversation-item"
            :class="{ selected: activeId === conversation.id }"
          >
            <button
              type="button"
              class="conversation-select"
              :disabled="interactionLocked"
              :aria-current="activeId === conversation.id ? 'true' : undefined"
              @click="selectConversation(conversation.id)"
            >
              <i class="pi pi-comment" aria-hidden="true"></i
              ><span
                ><strong :title="conversation.title">{{
                  conversation.title || '未命名会话'
                }}</strong
                ><small>{{ formatTime(conversation.updatedAt) }}</small></span
              >
            </button>
            <div class="conversation-actions">
              <Button
                icon="pi pi-pencil"
                text
                rounded
                size="small"
                :aria-label="`重命名 ${conversation.title}`"
                :disabled="interactionLocked"
                @click="openAction('rename', conversation)"
              /><Button
                icon="pi pi-trash"
                text
                rounded
                size="small"
                severity="secondary"
                :aria-label="`删除 ${conversation.title}`"
                :disabled="interactionLocked"
                @click="openAction('delete', conversation)"
              />
            </div>
          </div>
          <div v-if="!filteredConversations.length" class="empty-state sidebar-empty">
            <i class="pi pi-comments" aria-hidden="true"></i
            ><strong>{{ search.trim() ? '没有匹配的会话' : '你的第一个问题，从这里开始' }}</strong>
            <p class="muted">
              {{ search.trim() ? '试试其他关键词，或清空搜索。' : '新建会话，选择模型与知识库。' }}
            </p>
            <Button v-if="search.trim()" label="清空搜索" text @click="search = ''" /><Button
              v-else
              label="新建会话"
              outlined
              :disabled="interactionLocked"
              @click="openCreate()"
            />
          </div>
        </nav>
        <footer class="sidebar-footer">
          <i class="pi pi-lock" aria-hidden="true"></i>仅展示当前账号可访问的会话
        </footer>
      </aside>

      <main class="panel message-panel" aria-label="对话消息">
        <header class="thread-header">
          <div class="thread-title">
            <span class="thread-icon"><i class="pi pi-sparkles" aria-hidden="true"></i></span>
            <div>
              <h2>{{ activeConversation?.title || '与你的知识，开始对话' }}</h2>
              <p class="muted">
                {{
                  activeConversation
                    ? modelName(activeConversation.modelId)
                    : '选择模型 · 连接知识 · 追溯来源'
                }}
              </p>
            </div>
          </div>
          <Button
            v-if="activeConversation"
            label="对话配置"
            icon="pi pi-sliders-h"
            text
            :disabled="interactionLocked"
            @click="openConfig"
          />
        </header>
        <div v-if="activeConversation" class="context-bar">
          <i class="pi pi-database" aria-hidden="true"></i><span class="muted">知识范围</span
          ><span
            v-for="id in activeConversation.knowledgeBaseIds"
            :key="id"
            class="knowledge-chip"
            >{{ knowledgeName(id) }}</span
          ><span v-if="!activeConversation.knowledgeBaseIds.length" class="muted"
            >未关联知识库 · 通用对话</span
          >
        </div>
        <div v-if="configurationIssue" class="error-banner feedback" role="alert">
          <span>{{ configurationIssue }}</span
          ><Button
            label="调整配置"
            size="small"
            text
            :disabled="interactionLocked"
            @click="openConfig"
          />
        </div>
        <div v-if="generationError" class="error-banner feedback" role="alert">
          <span>{{ generationError }}</span
          ><Button
            label="刷新消息"
            size="small"
            text
            :disabled="interactionLocked"
            @click="retryHistory"
          />
        </div>
        <div v-if="cancelError" class="error-banner feedback" role="alert">
          <span>{{ cancelError }}</span
          ><Button
            v-if="generationId"
            label="重试停止"
            icon="pi pi-stop"
            size="small"
            severity="danger"
            :loading="stopping"
            :disabled="stopping"
            @click="stop"
          />
        </div>
        <div v-if="historyError && messages.length" class="error-banner feedback" role="alert">
          <span>{{ historyError }} 当前保留已加载的消息。</span
          ><Button
            label="重试同步"
            size="small"
            text
            :disabled="interactionLocked"
            @click="retryHistory"
          />
        </div>
        <div v-if="historyLoading && messages.length" class="notice-line" role="status">
          正在同步消息记录…
        </div>
        <div v-if="notice" class="notice-line" role="status">{{ notice }}</div>
        <div
          v-if="serverStreaming && !processing && !generationId"
          class="notice-line pending-notice"
          role="status"
        >
          历史中有未完成的回复，请刷新确认状态。{{
            pendingRequest
              ? '再次发送相同内容会沿用原请求标识。'
              : '为避免重复生成，暂不能发送新消息。'
          }}<Button
            label="刷新状态"
            size="small"
            text
            :disabled="interactionLocked"
            @click="retryHistory"
          />
        </div>

        <div
          ref="messageScroller"
          class="message-scroller"
          tabindex="0"
          aria-label="消息记录，可滚动查看"
          :aria-busy="historyLoading"
          @scroll="onMessageScroll"
        >
          <div v-if="historyLoading && !messages.length" class="history-loading">
            <Skeleton width="35%" height="1.5rem" /><Skeleton height="6rem" /><Skeleton
              width="65%"
              height="5rem"
            /><span class="muted">正在读取会话历史…</span>
          </div>
          <div
            v-else-if="historyError && !messages.length"
            class="empty-state history-error"
            role="alert"
          >
            <i class="pi pi-exclamation-circle" aria-hidden="true"></i>
            <h3>消息暂时无法加载</h3>
            <p>{{ historyError }}</p>
            <Button
              label="重试加载历史"
              icon="pi pi-refresh"
              :disabled="interactionLocked"
              @click="retryHistory"
            />
          </div>
          <div v-else-if="!messages.length" class="welcome-state empty-state">
            <span class="welcome-symbol"><i class="pi pi-sparkles" aria-hidden="true"></i></span
            ><span class="eyebrow">从提问到有依据的答案</span>
            <h2>{{ activeConversation ? '今天，想了解什么？' : '让知识不止于存储' }}</h2>
            <p class="muted">
              {{
                activeConversation?.knowledgeBaseIds.length
                  ? '围绕已选知识库提问，点击回答中的引用核对原文。'
                  : '关联知识库，探索文档中的答案；也可以开启通用对话。'
              }}
            </p>
            <div class="prompt-grid">
              <button
                v-for="(prompt, index) in suggestedPrompts"
                :key="prompt"
                type="button"
                class="prompt-card"
                :disabled="interactionLocked || !!configurationIssue"
                @click="usePrompt(prompt)"
              >
                <i
                  :class="['pi', ['pi-book', 'pi-list-check', 'pi-search'][index]]"
                  aria-hidden="true"
                ></i
                ><span>{{ prompt }}</span
                ><i class="pi pi-arrow-up-right" aria-hidden="true"></i>
              </button>
            </div>
            <small class="muted">{{
              isMock
                ? '以下提问用于演示交互，模拟回复不代表事实。'
                : '回答可能存在偏差，请以原文与专业判断为准。'
            }}</small>
          </div>
          <div v-else class="message-list">
            <article
              v-for="message in messages"
              :key="message.id"
              class="message"
              :class="`message-${message.role}`"
            >
              <span class="message-avatar" :class="message.role"
                ><i
                  :class="['pi', message.role === 'user' ? 'pi-user' : 'pi-sparkles']"
                  aria-hidden="true"
                ></i
              ></span>
              <div class="message-body">
                <div class="message-meta">
                  <strong>{{
                    message.role === 'user' ? '你' : isMock ? '模拟助手' : '助手'
                  }}</strong
                  ><time :datetime="message.createdAt">{{ formatTime(message.createdAt) }}</time
                  ><Tag
                    v-if="message.status !== 'complete'"
                    :value="statusLabel(message.status)"
                    :severity="message.status === 'error' ? 'danger' : 'secondary'"
                  />
                </div>
                <div class="message-bubble">
                  <div v-if="message.content" class="message-text">{{ message.content }}</div>
                  <span v-else class="muted">{{
                    message.status === 'streaming'
                      ? usesLocalRetrieval
                        ? '正在检索/生成演示回复…'
                        : '正在准备回复…'
                      : message.status === 'cancelled'
                        ? '生成已取消，未返回正文。'
                        : message.status === 'error'
                          ? '本次生成失败，未返回正文。'
                          : '此消息没有正文。'
                  }}</span
                  ><span
                    v-if="message.status === 'streaming' && processing"
                    class="stream-cursor"
                    aria-hidden="true"
                  ></span>
                </div>
                <div
                  v-if="message.role === 'assistant' && message.citations.length"
                  class="message-citations"
                >
                  <span class="citation-caption"
                    ><i class="pi pi-link" aria-hidden="true"></i
                    >{{ message.citations.length }} 条引用 · 点击核对来源</span
                  >
                  <div class="citation-buttons">
                    <button
                      v-for="(citation, index) in message.citations"
                      :key="citation.id"
                      type="button"
                      class="citation-button"
                      :title="citation.documentName"
                      @click="openCitation(message.id, citation.id)"
                    >
                      <span>{{ index + 1 }}</span
                      ><span>{{ citation.documentName }}</span
                      ><small v-if="citation.page !== null">第 {{ citation.page }} 页</small
                      ><i class="pi pi-arrow-up-right" aria-hidden="true"></i>
                    </button>
                  </div>
                </div>
                <div v-if="message.role === 'assistant' && message.content" class="message-tools">
                  <Button
                    :label="copiedId === message.id ? '已复制' : '复制回答'"
                    :icon="copiedId === message.id ? 'pi pi-check' : 'pi pi-copy'"
                    text
                    size="small"
                    severity="secondary"
                    @click="copyMessage(message)"
                  />
                </div>
              </div>
            </article>
          </div>
        </div>
        <div v-if="!followBottom && messages.length" class="jump-row">
          <Button
            label="回到最新消息"
            icon="pi pi-arrow-down"
            size="small"
            rounded
            severity="secondary"
            @click="jumpToLatest"
          />
        </div>
        <div v-if="clipboardError" class="error-banner feedback" role="alert">
          {{ clipboardError }}
        </div>
        <footer class="composer-area">
          <div class="composer" :class="{ 'composer-busy': processing }">
            <Textarea
              ref="composerInput"
              v-model="draft"
              rows="3"
              fluid
              aria-label="输入消息"
              :invalid="!!draftError"
              :aria-describedby="usesLocalRetrieval ? 'chat-query-limit' : undefined"
              :placeholder="
                activeConversation
                  ? '输入你的问题，探索知识中的答案…'
                  : '先新建会话，选择模型和知识库…'
              "
              :disabled="!activeConversation || processing || !!generationId || historyLoading"
              @keydown="onComposerKeydown"
              @compositionstart="composing = true"
              @compositionend="composing = false"
            />
            <div class="toolbar composer-toolbar">
              <span class="muted">{{
                processing ? phaseLabel : 'Enter 发送 · Shift + Enter 换行'
              }}</span
              ><Button
                v-if="processing || generationId"
                :label="
                  stopping ? '正在停止' : generationId && !processing ? '重试停止' : '停止生成'
                "
                icon="pi pi-stop"
                severity="danger"
                :loading="stopping"
                :disabled="stopping || (phase === 'syncing' && !generationId)"
                @click="stop"
              /><Button
                v-else
                label="发送"
                icon="pi pi-arrow-up"
                :disabled="!canSend"
                @click="sendMessage"
              />
            </div>
          </div>
          <p
            v-if="usesLocalRetrieval"
            id="chat-query-limit"
            :class="draftError ? 'error-banner' : 'composer-disclaimer'"
            :role="draftError ? 'alert' : 'status'"
          >
            {{ draftError || `关联知识库的问题最多 2000 个 Unicode 码点，当前 ${draftLength} / 2000。` }}
          </p>
          <p class="composer-disclaimer">
            {{
              isMock
                ? retrievalMode === 'local'
                  ? 'local：关联库使用本地 CPU 真实检索 · 回答为模板模拟，不作为事实依据'
                  : retrievalMode === 'demo'
                    ? 'demo：固定分数演示 · 模板模拟回答，不作为事实依据'
                    : '检索模式配置无效 · 回答仍为模板模拟'
                : '模型回答仅供参考；引用相似度不等于答案准确率。'
            }}
          </p>
        </footer>
      </main>
    </div>

    <Dialog
      v-model:visible="formVisible"
      :header="formMode === 'new' ? '开启新的对话' : '对话配置'"
      modal
      :closable="!formBusy"
      :closeOnEscape="!formBusy"
      :style="{ width: 'min(560px, 94vw)' }"
    >
      <p class="muted">
        {{
          formMode === 'new'
            ? '选择一个可用的对话模型，并圈定本次对话的知识范围。'
            : '配置保存后仅影响后续提问，不会修改已有回答。'
        }}
      </p>
      <div v-if="formError" class="error-banner feedback" role="alert">{{ formError }}</div>
      <div class="form-grid chat-form">
        <div class="field">
          <label for="chat-title">会话名称</label
          ><InputText
            id="chat-title"
            v-model="form.title"
            maxlength="100"
            placeholder="例如：产品知识探索"
            :disabled="formBusy"
            fluid
          />
        </div>
        <div class="field">
          <label for="chat-model">对话模型 <span class="required-mark">*</span></label
          ><Select
            inputId="chat-model"
            v-model="form.modelId"
            :options="chatModels"
            optionLabel="name"
            optionValue="id"
            placeholder="选择已启用的 Chat 模型"
            :disabled="formBusy"
            fluid
          /><small class="muted">仅展示当前账号可访问且已启用的 Chat 模型。</small>
          <div v-if="!chatModels.length" class="error-banner feedback">
            没有可用对话模型。请联系管理员启用模型并授予访问权限。<Button
              label="重新获取可用资源"
              size="small"
              text
              :disabled="formBusy"
              @click="refreshFormResources"
            />
          </div>
        </div>
        <div class="field">
          <label for="chat-knowledge">关联知识库</label
          ><MultiSelect
            inputId="chat-knowledge"
            v-model="form.knowledgeBaseIds"
            :options="formKnowledgeOptions"
            optionLabel="name"
            optionValue="id"
            display="chip"
            filter
            placeholder="可多选；留空则为通用对话"
            :disabled="formBusy"
            :maxSelectedLabels="3"
            fluid
          /><small class="muted">{{
            knowledgeBases.length
              ? '只会在你有权访问的知识范围内检索，引用仍需再次鉴权。'
              : '暂无可访问知识库，可先开始通用对话。'
          }}</small>
        </div>
      </div>
      <template #footer
        ><Button
          label="取消"
          severity="secondary"
          text
          :disabled="formBusy"
          @click="formVisible = false" /><Button
          :label="formMode === 'new' ? '创建并开始' : '保存配置'"
          icon="pi pi-check"
          :loading="formBusy"
          :disabled="formBusy || !validForm"
          @click="saveForm"
      /></template>
    </Dialog>

    <Dialog
      :visible="!!actionMode"
      :header="actionMode === 'delete' ? '删除会话' : '重命名会话'"
      modal
      :closable="!actionBusy"
      :closeOnEscape="!actionBusy"
      :style="{ width: 'min(440px, 94vw)' }"
      @update:visible="closeAction"
    >
      <div v-if="actionError" class="error-banner feedback" role="alert">{{ actionError }}</div>
      <p v-if="actionMode === 'delete'" class="delete-warning">
        确定删除「{{ actionTarget?.title }}」及其消息记录吗？此操作无法撤销。
      </p>
      <div v-else class="field">
        <label for="chat-rename">会话名称</label
        ><InputText
          id="chat-rename"
          v-model="renameTitle"
          maxlength="100"
          :disabled="actionBusy"
          fluid
          @keydown.enter.prevent="submitAction"
        />
      </div>
      <template #footer
        ><Button
          label="取消"
          text
          severity="secondary"
          :disabled="actionBusy"
          @click="closeAction(false)" /><Button
          :label="actionMode === 'delete' ? '确认删除' : '保存名称'"
          :severity="actionMode === 'delete' ? 'danger' : 'primary'"
          :loading="actionBusy"
          :disabled="actionBusy || (actionMode === 'rename' && !renameTitle.trim())"
          @click="submitAction"
      /></template>
    </Dialog>

    <Drawer
      v-model:visible="citationVisible"
      position="right"
      :modal="narrow"
      :blockScroll="narrow"
      :dismissable="narrow"
      header="引用溯源"
      :style="{ width: 'min(420px, 100vw)' }"
    >
      <div class="citation-drawer">
        <div class="citation-intro">
          <span class="eyebrow">SOURCE EXPLORER</span>
          <p class="muted">核对回答依据，回到知识原文。</p>
        </div>
        <div v-if="citationLoading" class="citation-loading" aria-busy="true">
          <ProgressSpinner
            style="width: 32px; height: 32px"
            strokeWidth="4"
            aria-label="正在鉴权并加载引用"
          />
          <p class="muted">正在校验访问权限并读取引用…</p>
        </div>
        <div v-else-if="citationError" class="error-banner citation-failure" role="alert">
          <i class="pi pi-lock" aria-hidden="true"></i>
          <h3>暂时无法访问引用</h3>
          <p>{{ citationError }}</p>
          <Button label="重新鉴权并加载" icon="pi pi-refresh" @click="fetchCitation" />
        </div>
        <template v-else-if="citationDetail"
          ><div class="source-file">
            <span><i class="pi pi-file" aria-hidden="true"></i></span>
            <div>
              <h3>{{ citationDetail.documentName }}</h3>
              <p class="muted">{{ knowledgeName(citationDetail.knowledgeBaseId) }}</p>
            </div>
          </div>
          <dl class="source-metadata">
            <div>
              <dt>页码</dt>
              <dd>
                {{ citationDetail.page === null ? '未提供页码' : `第 ${citationDetail.page} 页` }}
              </dd>
            </div>
            <div>
              <dt>章节</dt>
              <dd>{{ citationDetail.section || '未提供章节' }}</dd>
            </div>
            <div>
              <dt>引用版本</dt>
              <dd>v{{ citationDetail.version }}</dd>
            </div>
            <div>
              <dt>引用 score（历史快照）</dt>
              <dd>{{ formatScore(citationDetail.score) }}</dd>
            </div>
          </dl>
          <p class="score-explanation">
            <i class="pi pi-info-circle" aria-hidden="true"></i
            >分数不是答案准确率，也不是可信度百分比。
            <span v-if="isMock">
              请以该条消息的生成说明区分来源：local 检索返回真实分数，demo 使用固定演示分数。
              旧演示引用不会因当前切换到 local 就变成真实检索结果。
            </span>
          </p>
          <div class="source-content-heading">
            <h3>完整引用内容</h3>
            <span class="muted">{{ Array.from(citationDetail.content).length }} 字符</span>
          </div>
          <div class="source-content">
            {{ citationDetail.content || '此引用没有可展示的内容。' }}
          </div>
          <div v-if="downloadError" class="error-banner feedback" role="alert">
            {{ downloadError }}
          </div>
          <Button
            :label="downloadError ? '重试下载原文' : '下载原文'"
            icon="pi pi-download"
            :loading="downloading"
            :disabled="downloading"
            fluid
            @click="downloadCitation"
          />
          <p class="muted download-hint">
            下载时再次校验权限；原文件可能已更新，请核对引用版本。
            <span v-if="isMock">历史 PDF / DOCX 演示引用只提供占位说明 TXT，不是原文件，也不参与真实检索。</span>
          </p></template
        >
      </div>
    </Drawer>
  </section>
</template>

<script lang="ts">
import { defineComponent, markRaw } from 'vue'
import type { RouteLocationNormalized } from 'vue-router'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Select from 'primevue/select'
import MultiSelect from 'primevue/multiselect'
import Textarea from 'primevue/textarea'
import Dialog from 'primevue/dialog'
import Drawer from 'primevue/drawer'
import Tag from 'primevue/tag'
import Skeleton from 'primevue/skeleton'
import ProgressSpinner from 'primevue/progressspinner'
import { api, isMock } from '@/api'
import { getRetrievalMode } from '@/api/retrieval'
import { useAuthStore } from '@/stores/auth'
import type {
  Citation,
  Conversation,
  ConversationInput,
  Generation,
  KnowledgeBase,
  Message,
  Model,
  StreamEvent,
} from '@/types'

type PendingRequest = { conversationId: string; content: string; clientRequestId: string }
type CitationRequest = { messageId: string; citationId: string }
type Phase = '' | 'creating' | 'connecting' | 'streaming' | 'syncing'
interface Runtime {
  disposed: boolean
  controller: AbortController | null
  request: Promise<Generation> | null
  work: Promise<void> | null
  cancellation: Promise<boolean> | null
  stopRequested: boolean
  historySeq: number
  citationSeq: number
  scrollQueued: boolean
  media: MediaQueryList | null
  mediaHandler: ((event: MediaQueryListEvent) => void) | null
  urls: Set<string>
  timers: Set<ReturnType<typeof setTimeout>>
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '请求失败，请稍后重试。'
}
function uniqueMessages(messages: Message[], conversationId: string): Message[] {
  // 与适配器持有的数据隔离，避免流式累积反向修改 Mock 的持久化对象。
  return Array.from(
    new Map(
      messages
        .filter((message) => message.conversationId === conversationId)
        .map((message) => [
          message.id,
          { ...message, citations: message.citations.map((citation) => ({ ...citation })) },
        ]),
    ).values(),
  )
}
function requestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) =>
        n.toString(16).padStart(8, '0'),
      ).join('')
}

export default defineComponent({
  name: 'ChatView',
  components: {
    Button,
    InputText,
    Select,
    MultiSelect,
    Textarea,
    Dialog,
    Drawer,
    Tag,
    Skeleton,
    ProgressSpinner,
  },
  data() {
    const runtime: Runtime = {
      disposed: false,
      controller: null,
      request: null,
      work: null,
      cancellation: null,
      stopRequested: false,
      historySeq: 0,
      citationSeq: 0,
      scrollQueued: false,
      media: null,
      mediaHandler: null,
      urls: new Set(),
      timers: new Set(),
    }
    return {
      isMock,
      runtime: markRaw(runtime),
      initialized: false,
      pageLoading: false,
      pageError: '',
      listError: '',
      models: [] as Model[],
      knowledgeBases: [] as KnowledgeBase[],
      conversations: [] as Conversation[],
      messages: [] as Message[],
      activeId: '',
      search: '',
      historyLoading: false,
      historyError: '',
      draft: '',
      drafts: {} as Record<string, string>,
      composing: false,
      followBottom: true,
      processing: false,
      stopping: false,
      phase: '' as Phase,
      generationId: '',
      assistantMessageId: '',
      generationError: '',
      cancelError: '',
      notice: '',
      pendingRequest: null as PendingRequest | null,
      formVisible: false,
      formMode: 'new' as 'new' | 'config',
      formBusy: false,
      formError: '',
      formPrompt: '',
      form: { title: '', modelId: '', knowledgeBaseIds: [] } as ConversationInput,
      actionMode: null as 'rename' | 'delete' | null,
      actionTarget: null as Conversation | null,
      actionBusy: false,
      actionError: '',
      renameTitle: '',
      citationVisible: false,
      citationLoading: false,
      citationError: '',
      citationDetail: null as Citation | null,
      citationRequest: null as CitationRequest | null,
      downloading: false,
      downloadError: '',
      narrow: true,
      copiedId: '',
      clipboardError: '',
    }
  },
  computed: {
    retrievalMode(): 'local' | 'demo' | null {
      if (!this.isMock) return null
      try {
        return getRetrievalMode()
      } catch {
        return null
      }
    },
    usesLocalRetrieval(): boolean {
      return (
        this.isMock &&
        this.retrievalMode === 'local' &&
        !!this.activeConversation?.knowledgeBaseIds.length
      )
    },
    draftLength(): number {
      return Array.from(this.draft.trim()).length
    },
    draftError(): string {
      return this.usesLocalRetrieval && this.draftLength > 2000
        ? '关联知识库的问题不能超过 2000 个 Unicode 码点（去除首尾空白），请缩短后发送。'
        : ''
    },
    chatModels(): Model[] {
      return this.models.filter((model) => model.type === 'chat' && model.enabled)
    },
    activeConversation(): Conversation | null {
      return this.conversations.find((item) => item.id === this.activeId) ?? null
    },
    filteredConversations(): Conversation[] {
      const query = this.search.trim().toLocaleLowerCase()
      return this.conversations
        .filter((item) => item.title.toLocaleLowerCase().includes(query))
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },
    interactionLocked(): boolean {
      return (
        this.pageLoading ||
        this.historyLoading ||
        this.processing ||
        this.stopping ||
        !!this.generationId ||
        this.formBusy ||
        this.actionBusy
      )
    },
    configurationIssue(): string {
      const conversation = this.activeConversation
      if (!conversation) return ''
      if (this.isMock && !this.retrievalMode && conversation.knowledgeBaseIds.length)
        return '检索模式无效，请配置 VITE_RETRIEVAL_MODE 为 local 或 demo 后重新启动。'
      if (!this.chatModels.some((model) => model.id === conversation.modelId))
        return '此会话的模型已停用、不可访问或不是 Chat 模型，请重新选择。'
      if (
        conversation.knowledgeBaseIds.some((id) => !this.knowledgeBases.some((kb) => kb.id === id))
      )
        return '部分关联知识库已不可访问，请调整知识范围后再发送。'
      return ''
    },
    validForm(): boolean {
      return (
        this.chatModels.some((model) => model.id === this.form.modelId) &&
        this.form.knowledgeBaseIds.every((id) => this.knowledgeBases.some((kb) => kb.id === id))
      )
    },
    formKnowledgeOptions(): { id: string; name: string }[] {
      return [
        ...this.knowledgeBases,
        ...this.form.knowledgeBaseIds
          .filter((id) => !this.knowledgeBases.some((kb) => kb.id === id))
          .map((id) => ({ id, name: `已不可用，请移除（${id}）` })),
      ]
    },
    serverStreaming(): boolean {
      return this.messages.some((message) => message.status === 'streaming')
    },
    canSend(): boolean {
      const retry =
        this.pendingRequest?.conversationId === this.activeId &&
        this.pendingRequest?.content === this.draft.trim()
      return (
        !!this.activeConversation &&
        !!this.draft.trim() &&
        !this.draftError &&
        !this.interactionLocked &&
        !this.historyError &&
        !this.configurationIssue &&
        !this.formVisible &&
        !this.actionMode &&
        (!this.serverStreaming || retry)
      )
    },
    phaseLabel(): string {
      return {
        creating: '正在创建生成任务…',
        connecting: '正在同步消息并连接…',
        streaming: this.usesLocalRetrieval ? '正在检索/生成演示回复…' : '正在生成回复…',
        syncing: '正在同步消息记录…',
        '': '',
      }[this.phase]
    },
    suggestedPrompts(): string[] {
      const names = this.activeConversation
        ? this.activeConversation.knowledgeBaseIds.map((id) => this.knowledgeName(id))
        : this.knowledgeBases.slice(0, 1).map((kb) => kb.name)
      if (!names.length)
        return [
          '帮我梳理一个复杂问题的分析步骤。',
          '帮我把一个工作目标拆解成可执行计划。',
          '如何提出一个清晰、具体的问题？',
        ]
      return [
        `请根据「${names[0]}」总结核心内容，并列出引用来源。`,
        `「${names[0]}」有哪些重要流程和注意事项？请提供原文依据。`,
        names.length > 1
          ? `对比「${names[0]}」和「${names[1]}」中的相关信息，并标明来源。`
          : `请从「${names[0]}」整理关键术语，并引用对应原文。`,
      ]
    },
  },
  watch: {
    citationVisible(visible: boolean): void {
      if (!visible) this.clearCitation()
    },
  },
  mounted() {
    this.runtime.media = window.matchMedia('(max-width: 1280px)')
    this.narrow = this.runtime.media.matches
    this.runtime.mediaHandler = (event) => {
      this.narrow = event.matches
    }
    this.runtime.media.addEventListener('change', this.runtime.mediaHandler)
    void this.loadPage()
  },
  async beforeRouteLeave(_to: RouteLocationNormalized): Promise<boolean> {
    if (!useAuthStore().user) {
      this.runtime.controller?.abort()
      return true
    }
    if (this.formBusy || this.actionBusy) return false
    if (this.processing || this.generationId) {
      const cancelled = await this.cancelGeneration(false)
      if (this.runtime.work) await this.runtime.work
      if (!cancelled || this.generationId) return false
    }
    return true
  },
  beforeUnmount() {
    this.runtime.disposed = true
    this.runtime.historySeq++
    this.runtime.citationSeq++
    this.runtime.controller?.abort()
    // 路由守卫负责可反馈的取消；此处仅处理父组件直接卸载等兜底场景。
    if (this.generationId && !this.runtime.cancellation)
      void api.cancel(this.generationId).catch(() => undefined)
    if (this.runtime.media && this.runtime.mediaHandler)
      this.runtime.media.removeEventListener('change', this.runtime.mediaHandler)
    this.runtime.urls.forEach((url) => URL.revokeObjectURL(url))
    this.runtime.timers.forEach((timer) => clearTimeout(timer))
  },
  methods: {
    modelName(id: string): string {
      return this.models.find((model) => model.id === id)?.name ?? '模型不可用'
    },
    knowledgeName(id: string): string {
      return this.knowledgeBases.find((kb) => kb.id === id)?.name ?? '知识库不可用'
    },
    formatTime(value: string): string {
      const date = new Date(value)
      return Number.isNaN(date.getTime())
        ? '时间未知'
        : new Intl.DateTimeFormat('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }).format(date)
    },
    formatScore(score: number): string {
      return Number.isFinite(score) ? score.toFixed(4) : '未提供'
    },
    statusLabel(status: Message['status']): string {
      return { complete: '已完成', streaming: '生成中', cancelled: '已取消', error: '生成失败' }[
        status
      ]
    },
    async loadPage(): Promise<void> {
      if (this.interactionLocked) return
      this.pageLoading = true
      this.pageError = ''
      try {
        const [models, knowledgeBases, conversations] = await Promise.all([
          api.models(),
          api.knowledgeBases(),
          api.conversations(),
        ])
        if (this.runtime.disposed) return
        this.models = models
        this.knowledgeBases = knowledgeBases
        this.conversations = conversations
        this.listError = ''
        this.initialized = true
        const next = conversations.some((item) => item.id === this.activeId)
          ? this.activeId
          : (this.filteredConversations[0]?.id ?? conversations[0]?.id ?? '')
        if (next !== this.activeId) await this.activateConversation(next)
        else if (next) await this.loadHistory(next)
      } catch (error) {
        if (!this.runtime.disposed) this.pageError = `工作台加载失败：${errorText(error)}`
      } finally {
        if (!this.runtime.disposed) {
          this.pageLoading = false
          this.queueScroll()
        }
      }
    },
    async reloadList(): Promise<void> {
      if (this.interactionLocked) return
      this.pageLoading = true
      await this.refreshConversations()
      if (!this.runtime.disposed) {
        this.pageLoading = false
        this.queueScroll()
      }
    },
    async refreshConversations(): Promise<void> {
      try {
        const conversations = await api.conversations()
        if (this.runtime.disposed) return
        this.conversations = conversations
        this.listError = ''
        if (
          this.activeId &&
          !conversations.some((item) => item.id === this.activeId) &&
          !this.processing
        )
          await this.activateConversation(conversations[0]?.id ?? '')
      } catch (error) {
        if (!this.runtime.disposed) this.listError = `会话列表同步失败：${errorText(error)}`
      }
    },
    async selectConversation(id: string): Promise<void> {
      if (this.interactionLocked || id === this.activeId) return
      await this.activateConversation(id)
    },
    async activateConversation(id: string): Promise<void> {
      if (this.activeId) this.drafts[this.activeId] = this.draft
      this.activeId = id
      this.draft = this.drafts[id] ?? ''
      this.messages = []
      this.historyError = ''
      this.generationError = ''
      this.cancelError = ''
      this.notice = ''
      this.clipboardError = ''
      this.copiedId = ''
      this.pendingRequest = null
      this.followBottom = true
      this.citationVisible = false
      this.clearCitation()
      this.runtime.historySeq++
      if (id) await this.loadHistory(id)
    },
    async loadHistory(id: string): Promise<void> {
      const sequence = ++this.runtime.historySeq
      this.historyLoading = true
      this.historyError = ''
      try {
        const messages = await api.messages(id)
        if (this.runtime.disposed || sequence !== this.runtime.historySeq || id !== this.activeId)
          return
        this.messages = uniqueMessages(messages, id)
        this.queueScroll()
      } catch (error) {
        if (!this.runtime.disposed && sequence === this.runtime.historySeq)
          this.historyError = `读取消息失败：${errorText(error)}`
      } finally {
        if (!this.runtime.disposed && sequence === this.runtime.historySeq) {
          this.historyLoading = false
          this.queueScroll()
        }
      }
    },
    async retryHistory(): Promise<void> {
      if (!this.interactionLocked && this.activeId) await this.loadHistory(this.activeId)
    },
    openCreate(prompt = ''): void {
      if (this.interactionLocked) return
      this.formMode = 'new'
      this.formError = ''
      this.formPrompt = prompt
      this.form = {
        title: '',
        modelId: this.chatModels[0]?.id ?? '',
        knowledgeBaseIds: this.activeConversation
          ? this.activeConversation.knowledgeBaseIds.filter((id) =>
              this.knowledgeBases.some((kb) => kb.id === id),
            )
          : this.knowledgeBases.slice(0, 1).map((kb) => kb.id),
      }
      this.formVisible = true
    },
    openConfig(): void {
      if (this.interactionLocked || !this.activeConversation) return
      this.formMode = 'config'
      this.formError = ''
      this.formPrompt = ''
      this.form = {
        title: this.activeConversation.title,
        modelId: this.activeConversation.modelId,
        knowledgeBaseIds: [...this.activeConversation.knowledgeBaseIds],
      }
      this.formVisible = true
    },
    async refreshFormResources(): Promise<void> {
      if (this.formBusy) return
      this.formBusy = true
      this.formError = ''
      try {
        const [models, knowledgeBases] = await Promise.all([api.models(), api.knowledgeBases()])
        if (this.runtime.disposed) return
        this.models = models
        this.knowledgeBases = knowledgeBases
        if (!this.form.modelId) this.form.modelId = this.chatModels[0]?.id ?? ''
      } catch (error) {
        if (!this.runtime.disposed) this.formError = errorText(error)
      } finally {
        if (!this.runtime.disposed) this.formBusy = false
      }
    },
    upsertConversation(conversation: Conversation): void {
      this.conversations = [
        conversation,
        ...this.conversations.filter((item) => item.id !== conversation.id),
      ]
    },
    async saveForm(): Promise<void> {
      if (this.formBusy || this.processing || this.generationId || !this.validForm) return
      const id = this.formMode === 'config' ? this.activeId : undefined
      const input: ConversationInput = {
        title: this.form.title.trim() || '新会话',
        modelId: this.form.modelId,
        knowledgeBaseIds: [...this.form.knowledgeBaseIds],
      }
      this.formBusy = true
      this.formError = ''
      try {
        const conversation = await api.saveConversation(input, id)
        if (this.runtime.disposed) return
        this.upsertConversation(conversation)
        this.formVisible = false
        this.search = ''
        if (!id) {
          await this.activateConversation(conversation.id)
          this.draft = this.formPrompt
          this.focusComposer()
        } else this.notice = '配置已保存，将用于后续提问。'
      } catch (error) {
        if (!this.runtime.disposed) this.formError = `保存失败：${errorText(error)}`
      } finally {
        if (!this.runtime.disposed) this.formBusy = false
      }
    },
    openAction(mode: 'rename' | 'delete', conversation: Conversation): void {
      if (this.interactionLocked) return
      this.actionMode = mode
      this.actionTarget = conversation
      this.renameTitle = conversation.title
      this.actionError = ''
    },
    closeAction(visible: boolean): void {
      if (!visible && !this.actionBusy) {
        this.actionMode = null
        this.actionTarget = null
      }
    },
    async submitAction(): Promise<void> {
      if (
        this.actionBusy ||
        this.processing ||
        this.generationId ||
        !this.actionTarget ||
        !this.actionMode
      )
        return
      const target = this.actionTarget
      if (this.actionMode === 'rename' && !this.renameTitle.trim()) return
      this.actionBusy = true
      this.actionError = ''
      try {
        if (this.actionMode === 'rename') {
          const conversation = await api.saveConversation(
            {
              title: this.renameTitle.trim(),
              modelId: target.modelId,
              knowledgeBaseIds: [...target.knowledgeBaseIds],
            },
            target.id,
          )
          if (this.runtime.disposed) return
          this.upsertConversation(conversation)
        } else {
          await api.deleteConversation(target.id)
          if (this.runtime.disposed) return
          this.conversations = this.conversations.filter((item) => item.id !== target.id)
          delete this.drafts[target.id]
          if (this.activeId === target.id) {
            this.draft = ''
            await this.activateConversation(
              this.filteredConversations[0]?.id ?? this.conversations[0]?.id ?? '',
            )
            delete this.drafts[target.id]
          }
        }
        this.actionMode = null
        this.actionTarget = null
      } catch (error) {
        if (!this.runtime.disposed) this.actionError = `操作失败：${errorText(error)}`
      } finally {
        if (!this.runtime.disposed) this.actionBusy = false
      }
    },
    usePrompt(prompt: string): void {
      if (this.interactionLocked) return
      if (!this.activeConversation) this.openCreate(prompt)
      else {
        this.draft = prompt
        this.focusComposer()
      }
    },
    focusComposer(): void {
      void this.$nextTick(() => {
        const component = this.$refs.composerInput as { $el?: HTMLTextAreaElement } | undefined
        component?.$el?.focus({ preventScroll: true })
      })
    },
    onComposerKeydown(event: KeyboardEvent): void {
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.isComposing ||
        this.composing ||
        event.keyCode === 229
      )
        return
      event.preventDefault()
      if (!event.repeat) void this.sendMessage()
    },
    onMessageScroll(): void {
      const element = this.$refs.messageScroller as HTMLElement | undefined
      if (element)
        this.followBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80
    },
    queueScroll(): void {
      if (this.runtime.scrollQueued || !this.followBottom || this.runtime.disposed) return
      this.runtime.scrollQueued = true
      void this.$nextTick(() => {
        this.runtime.scrollQueued = false
        const element = this.$refs.messageScroller as HTMLElement | undefined
        if (element && this.followBottom && !this.runtime.disposed)
          element.scrollTop = element.scrollHeight
      })
    },
    jumpToLatest(): void {
      this.followBottom = true
      this.queueScroll()
    },
    async sendMessage(): Promise<void> {
      if (!this.canSend) return
      const conversationId = this.activeId
      const content = this.draft.trim()
      const pending = this.pendingRequest
      const request: PendingRequest =
        pending?.conversationId === conversationId && pending.content === content
          ? pending
          : { conversationId, content, clientRequestId: requestId() }
      this.pendingRequest = request
      const work = this.performSend(request)
      this.runtime.work = work
      try {
        await work
      } finally {
        this.runtime.work = null
      }
    },
    async performSend(request: PendingRequest): Promise<void> {
      this.processing = true
      this.phase = 'creating'
      this.generationError = ''
      this.cancelError = ''
      this.notice = ''
      const controller = new AbortController()
      this.runtime.stopRequested = false
      this.runtime.controller = controller
      this.jumpToLatest()
      const outcome: { terminal: 'done' | 'error' | null } = { terminal: null }
      let task: Generation | null = null
      try {
        // 不乐观追加消息：Mock 与真实 API 均由 generate 保存用户消息和助手占位消息。
        this.runtime.request = api.generate(
          request.conversationId,
          request.content,
          request.clientRequestId,
        )
        task = await this.runtime.request
        if (this.runtime.disposed) {
          await api.cancel(task.generationId)
          return
        }
        this.generationId = task.generationId
        this.assistantMessageId = task.assistantMessageId
        this.pendingRequest = null
        this.draft = ''
        this.drafts[request.conversationId] = ''
        this.phase = 'connecting'
        if (this.runtime.stopRequested) return
        const saved = await api.messages(request.conversationId)
        if (this.runtime.disposed || this.runtime.stopRequested) return
        this.messages = uniqueMessages(saved, request.conversationId)
        const assistant = this.messages.find(
          (message) => message.id === this.assistantMessageId && message.role === 'assistant',
        )
        if (!assistant)
          throw new Error('生成任务已创建，但未找到对应的助手消息。已停止订阅，请刷新历史确认。')
        if (assistant.status !== 'streaming') {
          outcome.terminal = assistant.status === 'complete' ? 'done' : 'error'
          if (assistant.status === 'error')
            this.generationError = '该请求已结束，但生成失败。请检查消息记录后再提问。'
          if (assistant.status === 'cancelled') this.notice = '该请求的生成任务已取消。'
          return
        }
        this.phase = 'streaming'
        this.queueScroll()
        // 事件接口从生成起点重放；首个增量到达时替换快照，避免重复累加。
        let firstDelta = true
        await api.stream(
          task.generationId,
          (event: StreamEvent) => {
            if (this.runtime.disposed || this.runtime.stopRequested || outcome.terminal) return
            if (event.type === 'delta') {
              if (firstDelta) {
                assistant.content = ''
                firstDelta = false
              }
              assistant.content += event.text
            } else if (event.type === 'citations')
              assistant.citations = Array.from(
                new Map(
                  [...assistant.citations, ...event.citations].map((citation) => [
                    citation.id,
                    citation,
                  ]),
                ).values(),
              )
            else if (event.type === 'done') {
              outcome.terminal = 'done'
              assistant.status = 'complete'
              controller.abort()
            } else if (event.type === 'error') {
              outcome.terminal = 'error'
              assistant.status = 'error'
              this.generationError = `生成失败：${event.message || '服务返回错误。'}`
              controller.abort()
            }
            this.queueScroll()
          },
          controller.signal,
        )
        if (!outcome.terminal && !this.runtime.stopRequested)
          throw new Error('连接已中断，未收到完成事件；当前回复可能不完整。')
      } catch (error) {
        if (!this.runtime.disposed && !this.runtime.stopRequested && !outcome.terminal)
          this.generationError = `生成失败：${errorText(error)}`
      } finally {
        if (!this.runtime.disposed) {
          if (outcome.terminal) this.generationId = ''
          else if (this.generationId && !this.runtime.stopRequested)
            await this.cancelGeneration(false)
          if (this.runtime.cancellation) await this.runtime.cancellation
          this.phase = 'syncing'
          // 错误与取消之后重新读取服务端历史，但不清除生成错误或取消失败提示。
          await Promise.all([this.loadHistory(request.conversationId), this.refreshConversations()])
          this.processing = false
          this.phase = ''
          this.assistantMessageId = ''
          this.runtime.request = null
          this.runtime.controller = null
          if (!this.generationId && this.followBottom && !this.citationVisible) this.focusComposer()
        }
      }
    },
    async cancelGeneration(showNotice = true): Promise<boolean> {
      if (this.runtime.cancellation) return this.runtime.cancellation
      if (!this.generationId && this.phase !== 'creating') return true
      this.stopping = true
      this.runtime.stopRequested = true
      this.runtime.controller?.abort()
      const cancellation = (async (): Promise<boolean> => {
        let id = this.generationId
        if (!id && this.runtime.request) {
          try {
            id = (await this.runtime.request).generationId
          } catch (error) {
            if (!this.runtime.disposed)
              this.cancelError = `无法确认生成任务是否创建，不能确认已停止：${errorText(error)}。请刷新消息后核对。`
            return false
          }
        }
        if (!id) return true
        try {
          await api.cancel(id)
          if (!this.runtime.disposed) {
            if (this.generationId === id) this.generationId = ''
            this.cancelError = ''
            if (showNotice) this.notice = '后端已确认停止生成。'
          }
          return true
        } catch (error) {
          if (!this.runtime.disposed) {
            this.generationId = id
            this.notice = ''
            this.cancelError = `停止失败：${errorText(error)}。本地接收已中断，但后端任务可能仍在运行；请重试停止。`
          }
          return false
        }
      })()
      this.runtime.cancellation = cancellation
      try {
        return await cancellation
      } finally {
        this.runtime.cancellation = null
        if (!this.runtime.disposed) this.stopping = false
      }
    },
    async stop(): Promise<void> {
      await this.cancelGeneration()
      if (this.runtime.work) await this.runtime.work
      // 重试停止可能与上一轮历史同步重叠，取消响应之后再确认一次服务端状态。
      if (this.activeId && !this.runtime.disposed)
        await Promise.all([this.loadHistory(this.activeId), this.refreshConversations()])
    },
    async copyMessage(message: Message): Promise<void> {
      this.clipboardError = ''
      try {
        if (!navigator.clipboard)
          throw new Error('当前浏览器环境不支持剪贴板，请选中正文手动复制。')
        await navigator.clipboard.writeText(message.content)
        if (this.runtime.disposed || this.activeId !== message.conversationId) return
        this.copiedId = message.id
        const timer = setTimeout(() => {
          if (this.copiedId === message.id) this.copiedId = ''
          this.runtime.timers.delete(timer)
        }, 2000)
        this.runtime.timers.add(timer)
      } catch (error) {
        if (!this.runtime.disposed && this.activeId === message.conversationId)
          this.clipboardError = `复制失败：${errorText(error)}`
      }
    },
    openCitation(messageId: string, citationId: string): void {
      this.citationRequest = { messageId, citationId }
      this.citationVisible = true
      void this.fetchCitation()
    },
    clearCitation(): void {
      this.runtime.citationSeq++
      this.citationDetail = null
      this.citationRequest = null
      this.citationError = ''
      this.citationLoading = false
      this.downloadError = ''
      this.downloading = false
    },
    async fetchCitation(): Promise<void> {
      const request = this.citationRequest
      if (!request) return
      const sequence = ++this.runtime.citationSeq
      this.citationLoading = true
      this.citationError = ''
      this.citationDetail = null
      this.downloadError = ''
      this.downloading = false
      try {
        const citation = await api.citation(request.messageId, request.citationId)
        if (!this.runtime.disposed && sequence === this.runtime.citationSeq && this.citationVisible)
          this.citationDetail = citation
      } catch (error) {
        if (!this.runtime.disposed && sequence === this.runtime.citationSeq)
          this.citationError = `引用可能已失效或权限发生变化：${errorText(error)}`
      } finally {
        if (!this.runtime.disposed && sequence === this.runtime.citationSeq)
          this.citationLoading = false
      }
    },
    async downloadCitation(): Promise<void> {
      const request = this.citationRequest
      if (!request || !this.citationDetail || this.downloading) return
      const sequence = this.runtime.citationSeq
      this.downloading = true
      this.downloadError = ''
      try {
        const citation = await api.citation(request.messageId, request.citationId)
        if (this.runtime.disposed || sequence !== this.runtime.citationSeq || !this.citationVisible)
          return
        const blob = await api.download(citation.documentId)
        if (this.runtime.disposed || sequence !== this.runtime.citationSeq || !this.citationVisible)
          return
        this.citationDetail = citation
        const url = URL.createObjectURL(blob)
        this.runtime.urls.add(url)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download =
          this.isMock && /\.(pdf|docx)$/i.test(citation.documentName)
            ? `${citation.documentName}.模拟说明.txt`
            : citation.documentName
        document.body.appendChild(anchor)
        try {
          anchor.click()
        } finally {
          anchor.remove()
          const timer = setTimeout(() => {
            URL.revokeObjectURL(url)
            this.runtime.urls.delete(url)
            this.runtime.timers.delete(timer)
          }, 1000)
          this.runtime.timers.add(timer)
        }
      } catch (error) {
        if (!this.runtime.disposed && sequence === this.runtime.citationSeq)
          this.downloadError = `下载失败：${errorText(error)}`
      } finally {
        if (!this.runtime.disposed && sequence === this.runtime.citationSeq)
          this.downloading = false
      }
    },
  },
})
</script>

<style scoped>
.chat-page {
  --chat-border: #e4e9f1;
  --chat-blue: #2563eb;
  --chat-ink: #17243b;
  color: var(--chat-ink);
  min-width: 0;
}
.chat-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}
.chat-heading h1 {
  margin: 5px 0 6px;
  font-size: 27px;
  letter-spacing: -0.7px;
}
.chat-heading p {
  margin: 0;
  font-size: 14px;
}
.chat-heading .eyebrow,
.welcome-state .eyebrow,
.citation-intro .eyebrow {
  font-size: 10px;
  letter-spacing: 2px;
  color: #6c83a5;
  font-weight: 700;
}
.chat-heading .button-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mock-notice {
  display: flex;
  gap: 12px;
  align-items: center;
  border: 1px solid #f2d293;
  border-radius: 12px;
  padding: 13px 16px;
  margin-bottom: 16px;
  background: #fff9ea;
  color: #885714;
  font-size: 13px;
}
.mock-notice > i {
  font-size: 20px;
}
.mock-notice strong,
.mock-notice span {
  display: block;
}
.mock-notice span {
  margin-top: 4px;
  line-height: 1.6;
}
.feedback {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px;
  margin-bottom: 10px;
  font-size: 13px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  flex-wrap: wrap;
}
.chat-workspace {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  gap: 16px;
  height: max(620px, calc(100dvh - 238px));
  min-width: 0;
  transition: margin-right 0.18s ease;
}
.chat-workspace.with-citation {
  margin-right: 420px;
  grid-template-columns: 220px minmax(0, 1fr);
}
.conversation-panel,
.message-panel {
  border: 1px solid var(--chat-border);
  border-radius: 16px;
  background: white;
  overflow: hidden;
  min-height: 0;
  padding: 0;
}
.conversation-panel {
  display: flex;
  flex-direction: column;
}
.sidebar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 20px 16px 16px;
}
.sidebar-top h2 {
  font-size: 15px;
  margin: 0 0 6px;
}
.sidebar-top .muted {
  font-size: 12px;
}
.search-box {
  margin: 0 12px 14px;
  position: relative;
}
.search-box > i {
  position: absolute;
  z-index: 1;
  left: 12px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 13px;
  color: #8290a6;
}
.search-box :deep(input) {
  padding-left: 34px;
  font-size: 13px;
  border-color: var(--chat-border);
}
.conversation-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 12px;
  scrollbar-width: thin;
}
.conversation-item {
  border-radius: 10px;
  margin-bottom: 5px;
  border: 1px solid transparent;
}
.conversation-item.selected {
  background: #eff5ff;
  border-color: #dce8ff;
}
.conversation-item:not(.selected):hover {
  background: #f7f9fc;
}
.conversation-select {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  width: 100%;
  text-align: left;
  color: inherit;
  cursor: pointer;
  padding: 13px 10px 7px;
  background: none;
  border: 0;
  font: inherit;
}
.conversation-select > i {
  margin-top: 2px;
  font-size: 14px;
  color: #8090aa;
}
.selected .conversation-select > i,
.selected .conversation-select strong {
  color: #2563eb;
}
.conversation-select > span {
  min-width: 0;
  flex: 1;
}
.conversation-select strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
}
.conversation-select small {
  display: block;
  margin-top: 7px;
  color: #8490a2;
  font-size: 11px;
}
.conversation-actions {
  display: flex;
  justify-content: flex-end;
  padding: 0 6px 4px;
}
.conversation-actions :deep(.p-button) {
  width: 26px;
  height: 26px;
}
.conversation-actions :deep(.p-button-icon) {
  font-size: 11px;
}
.sidebar-footer {
  border-top: 1px solid var(--chat-border);
  padding: 15px 12px;
  font-size: 10px;
  color: #8a96a8;
  display: flex;
  align-items: center;
  gap: 7px;
}
.sidebar-empty {
  text-align: center;
  padding: 32px 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.sidebar-empty > i {
  color: #a4b4ce;
  font-size: 25px;
  margin-bottom: 8px;
}
.sidebar-empty strong {
  font-size: 13px;
  line-height: 1.6;
}
.sidebar-empty p {
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
}
.sidebar-error {
  margin: 0 8px 8px;
}
.message-panel {
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
}
.thread-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 20px 24px 16px;
  border-bottom: 1px solid #f0f3f8;
}
.thread-title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.thread-title > div {
  min-width: 0;
}
.thread-title h2 {
  font-size: 16px;
  margin: 0 0 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.thread-title p {
  font-size: 12px;
  margin: 0;
  overflow-wrap: anywhere;
}
.thread-icon,
.welcome-symbol {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #edf4ff;
  color: #3976dc;
  border: 1px solid #deebff;
  flex-shrink: 0;
}
.thread-icon {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  font-size: 19px;
}
.context-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  align-items: center;
  padding: 10px 24px;
  background: #fafbfd;
  border-bottom: 1px solid #eff2f7;
  font-size: 11px;
}
.context-bar > i {
  color: #7c8da8;
}
.knowledge-chip {
  background: #eef2f8;
  color: #536780;
  padding: 4px 8px;
  border-radius: 5px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.notice-line {
  font-size: 12px;
  line-height: 1.7;
  color: #4c6788;
  background: #f3f8ff;
  padding: 9px 16px;
  overflow-wrap: anywhere;
}
.pending-notice {
  color: #8a651d;
  background: #fffbef;
}
.message-panel > .feedback {
  margin: 6px 12px 0;
  flex-shrink: 0;
}
.message-scroller {
  flex: 1;
  min-height: 150px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  overflow-anchor: none;
}
.welcome-state {
  max-width: 690px;
  margin: auto;
  min-height: 100%;
  padding: 38px 32px 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  text-align: center;
}
.welcome-symbol {
  width: 64px;
  height: 64px;
  border-radius: 20px;
  font-size: 28px;
  margin-bottom: 22px;
  box-shadow: 0 6px 22px #2563eb09;
}
.welcome-state h2 {
  font-size: clamp(22px, 2vw, 28px);
  margin: 12px 0 0;
  font-weight: 650;
  letter-spacing: -0.6px;
}
.welcome-state > p {
  font-size: 13px;
  max-width: 430px;
  line-height: 1.9;
  margin: 12px 0 22px;
}
.welcome-state > small {
  font-size: 11px;
  line-height: 1.7;
}
.prompt-grid {
  display: grid;
  gap: 10px;
  width: 100%;
  margin-bottom: 18px;
}
.prompt-card {
  display: flex;
  align-items: center;
  gap: 12px;
  text-align: left;
  padding: 15px;
  border: 1px solid var(--chat-border);
  border-radius: 10px;
  background: white;
  color: #4a5d76;
  font: inherit;
  font-size: 12px;
  line-height: 1.65;
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}
.prompt-card:hover:not(:disabled) {
  border-color: #9cbcf5;
  background: #f8fbff;
}
.prompt-card > span {
  flex: 1;
}
.prompt-card > i:first-child {
  font-size: 17px;
  color: #6188c6;
}
.prompt-card > i:last-child {
  color: #9badc4;
  font-size: 12px;
}
.message-list {
  padding: 26px 28px 12px;
  display: flex;
  flex-direction: column;
  gap: 25px;
}
.message {
  display: flex;
  align-items: flex-start;
  gap: 11px;
}
.message-avatar {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  flex-shrink: 0;
  font-size: 14px;
}
.message-avatar.assistant {
  color: #2563eb;
  background: #edf4ff;
}
.message-avatar.user {
  color: #667892;
  background: #f0f3f7;
}
.message-body {
  min-width: 0;
  flex: 1;
}
.message-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
  margin-bottom: 7px;
  flex-wrap: wrap;
}
.message-meta strong {
  font-size: 12px;
}
.message-meta time {
  color: #97a2b3;
  font-size: 10px;
}
.message-meta :deep(.p-tag) {
  font-size: 9px;
  padding: 2px 6px;
}
.message-bubble {
  padding: 14px 17px;
  border: 1px solid #e9edf4;
  border-radius: 0 12px 12px;
  background: #fff;
  font-size: 14px;
  line-height: 1.9;
  overflow-wrap: anywhere;
}
.message-user .message-bubble {
  background: #f4f7fc;
  border-color: #edf1f7;
}
.message-text,
.source-content {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.stream-cursor {
  display: inline-block;
  width: 6px;
  height: 15px;
  margin-left: 4px;
  vertical-align: middle;
  border-radius: 2px;
  background: #6695ed;
  animation: chat-blink 1s steps(2, start) infinite;
}
.message-citations {
  padding-top: 12px;
}
.citation-caption {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 10px;
  color: #8390a4;
  margin-bottom: 8px;
}
.citation-buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.citation-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  background: #f8faff;
  border: 1px solid #e0e9f8;
  border-radius: 6px;
  padding: 6px 8px;
  color: #5576a7;
  font: inherit;
  font-size: 10px;
  cursor: pointer;
}
.citation-button:hover {
  background: #edf4ff;
  border-color: #a5c1ef;
}
.citation-button > span:first-child {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #e8effc;
  border-radius: 3px;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.citation-button > span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.citation-button small {
  white-space: nowrap;
}
.message-tools {
  margin-top: 3px;
}
.message-tools :deep(.p-button) {
  font-size: 10px;
  padding: 4px 6px;
}
.jump-row {
  display: flex;
  justify-content: center;
  padding: 4px;
  background: #ffffffed;
}
.composer-area {
  padding: 12px 24px 10px;
  background: white;
}
.composer {
  border: 1px solid #dce4ef;
  border-radius: 13px;
  padding: 5px;
  background: white;
  box-shadow: 0 3px 14px #253e6206;
}
.composer:focus-within {
  border-color: #94b6f4;
  box-shadow: 0 0 0 3px #2563eb0a;
}
.composer :deep(textarea) {
  border: 0;
  background: transparent;
  box-shadow: none;
  outline: none;
  resize: vertical;
  min-height: 68px;
  max-height: 220px;
  font-size: 13px;
  padding: 10px 12px;
  line-height: 1.7;
}
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 0 6px 5px 12px;
}
.composer-toolbar > span {
  font-size: 10px;
}
.composer-toolbar :deep(.p-button) {
  font-size: 12px;
}
.composer-disclaimer {
  color: #99a4b4;
  text-align: center;
  font-size: 10px;
  margin: 9px 0 0;
  line-height: 1.6;
}
.loading-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 16px;
}
.loading-layout > div,
.history-loading {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 28px;
}
.loading-layout > div {
  border: 1px solid var(--chat-border);
  border-radius: 16px;
  background: white;
  min-height: 500px;
}
.history-loading {
  font-size: 12px;
}
.history-error {
  text-align: center;
  padding: 48px 24px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.history-error > i {
  color: #d97706;
  font-size: 28px;
}
.chat-form {
  display: grid;
  gap: 22px;
  padding-top: 12px;
}
.chat-form .field,
.field:has(#chat-rename) {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.chat-form label {
  font-size: 13px;
  font-weight: 600;
}
.chat-form small {
  font-size: 11px;
  line-height: 1.7;
}
.required-mark {
  color: #c75555;
}
.delete-warning {
  line-height: 1.9;
  overflow-wrap: anywhere;
}
.citation-drawer {
  color: #24354d;
  font-size: 13px;
  padding: 0 2px 16px;
}
.citation-intro p {
  margin: 8px 0 24px;
  font-size: 12px;
}
.citation-loading,
.citation-failure {
  padding: 42px 16px;
  text-align: center;
  line-height: 1.9;
  overflow-wrap: anywhere;
}
.source-file {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 16px;
  border: 1px solid #e5eaf2;
  border-radius: 12px;
  background: #f9fbfe;
}
.source-file > span {
  background: #eaf1ff;
  color: #547dc4;
  border-radius: 9px;
  padding: 12px;
  font-size: 21px;
}
.source-file > div {
  min-width: 0;
}
.source-file h3 {
  margin: 0 0 6px;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.source-file p {
  font-size: 11px;
  margin: 0;
  overflow-wrap: anywhere;
}
.source-metadata {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 20px 0 16px;
  gap: 18px 16px;
}
.source-metadata dt {
  font-size: 11px;
  color: #8794a7;
  margin-bottom: 6px;
}
.source-metadata dd {
  margin: 0;
  font-size: 12px;
  color: #405676;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.score-explanation {
  padding: 11px 12px;
  background: #f4f7fc;
  color: #7b8ba3;
  font-size: 11px;
  line-height: 1.8;
  border-radius: 8px;
}
.score-explanation i {
  margin-right: 4px;
}
.source-content-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 24px;
}
.source-content-heading h3 {
  font-size: 13px;
}
.source-content-heading span {
  font-size: 10px;
}
.source-content {
  padding: 16px;
  border-radius: 10px;
  border: 1px solid #e6ebf3;
  font-size: 13px;
  line-height: 2;
  color: #52637c;
  margin-bottom: 24px;
  background: #fff;
}
.download-hint {
  font-size: 10px;
  text-align: center;
  line-height: 1.8;
  margin-top: 10px;
}
.conversation-select:disabled,
.prompt-card:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.conversation-select:focus-visible,
.prompt-card:focus-visible,
.citation-button:focus-visible,
.message-scroller:focus-visible {
  outline: 2px solid #82acf6;
  outline-offset: -2px;
}
@keyframes chat-blink {
  to {
    opacity: 0.15;
  }
}
@media (min-width: 1281px) and (max-width: 1550px) {
  .chat-workspace.with-citation {
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 10px;
  }
  .with-citation .thread-header,
  .with-citation .composer-area {
    padding-left: 12px;
    padding-right: 12px;
  }
  .with-citation .message-list {
    padding: 18px 12px;
  }
}
@media (max-width: 900px) {
  .chat-workspace {
    grid-template-columns: 215px minmax(0, 1fr);
    gap: 12px;
  }
  .thread-header {
    padding: 16px;
  }
  .thread-icon {
    display: none;
  }
  .message-list {
    padding: 20px 16px;
  }
  .welcome-state {
    padding: 26px 18px;
  }
  .composer-area {
    padding: 10px 14px;
  }
}
@media (max-width: 680px) {
  .chat-heading {
    align-items: flex-start;
  }
  .chat-heading h1 {
    font-size: 23px;
  }
  .chat-heading .button-row {
    justify-content: flex-end;
  }
  .chat-heading .eyebrow {
    font-size: 8px;
    letter-spacing: 1px;
  }
  .chat-heading p {
    font-size: 12px;
  }
  .chat-workspace,
  .loading-layout {
    grid-template-columns: minmax(0, 1fr);
    height: auto;
  }
  .conversation-panel {
    max-height: 265px;
  }
  .sidebar-top {
    padding: 12px;
  }
  .conversation-list {
    min-height: 65px;
    max-height: 135px;
  }
  .conversation-item {
    display: flex;
    align-items: center;
  }
  .conversation-select {
    flex: 1;
    min-width: 0;
    padding: 9px;
  }
  .conversation-actions {
    padding: 0 5px;
  }
  .conversation-select small {
    margin-top: 3px;
  }
  .sidebar-footer {
    display: none;
  }
  .search-box {
    margin-bottom: 8px;
  }
  .message-panel {
    height: max(630px, calc(100dvh - 90px));
  }
  .message-avatar {
    display: none;
  }
  .context-bar {
    padding: 10px 14px;
  }
  .thread-header {
    padding: 15px 12px;
  }
  .thread-header :deep(.p-button) {
    font-size: 11px;
    flex-shrink: 0;
  }
  .mock-notice {
    font-size: 11px;
  }
  .welcome-state h2 {
    font-size: 22px;
  }
  .message-meta {
    gap: 7px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chat-workspace,
  .prompt-card {
    transition: none;
  }
  .stream-cursor {
    animation: none;
  }
}
</style>
