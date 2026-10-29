/**
 * body 宿主。
 *
 * 框架壳固定负责三件与布局无关的事：全局快捷键、全局右键菜单、顶层错误边界。
 * 布局、导航、项目页面和样式全部由 body 的 children 决定。
 */

import type { ReactNode } from 'react'
import { useShortcuts } from 'cordis-app/client'
import { ContextMenu } from './ContextMenu.js'
import { ErrorBoundary } from './ErrorBoundary.js'

export function BodyHost(props: { children: ReactNode }): ReactNode {
  // 快捷键不占 body 的位置：插件注册了什么，宿主就监听什么
  useShortcuts()

  return (
    <ErrorBoundary title="应用渲染失败">
      {props.children}
      {/* 菜单只有一份，挂在最外层；body 只负责触发菜单 id */}
      <ContextMenu />
    </ErrorBoundary>
  )
}
