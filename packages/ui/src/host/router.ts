/**
 * 极简路由器。
 *
 * 不引入 react-router：这里只有「一个当前路径 + 订阅变更」，而框架对路由
 * 的唯一要求是「插件注册的 path 能对应到组件」。引入一个路由库会顺带把
 * 它的数据加载约定、嵌套路由概念带进插件 API，代价远大于收益。
 *
 * 用 History API 而不是 hash：hash 已被 token 传递占用过（虽然用过即抹），
 * 而且深链接形如 `/theme` 更符合直觉。
 */

import { useCallback, useSyncExternalStore } from 'react'

type Listener = () => void

const listeners = new Set<Listener>()

/** SSR 与 Node 测试没有 window：路由退化为「永远在 /」。 */
function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function currentPath(): string {
  if (!hasWindow()) return '/'
  const path = window.location.pathname
  return path === '/' ? '/' : path.replace(/\/+$/, '') || '/'
}

export function subscribePath(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
  // 服务端渲染与 Node 测试里没有 history；导航是纯浏览器行为，安全 no-op。
  if (!hasWindow()) return
  if (to === currentPath()) return
  if (options.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  notify()
}

export function useNavigate(): (to: string, options?: { replace?: boolean }) => void {
  return useCallback(navigate, [])
}

export function usePath(): string {
  return useSyncExternalStore(subscribePath, currentPath, () => '/')
}

/** 浏览器前进/后退。整个应用只挂一次；SSR 下返回 no-op。 */
export function installHistoryListener(): () => void {
  if (!hasWindow()) return () => {}
  const onPop = () => notify()
  window.addEventListener('popstate', onPop)
  return () => window.removeEventListener('popstate', onPop)
}
