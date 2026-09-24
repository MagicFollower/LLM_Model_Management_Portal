<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import InputText from 'primevue/inputtext'
import Password from 'primevue/password'
import { useAuthStore } from '@/stores/auth'
import { isMock } from '@/api'

export default defineComponent({
  name: 'LoginView',
  components: { Button, InputText, Password },
  data() {
    return { auth: useAuthStore(), isMock, username: '', password: '', loading: false, error: '' }
  },
  methods: {
    async submit() {
      if (!this.username.trim() || !this.password) {
        this.error = '请输入账号和密码。'
        return
      }
      this.loading = true
      this.error = ''
      try {
        await this.auth.login(this.username.trim(), this.password)
        this.password = ''
        const redirect = this.$route.query.redirect
        const target =
          typeof redirect === 'string' &&
          redirect.startsWith('/') &&
          !redirect.startsWith('//') &&
          !redirect.startsWith('/login')
            ? redirect
            : '/dashboard'
        await this.$router.replace(target)
      } catch (error) {
        this.error = error instanceof Error ? error.message : '登录失败。'
      } finally {
        this.loading = false
      }
    },
    demo(role: 'admin' | 'member') {
      this.username = role
      this.password = role === 'admin' ? 'admin123' : 'member123'
      void this.submit()
    },
  },
})
</script>

