/**
 * 自定义项目 body 参考示例。
 *
 * 复制到 `<project>/src/body.tsx` 即可作为起点（项目脚手架已经生成
 * `src/pages/Home.tsx`，示例只依赖它）。它刻意不复用 `DefaultBody`，用来
 * 演示「布局完全由项目决定，但四个宿主出口一个都不能少」：
 *
 *   - pages     `PluginPageOutlet` 渲染当前路径的插件页面
 *   - slots     `PluginSlot` 渲染 `header.right` 与 `activity.bottom`
 *   - menus     `PluginMenuTrigger` 把活动栏按钮绑定到 `activity` 菜单
 *   - settings  `SettingsPanel` + `SETTINGS_PATH` 提供框架设置页
 *
 * 项目页面优先于插件页面：同路径时本项目渲染自己的页面，只在开发期告警。
 */

import { useEffect, type ComponentType, type ReactElement, type ReactNode } from 'react'
import { usePages } from 'cordis-app/client'
import {
  BodyHost,
  PluginMenuTrigger,
  PluginPageOutlet,
  PluginSlot,
  SETTINGS_PATH,
  SettingsPanel,
  navigate,
  usePath,
} from 'cordis-app/ui'
import Home from './pages/Home'

interface ProjectPage {
  path: string
  name: string
  component: ComponentType
}

/** 项目自己的页面表；新增页面时在这里登记即可。 */
const PROJECT_PAGES: ProjectPage[] = [{ path: '/', name: '首页', component: Home }]

export default function Body(): ReactElement {
  const path = usePath()
  const pluginPages = usePages()
  const isSettings = path === SETTINGS_PATH
  const projectPage = PROJECT_PAGES.find((page) => page.path === path)

  // 项目页面与插件页面同路径时项目优先；开发期提示作者，避免「插件装了但
  // 看不到」被误判成插件故障。
  useEffect(() => {
    for (const page of PROJECT_PAGES) {
      if (pluginPages.some((pluginPage) => pluginPage.path === page.path)) {
        console.warn(
          `[cordis-app] 项目页面 ${page.path} 与插件页面同路径，项目页面优先渲染`,
        )
      }
    }
  }, [pluginPages])

  let content: ReactNode
  if (isSettings) {
    content = <SettingsPanel />
  } else if (projectPage) {
    const ProjectPage = projectPage.component
    content = <ProjectPage />
  } else {
    content = (
      <PluginPageOutlet
        path={path}
        fallback={<p className="custom-empty">没有找到页面：{path}</p>}
      />
    )
  }

  return (
    <BodyHost>
      <div className="custom-body">
        <aside className="custom-sidebar">
          <PluginMenuTrigger menuId="activity">
            <button type="button" className="custom-brand">
              我的应用
            </button>
          </PluginMenuTrigger>

          <nav className="custom-nav" aria-label="页面">
            {PROJECT_PAGES.map((page) => (
              <button
                key={page.path}
                type="button"
                aria-current={page.path === path ? 'page' : undefined}
                onClick={() => navigate(page.path)}
              >
                {page.name}
              </button>
            ))}
            {pluginPages.map((page) => (
              <button
                key={page.path}
                type="button"
                aria-current={page.path === path ? 'page' : undefined}
                onClick={() => navigate(page.path)}
              >
                {page.name}
              </button>
            ))}
          </nav>

          <PluginSlot name="activity.bottom" className="custom-activity-bottom" />
        </aside>

        <main className="custom-main">
          <header className="custom-header">
            <h1>{isSettings ? '设置' : (projectPage?.name ?? '')}</h1>
            <PluginSlot name="header.right" className="custom-header-right" />
            <button type="button" onClick={() => navigate(SETTINGS_PATH)}>
              设置
            </button>
          </header>

          <section className="custom-content">{content}</section>
        </main>
      </div>
    </BodyHost>
  )
}
