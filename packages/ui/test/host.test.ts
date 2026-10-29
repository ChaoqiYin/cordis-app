/**
 * body 宿主的 SSR 契约。
 *
 * 这里不启动浏览器、不跑 Vite：用 `react-dom/server` 渲染一个最小 body，
 * 断言插件页面、具名插槽、设置面板和菜单触发器都按公开出口工作。
 * 这正是项目 body 能替换布局、却不会封死插件 UI 的最小证明。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClientRuntime, RuntimeContext } from 'cordis-app/client'
import {
  BodyHost,
  DefaultBody,
  PluginMenuTrigger,
  PluginPageOutlet,
  PluginSlot,
  SettingsPanel,
  currentPath,
  navigate,
  usePath,
  warnUiCompatibility,
  warnUiContractVersion,
} from '../dist/host/index.js'

/**
 * 一个假插件：页面与插槽组件直接返回字符串，因此不需要在 data URL 里 import React。
 */
const PLUGIN_MODULE = `
export default (ctx) => {
  ctx.page({ path: '/demo', name: '示例页', component: () => '插件页面内容' })
  ctx.slot({ type: 'header.right', component: () => '顶栏插槽内容' })
  ctx.slot({ type: 'activity.bottom', component: () => '活动栏插槽内容' })
  ctx.menu('activity', [{ id: '.open', label: '打开' }])
  ctx.settings({ id: 'main', title: '示例设置' })
}
`

function pluginEntry(id = 'demo') {
  return {
    id,
    files: [`data:text/javascript,${encodeURIComponent(PLUGIN_MODULE)}`],
  }
}

function runtimeWithRuntimeContext(): ClientRuntime {
  return new ClientRuntime({ token: 'test-token' })
}

function render(runtime: ClientRuntime, node: ReactNode): string {
  return renderToStaticMarkup(
    createElement(RuntimeContext.Provider, { value: runtime }, node),
  )
}

test('无 window 时路由安全：路径为 /，导航是 no-op', () => {
  assert.equal(currentPath(), '/')
  assert.doesNotThrow(() => navigate('/demo'))
  assert.equal(currentPath(), '/')

  function PathProbe(): ReactNode {
    return createElement('span', null, usePath())
  }
  assert.equal(renderToStaticMarkup(createElement(PathProbe)), '<span>/</span>')
})

test('最小自定义 body 通过 SSR 渲染插件页面、插槽与设置面板', async () => {
  const runtime = runtimeWithRuntimeContext()
  await runtime.loadPlugin(pluginEntry())

  const html = render(
    runtime,
    createElement(
      BodyHost,
      null,
      createElement(
        'div',
        { className: 'minimal-body' },
        createElement(PluginSlot, { name: 'header.right', className: 'header-right' }),
        createElement(PluginPageOutlet, {
          path: '/demo',
          fallback: createElement('p', null, '没有匹配的页面'),
        }),
        createElement(SettingsPanel),
      ),
    ),
  )

  assert.match(html, /插件页面内容/)
  assert.match(html, /顶栏插槽内容/)
  assert.match(html, /示例设置/)
  assert.doesNotMatch(html, /没有匹配的页面/)
})

test('PluginPageOutlet 在未命中时渲染 fallback', () => {
  const runtime = runtimeWithRuntimeContext()
  const html = render(
    runtime,
    createElement(PluginPageOutlet, {
      path: '/nowhere',
      fallback: createElement('p', null, '没有匹配的页面'),
    }),
  )
  assert.match(html, /没有匹配的页面/)
})

test('PluginMenuTrigger 绑定菜单 id，并保留调用方已有的 onContextMenu', () => {
  const runtime = runtimeWithRuntimeContext()
  let bound: ((event: unknown) => void) | undefined
  let existingCalls = 0

  function TriggerProbe(props: { onContextMenu?: (event: unknown) => void }): ReactNode {
    bound = props.onContextMenu
    return createElement('span', null, '菜单触发器')
  }

  const html = render(
    runtime,
    createElement(
      PluginMenuTrigger,
      { menuId: 'activity' },
      createElement(TriggerProbe, {
        onContextMenu: () => {
          existingCalls++
        },
      }),
    ),
  )

  assert.match(html, /菜单触发器/)
  assert.equal(typeof bound, 'function')

  let prevented = false
  bound!({ preventDefault: () => (prevented = true), clientX: 12, clientY: 34 })

  assert.equal(existingCalls, 1, '调用方已有 handler 必须继续执行')
  assert.equal(prevented, true)
  assert.deepEqual(runtime.getMenu(), { menuId: 'activity', x: 12, y: 34 })
})

test('DefaultBody 提供 pages、slots、menus、settings 全部能力', () => {
  const runtime = runtimeWithRuntimeContext()
  runtime.registry.addPage('demo', {
    path: '/',
    name: '首页',
    component: () => '默认 body 页面内容',
  })
  runtime.registry.addSlot('demo', { type: 'header.right', component: () => '头部插槽' })
  runtime.registry.addSlot('demo', { type: 'activity.bottom', component: () => '活动栏插槽' })
  runtime.registry.addMenu('demo', 'activity', [{ id: '.open', label: '打开' }])

  const html = render(runtime, createElement(BodyHost, null, createElement(DefaultBody)))

  assert.match(html, /默认 body 页面内容/)
  assert.match(html, /头部插槽/)
  assert.match(html, /活动栏插槽/)
  assert.match(html, /设置/, '默认 body 必须保留设置入口')
  assert.doesNotMatch(html, /未找到页面/)
})

test('卸载插件后页面、插槽、菜单与设置全部消失', async () => {
  const runtime = runtimeWithRuntimeContext()
  await runtime.loadPlugin(pluginEntry())

  assert.equal(runtime.registry.getPage('/demo')?.pluginId, 'demo')
  assert.equal(runtime.registry.listSlots('header.right').length, 1)
  assert.equal(runtime.registry.listMenu('activity').length, 1)
  assert.equal(runtime.registry.listSettings().length, 1)

  runtime.unloadPlugin('demo')

  assert.equal(runtime.registry.getPage('/demo'), undefined)
  assert.equal(runtime.registry.listSlots('header.right').length, 0)
  assert.equal(runtime.registry.listMenu('activity').length, 0)
  assert.equal(runtime.registry.listSettings().length, 0)
})

test('UI 需求缺失时告警，但不改变“后端可加载”的语义', () => {
  const warnings: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(' '))
  try {
    const match = warnUiCompatibility(
      'demo',
      { pages: true, slots: ['sidebar.left'], menus: ['activity'], settings: true },
      { pages: true, slots: [], menus: [], settings: false },
    )

    assert.equal(match.compatibility, 'backend-only')
    assert.equal(warnings.length, 1)
    for (const missing of ['slot:sidebar.left', 'menu:activity', 'settings']) {
      assert.ok(warnings[0]!.includes(missing), `告警应列出缺失项 ${missing}：${warnings[0]}`)
    }
    assert.ok(!warnings[0]!.includes('pages'), '已满足的 pages 不应出现在缺失项里')

    warnUiContractVersion(2)
    assert.equal(warnings.length, 2)
    assert.match(warnings[1]!, /契约版本/)
  } finally {
    console.warn = original
  }
})
