<script lang="ts">
import { defineComponent } from 'vue'
import Button from 'primevue/button'
import Tag from 'primevue/tag'
import { useAuthStore } from '@/stores/auth'
import { isMock, resetDemo } from '@/api'

export default defineComponent({
  name: 'AppLayout',
  components: { Button, Tag },
  data() {
    return {
      auth: useAuthStore(),
      isMock,
      mobileOpen: false,
      exiting: false,
      error: '',
      items: [
        { path: '/dashboard', label: '工作台', icon: 'pi-th-large', subtitle: 'OVERVIEW' },
        { path: '/chat', label: '智能对话', icon: 'pi-comments', subtitle: '' },
        { path: '/models', label: '模型管理', icon: 'pi-box', subtitle: 'WORKSPACE' },
        { path: '/knowledge', label: '知识库', icon: 'pi-book', subtitle: '' },
        { path: '/users', label: '用户与权限', icon: 'pi-users', subtitle: 'ADMINISTRATION' },
      ],
    }
  },
  computed: {
    navigation() {
      return this.items.filter((item) => item.path !== '/users' || this.auth.isAdmin)
    },
  },
  watch: {
    '$route.fullPath'() {
      this.mobileOpen = false
    },
  },
  methods: {
    async logout() {
      this.exiting = true
      try {
        // 先离开对话，让页面完成生成取消，再撤销身份。
        const failure = await this.$router.push('/dashboard')
        if (failure && this.$route.path !== '/dashboard') return
        await this.auth.logout()
      } catch (error) {
        this.error = error instanceof Error ? error.message : '退出请求失败。'
      } finally {
        this.exiting = false
        if (!this.auth.user) await this.$router.replace('/login')
      }
    },
    async reset() {
      if (!window.confirm('将清除本浏览器全部演示修改并恢复示例数据，是否继续？')) return
      try {
        const failure = await this.$router.push('/dashboard')
        if (failure && this.$route.path !== '/dashboard') return
        await resetDemo()
        this.auth.user = null
        await this.$router.replace('/login')
      } catch (error) {
        this.error = error instanceof Error ? error.message : '重置失败。'
      }
    },
  },
})
</script>

<template>
  <div class="app-shell">
    <button
      v-if="mobileOpen"
      class="sidebar-backdrop"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    ></button>
    <aside :class="['sidebar', { open: mobileOpen }]">
      <RouterLink to="/dashboard" class="brand"
        ><span class="brand-logo"><i class="pi pi-box"></i></span
        ><span>ModelSpace<small>模型管理工作台</small></span></RouterLink
      >
      <div class="workspace-picker">
        <span class="workspace-avatar">M</span>
        <div>团队工作空间<small>本地优先 · 私有部署</small></div>
        <i class="pi pi-lock"></i>
      </div>
      <nav aria-label="主导航">
        <template v-for="item in navigation" :key="item.path">
          <div v-if="item.subtitle" class="nav-label">{{ item.subtitle }}</div>
          <RouterLink
            :to="item.path"
            :class="['nav-item', { active: $route.path.startsWith(item.path) }]"
            ><i :class="['pi', item.icon]"></i>{{ item.label
            }}<i v-if="$route.path.startsWith(item.path)" class="pi pi-angle-right nav-arrow"></i
          ></RouterLink>
        </template>
      </nav>
      <div class="sidebar-bottom">
        <div class="local-note">
          <span class="status-dot"></span>{{ isMock ? '独立演示环境' : '私有 API 环境'
          }}<small>{{ isMock ? '数据仅保存在当前浏览器' : '所有请求经业务后端转发' }}</small>
        </div>
        <Button
          v-if="isMock"
          label="重置演示数据"
          icon="pi pi-refresh"
          text
          severity="secondary"
          size="small"
          @click="reset"
        />
        <div class="profile">
          <span class="profile-avatar">{{ auth.user?.name.slice(0, 1) }}</span>
          <div>
            {{ auth.user?.name
            }}<small>{{ auth.isAdmin ? '工作空间管理员' : '工作空间成员' }}</small>
          </div>
          <Button
            icon="pi pi-sign-out"
            text
            severity="secondary"
            aria-label="退出登录"
            :loading="exiting"
            @click="logout"
          />
        </div>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="breadcrumbs">
          <Button
            class="menu-button"
            icon="pi pi-bars"
            text
            aria-label="打开导航"
            @click="mobileOpen = true"
          /><span>工作空间</span><i class="pi pi-angle-right"></i
          ><strong>{{ $route.meta.title }}</strong>
        </div>
        <div class="topbar-right">
          <Tag
            :value="isMock ? 'Mock 演示' : '真实 API'"
            :severity="isMock ? 'info' : 'success'"
          /><span class="topbar-private"><i class="pi pi-shield"></i> 私有模型工作台</span>
        </div>
      </header>
      <main
        id="main-content"
        :class="['main-content', { 'chat-content': $route.path === '/chat' }]"
      >
        <div v-if="error" class="error-banner" role="alert">
          {{ error }}<Button label="关闭" text size="small" @click="error = ''" />
        </div>
        <RouterView />
      </main>
    </div>
  </div>
</template>
