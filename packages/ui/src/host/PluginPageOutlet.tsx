/**
 * 插件页面出口。
 *
 * 只负责「当前 path 命中哪个插件页面」。项目页面由 body 自己优先匹配，
 * 未命中才把 path 交给这里——框架不认识项目页面，也不会和它们抢路由。
 *
 * `path` 可显式传入，方便 SSR 测试与 body 在特殊路由下复用；缺省读当前路径。
 */

import type { ComponentType, ReactNode } from 'react'
import { usePages } from 'cordis-app/client'
import { ErrorBoundary } from './ErrorBoundary.js'
import { usePath } from './router.js'

export function PluginPageOutlet(props: {
  path?: string
  /** 没有插件页面匹配时渲染的内容；默认不渲染 */
  fallback?: ReactNode
}): ReactNode {
  const current = usePath()
  const target = props.path ?? current
  const page = usePages().find((candidate) => candidate.path === target)

  if (!page) return props.fallback ?? null

  const Component = page.component as ComponentType
  return (
    <ErrorBoundary pluginId={page.pluginId}>
      <Component />
    </ErrorBoundary>
  )
}
