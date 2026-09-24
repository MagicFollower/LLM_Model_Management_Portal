import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'
import { definePreset } from '@primeuix/themes'
import App from './App.vue'
import router from './router'
import { useAuthStore } from './stores/auth'
import 'primeicons/primeicons.css'
import './styles.css'

const preset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '{blue.50}',
      100: '{blue.100}',
      200: '{blue.200}',
      300: '{blue.300}',
      400: '{blue.400}',
      500: '{blue.500}',
      600: '{blue.600}',
      700: '{blue.700}',
      800: '{blue.800}',
      900: '{blue.900}',
      950: '{blue.950}',
    },
  },
})
const app = createApp(App)
app.use(createPinia())
app.use(PrimeVue, {
  theme: { preset, options: { darkModeSelector: false } },
  locale: {
    accept: '确认',
    reject: '取消',
    choose: '选择',
    upload: '上传',
    cancel: '取消',
    emptyMessage: '暂无数据',
    emptyFilterMessage: '没有匹配结果',
    searchMessage: '找到 {0} 个结果',
    selectionMessage: '已选择 {0} 项',
    emptySelectionMessage: '尚未选择',
    aria: {
      close: '关闭',
      firstPageLabel: '第一页',
      lastPageLabel: '最后一页',
      nextPageLabel: '下一页',
      previousPageLabel: '上一页',
      pageLabel: '第 {page} 页',
      selectAll: '全选',
      unselectAll: '取消全选',
    },
  },
})
app.use(router)
window.addEventListener('session-expired', () => {
  const auth = useAuthStore()
  auth.user = null
  auth.error = '登录状态已失效，请重新登录。'
  void router.push('/login')
})
window.addEventListener('session-refreshed', (event) => {
  useAuthStore().user = (event as CustomEvent).detail
})
app.mount('#app')
