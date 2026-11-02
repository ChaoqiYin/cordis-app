/**
 * 默认 body：框架附带的参考布局。
 *
 * 它声明并提供全部 UI 能力（pages / slots / menus / settings），项目可以整体
 * 替换它，但替换后必须自己保留这些出口。布局只依赖宿主出口组件，不直接碰
 * 注册表，也不 import 样式——样式属于 SPA 入口。
 */

import { useEffect, type ReactNode } from 'react'
import { usePages } from 'cordis-app/client'
import { Icon } from './icons.js'
import { navigate, usePath } from './router.js'
import { PluginMenuTrigger } from './PluginMenuTrigger.js'
import { PluginPageOutlet } from './PluginPageOutlet.js'
import { PluginSlot } from './PluginSlot.js'
import { SettingsPanel } from './SettingsPanel.js'

/**
 * 设置页是框架自己的页面，不属于任何插件。
 *
 * 它固定在活动栏底部、不参与插件页面的 order 排序：否则插件可以把它挤到某个
 * 不讲道理的位置，而设置是每个应用都必须有的入口。
 */
export const SETTINGS_PATH = '/settings'

export function DefaultBody(): ReactNode {
  const pages = usePages()
  const path = usePath()

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
      <ActivityBar pages={pages} path={path} />

      <main className="content">
        <header className="content-header">
          <h1 className="content-title">{isSettings ? '设置' : (active?.name ?? '未找到页面')}</h1>
          <PluginSlot name="header.right" className="header-right" />
        </header>

        <div className="content-body">
          {isSettings ? (
            <SettingsPanel />
          ) : (
            <PluginPageOutlet fallback={<NotFound path={path} hasPages={pages.length > 0} />} />
          )}
        </div>
      </main>
    </div>
  )
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

function ActivityBar(props: {
  pages: Array<{ path: string; name: string; icon?: string }>
  path: string
}): ReactNode {
  return (
    <PluginMenuTrigger menuId="activity">
      <nav className="activity-bar" aria-label="活动栏">
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

        <PluginSlot name="activity.bottom" className="activity-slot" />
      </nav>
    </PluginMenuTrigger>
  )
}
