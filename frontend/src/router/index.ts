import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      component: () => import('@/views/LoginView.vue'),
      meta: { public: true, title: '登录' },
    },
    {
      path: '/',
      component: () => import('@/layouts/AppLayout.vue'),
      children: [
        { path: '', redirect: '/dashboard' },
        {
          path: 'dashboard',
          component: () => import('@/views/DashboardView.vue'),
          meta: { title: '工作台' },
        },
        {
          path: 'models',
          component: () => import('@/views/ModelsView.vue'),
          meta: { title: '模型管理' },
        },
        {
          path: 'users',
          component: () => import('@/views/UsersView.vue'),
          meta: { title: '用户与权限', admin: true },
        },
        {
          path: 'knowledge',
          component: () => import('@/views/KnowledgeView.vue'),
          meta: { title: '知识库' },
        },
        {
          path: 'knowledge/:id',
          component: () => import('@/views/KnowledgeDetailView.vue'),
          meta: { title: '文档工作台' },
        },
        {
          path: 'chat',
          component: () => import('@/views/ChatView.vue'),
          meta: { title: '智能对话' },
        },
        {
          path: '403',
          component: () => import('@/views/NotFoundView.vue'),
          meta: { title: '无访问权限' },
        },
        {
          path: ':pathMatch(.*)*',
          component: () => import('@/views/NotFoundView.vue'),
          meta: { title: '页面不存在' },
        },
      ],
    },
  ],
})
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.initialized) await auth.restore()
  if (!to.meta.public && !auth.user) return { path: '/login', query: { redirect: to.fullPath } }
  if (to.path === '/login' && auth.user) return '/dashboard'
  if (to.meta.admin && !auth.isAdmin) return '/403'
  document.title = `${to.meta.title || '工作台'} · ModelSpace`
})
export default router
