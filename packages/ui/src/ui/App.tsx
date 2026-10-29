/**
 * 应用外壳布局。
 *
 * 结构是固定的一层：活动栏（左侧图标）+ 内容区（顶部插槽 + 页面）+ 右键菜单。
 * 页面与插槽全部来自注册表，宿主自己不认识任何插件——这就是「装一个插件就出现
 * 入口、卸载后干净消失」的落点。
 */

import { Component, useEffect, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { ContextMenu } from './ContextMenu.js'
import { Icon } from './icons.js'
import { navigate, usePath } from './router.js'
import { SettingsPanel } from './SettingsPanel.js'
import { useMenu, usePages, useShortcuts, useSlots } from 'cordis-app/client'

/**
 * 设置页是框架自己的页面，不属于任何插件。
 *
 * 它固定在活动栏底部、不参与插件页面的 order 排序：否则插件可以把它挤到某个
 * 不讲道理的位置，而设置是每个应用都必须有的入口。
 */
const SETTINGS_PATH = '/settings'

export function App(): ReactNode {
  const pages = usePages()
  const path = usePath()
  const triggerMenu = useMenu('activity')
  useShortcuts()

  // 根路径没有页面：跳到第一个插件页，避免打开应用先看到「未找到页面」。
  // 用 replace 而不是 push —— 用户按返回不该退回这个空路径。
  const firstPage = pages[0]
  useEffect(() => {
    if (path === '/' && firstPage) navigate(firstPage.path, { replace: true })
  }, [path, firstPage])

  const active = pages.find((page) => page.path === path)
  const isSettings = path === SETTINGS_PATH

  return (
    <div className="app">
      <ActivityBar pages={pages} path={path} onContextMenu={triggerMenu} />

      <main className="content">
        <header className="content-header">
          <h1 className="content-title">{isSettings ? '设置' : (active?.name ?? '未找到页面')}</h1>
          <SlotArea name="header.right" className="header-right" />
        </header>

        <div className="content-body">
          {isSettings ? (
            <SettingsPanel />
          ) : active ? (
            <PluginPage pluginId={active.pluginId} component={active.component} />
          ) : (
            <NotFound path={path} hasPages={pages.length > 0} />
          )}
        </div>
      </main>

      {/* 菜单只有一份，挂在最外层：插件只负责触发，渲染与关闭由框架统一处理 */}
      <ContextMenu />
    </div>
  )
}

/** 页面外壳：隔离单个插件的渲染错误，不让它拖垮整个应用。 */
function PluginPage(props: { pluginId: string; component: unknown }): ReactNode {
  const Component = props.component as ComponentType
  return (
    <ErrorBoundary pluginId={props.pluginId}>
      <Component />
    </ErrorBoundary>
  )
}

class ErrorBoundary extends Component<
  { pluginId: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[cordis-app] 插件 ${this.props.pluginId} 渲染失败:`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="notice notice-error">
        <strong>插件 {this.props.pluginId} 渲染失败</strong>
        <p>{this.state.error.message}</p>
        <button type="button" className="button" onClick={() => this.setState({ error: null })}>
          重试
        </button>
      </div>
    )
  }
}

function NotFound(props: { path: string; hasPages: boolean }): ReactNode {
  return (
    <div className="page-empty">
      <Icon name="file" size={28} />
      <p>
        没有页面注册路径 <code>{props.path}</code>
      </p>
      {!props.hasPages && <p className="settings-empty">还没有安装任何带界面的插件。</p>}
    </div>
  )
}

/** 具名插槽。框架预置几个位置，插件往其中挂组件。 */
function SlotArea(props: { name: string; className?: string }): ReactNode {
  const slots = useSlots(props.name)
  if (slots.length === 0) return null
  return (
    <div className={props.className} data-slot={props.name}>
      {slots.map((slot, index) => {
        const Component = slot.component as ComponentType
        return (
          <ErrorBoundary pluginId={slot.pluginId} key={`${slot.pluginId}-${slot.seq}-${index}`}>
            <Component />
          </ErrorBoundary>
        )
      })}
    </div>
  )
}

function ActivityBar(props: {
  pages: Array<{ path: string; name: string; icon?: string }>
  path: string
  onContextMenu(event: {
    preventDefault(): void
    clientX: number
    clientY: number
  }): void
}): ReactNode {
  return (
    <nav className="activity-bar" onContextMenu={props.onContextMenu} aria-label="活动栏">
      {props.pages.map((page) => (
        <button
          key={page.path}
          type="button"
          className={`activity-item${page.path === props.path ? ' is-active' : ''}`}
          title={page.name}
          aria-label={page.name}
          aria-current={page.path === props.path ? 'page' : undefined}
          onClick={() => navigate(page.path)}
        >
          <Icon name={page.icon} size={20} />
        </button>
      ))}

      <div className="activity-spacer" />

      <button
        type="button"
        className={`activity-item${props.path === SETTINGS_PATH ? ' is-active' : ''}`}
        title="设置"
        aria-label="设置"
        onClick={() => navigate(SETTINGS_PATH)}
      >
        <Icon name="settings" size={20} />
      </button>

      <SlotArea name="activity.bottom" className="activity-slot" />
    </nav>
  )
}
