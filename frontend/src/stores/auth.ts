import { defineStore } from 'pinia'
import { api } from '@/api'
import type { User } from '@/types'

export const useAuthStore = defineStore('auth', {
  state: () => ({ user: null as User | null, initialized: false, error: '' }),
  getters: { isAdmin: (state) => state.user?.role === 'admin' },
  actions: {
    async restore() {
      try {
        const session = await api.restore()
        this.user = session?.user || null
        this.error = ''
      } catch (error) {
        this.user = null
        this.error = error instanceof Error ? error.message : '恢复登录状态失败。'
      } finally {
        this.initialized = true
      }
    },
    async login(username: string, password: string) {
      const session = await api.login(username, password)
      this.user = session.user
      this.initialized = true
      this.error = ''
    },
    async logout() {
      try {
        await api.logout()
      } finally {
        this.user = null
        this.initialized = true
      }
    },
  },
})