<template>
  <div class="login-page">
    <section class="login-story">
      <div class="brand">
        <span class="brand-logo"><i class="pi pi-box"></i></span
        ><span>ModelSpace<small>模型管理工作台</small></span>
      </div>
      <div class="story-content">
        <div class="eyebrow">YOUR MODELS. YOUR KNOWLEDGE.</div>
        <h1>让模型与知识，<br />在这里连接。</h1>
        <p>一个统一的工作空间，管理本地模型、构建团队知识库，<br />让每一次对话都有据可循。</p>
        <div class="story-pills">
          <span><i class="pi pi-server"></i> 本地模型</span
          ><span><i class="pi pi-book"></i> 知识增强</span
          ><span><i class="pi pi-shield"></i> 权限可控</span>
        </div>
        <div class="architecture-card">
          <div>
            <span class="mini-icon"><i class="pi pi-box"></i></span><strong>模型网关</strong
            ><small>Chat · Embedding · Rerank</small>
          </div>
          <i class="pi pi-arrows-h"></i>
          <div>
            <span class="mini-icon green"><i class="pi pi-book"></i></span><strong>团队知识</strong
            ><small>文档 · 片段 · 引用</small>
          </div>
        </div>
      </div>
      <small class="story-footer">为内网团队而设计 · 前端资源可完全本地部署</small>
    </section>
    <section class="login-form-side">
      <form class="login-form" @submit.prevent="submit">
        <div class="eyebrow">WELCOME BACK</div>
        <h2>欢迎回到工作空间</h2>
        <p class="muted">登录后，开始管理你的模型与知识。</p>
        <div v-if="error || auth.error" class="error-banner" role="alert">
          {{ error || auth.error }}
        </div>
        <div class="field">
          <label for="username">账号</label
          ><InputText
            id="username"
            v-model="username"
            autocomplete="username"
            placeholder="请输入账号"
            :disabled="loading"
          />
        </div>
        <div class="field">
          <label for="password">密码</label
          ><Password
            input-id="password"
            v-model="password"
            autocomplete="current-password"
            :feedback="false"
            toggle-mask
            placeholder="请输入密码"
            :disabled="loading"
            fluid
          />
        </div>
        <Button
          type="submit"
          label="登录工作空间"
          icon="pi pi-arrow-right"
          icon-pos="right"
          :loading="loading"
          fluid
        />
        <div v-if="isMock" class="demo-login">
          <span class="demo-label"><i class="pi pi-info-circle"></i> Mock 业务数据 · 模板模拟回答</span>
          <p>
            账号与业务数据为本地演示。TXT / MD 按真实正文切分，上传与处理阶段仍模拟；PDF / DOCX
            仅为占位内容，不参与真实检索。种子资料为虚构演示内容。
          </p>
          <p>
            默认 local 使用固定 BGE 本地 CPU 真实检索，需要启动本地服务并在知识库详情显式加载模型；
            显式 demo 可离线展示固定分数，服务失败不会自动降级。回答仍是模板模拟，不是 Chat 模型输出。
            原模型管理配置未自动接通，本地测试固定使用 BAAI/bge-small-zh-v1.5，不执行 Rerank。
            请勿输入真实密钥或敏感文档。
          </p>
          <div class="button-row">
            <Button
              label="管理员体验"
              severity="secondary"
              outlined
              :disabled="loading"
              @click="demo('admin')"
            /><Button
              label="普通成员体验"
              severity="secondary"
              outlined
              :disabled="loading"
              @click="demo('member')"
            />
          </div>
          <small
            >admin / admin123 · member / member123<br />新建演示用户统一使用
            demo123，不保存输入的密码。</small
          >
        </div>
        <div v-else class="login-security">
          <i class="pi pi-lock"></i> 通过业务后端验证身份，请使用管理员分配的账号。
        </div>
      </form>
    </section>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 1.12fr 1fr;
  background: white;
}
.login-story {
  padding: 40px 54px;
  background: #f3f6fc;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  border-right: 1px solid #e8edf4;
}
.story-content {
  margin: auto 0;
  padding: 60px 0;
}
.story-content h1 {
  font-size: clamp(32px, 3.3vw, 52px);
  line-height: 1.4;
  letter-spacing: -2px;
  margin: 20px 0;
  color: #182943;
}
.story-content p {
  color: #78859a;
  line-height: 1.9;
  font-size: 15px;
}
.story-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 28px 0 42px;
}
.story-pills span {
  font-size: 12px;
  display: flex;
  gap: 7px;
  align-items: center;
  color: #52647e;
}
.story-pills i {
  color: #4b7df1;
}
.architecture-card {
  display: flex;
  align-items: center;
  justify-content: space-around;
  padding: 30px 18px;
  max-width: 450px;
  border: 1px solid #e2e8f3;
  background: #fff;
  border-radius: 14px;
}
.architecture-card > div {
  display: flex;
  align-items: center;
  flex-direction: column;
  gap: 10px;
}
.architecture-card small {
  font-size: 10px;
  color: #8390a3;
}
.architecture-card > .pi {
  color: #b9c4d5;
}
.mini-icon {
  background: #eff4ff;
  color: #4b7df1;
  padding: 14px;
  border-radius: 12px;
}
.mini-icon.green {
  color: #139c7d;
  background: #eaf8f1;
}
.story-footer {
  color: #8794a7;
  font-size: 11px;
}
.login-form-side {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
}
.login-form {
  width: 100%;
  max-width: 388px;
}
.login-form h2 {
  font-size: 27px;
  margin: 15px 0 10px;
  letter-spacing: -1px;
}
.login-form > .muted {
  margin-bottom: 32px;
}
.login-form > .field {
  margin: 20px 0;
}
.login-form > .p-button {
  margin-top: 6px;
}
.demo-login {
  border: 1px solid #dce7fc;
  border-radius: 10px;
  background: #f8faff;
  padding: 18px;
  margin-top: 28px;
}
.demo-label {
  font-size: 13px;
  font-weight: 600;
  color: #43649b;
}
.demo-login p,
.demo-login small {
  font-size: 11px;
  line-height: 1.8;
  color: #7b88a0;
}
.demo-login .button-row {
  margin: 14px 0;
}
.login-security {
  margin-top: 25px;
  font-size: 12px;
  color: #77869a;
  line-height: 1.8;
}
@media (max-width: 900px) {
  .login-story {
    padding: 32px;
  }
  .story-content h1 {
    font-size: 32px;
  }
  .login-form-side {
    padding: 30px;
  }
  .architecture-card {
    gap: 12px;
  }
  .architecture-card small {
    font-size: 9px;
  }
}
@media (max-width: 680px) {
  .login-page {
    grid-template-columns: 1fr;
  }
  .login-story {
    min-height: auto;
    padding: 22px;
  }
  .story-content,
  .story-footer {
    display: none;
  }
  .login-form-side {
    padding: 40px 24px;
  }
  .login-story .brand small {
    display: none;
  }
}
</style>
