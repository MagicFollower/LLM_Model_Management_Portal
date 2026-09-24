import type { Api } from '@/types'

const mode = import.meta.env.VITE_DATA_MODE || 'mock'
if (!['mock', 'rest'].includes(mode)) throw new Error('VITE_DATA_MODE 只能配置为 mock 或 rest。')
export const isMock = mode === 'mock'
// 动态加载隔离模拟数据，真实模式不会初始化演示存储。
const adapter: Promise<Api> = isMock
  ? import('@/mock').then((module) => module.mockApi)
  : import('./rest').then((module) => module.restApi)
export const api = new Proxy({} as Api, {
  get(_target, property: keyof Api) {
    return async (...args: unknown[]) => {
      const implementation = await adapter
      const operation = implementation[property] as (...values: unknown[]) => Promise<unknown>
      return operation.apply(implementation, args)
    }
  },
})
export async function resetDemo() {
  if (!isMock) return
  const { resetMock } = await import('@/mock')
  resetMock()
}
