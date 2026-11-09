/**
 * 设置页插件管理的 SSR 契约。
 *
 * `PluginManager` 是纯组件：数据与回调都由 `SettingsPanel` 注入。这里不启动
 * 浏览器，用 `react-dom/server` 断言两个分组与来源徽标；按钮回调通过遍历
 * 返回的元素树直接触发，避免引入 DOM 测试环境。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  PluginManager,
  type PluginInfo,
  type PluginManagerProps,
  type UninstalledPluginInfo,
} from '../dist/host/index.js'

const plugins: PluginInfo[] = [
  {
    id: 'bundle-plugin',
    displayName: '随包插件',
    version: '1.0.0',
    rootKind: 'builtin',
    origin: 'builtin',
    enabled: true,
    reinstallable: false,
    files: [],
  },
  {
    id: 'local-plugin',
    displayName: '项目本地插件',
    version: '0.2.0',
    rootKind: 'local',
    origin: 'local',
    enabled: true,
    reinstallable: false,
    files: [],
  },
  {
    id: 'external-plugin',
    displayName: '外部插件',
    version: '2.3.4',
    rootKind: 'dependency',
    origin: 'external',
    enabled: true,
    reinstallable: false,
    files: [],
  },
  {
    id: 'gone-plugin',
    displayName: '已卸载的随包插件',
    version: '1.1.0',
    rootKind: 'builtin',
    origin: 'builtin',
    enabled: false,
    reinstallable: true,
    files: [],
  },
]

const uninstalled: UninstalledPluginInfo[] = [
  {
    id: 'gone-plugin',
    displayName: '重复的卸载记录',
    version: '9.9.9',
    rootKind: 'builtin',
    origin: 'builtin',
    reinstallable: true,
  },
  {
    id: 'external-gone',
    displayName: '已卸载外部插件',
    version: '3.0.0',
    rootKind: 'dependency',
    origin: 'external',
    spec: 'example-plugin@3.0.0',
    reinstallable: true,
  },
  {
    id: 'unreinstallable',
    displayName: '无法重装的插件',
    rootKind: 'user',
    origin: 'external',
    reinstallable: false,
  },
]

const failures = [
  { id: 'external-plugin', reason: '入口加载失败' },
  { id: 'gone-plugin', reason: '已卸载插件的历史失败' },
]

function baseProps(overrides: Partial<PluginManagerProps> = {}): PluginManagerProps {
  return {
    plugins,
    uninstalled,
    failures,
    busy: null,
    onInstall: async () => {},
    onUninstall: async () => {},
    onEnable: async () => {},
    ...overrides,
  }
}

function render(props: PluginManagerProps): string {
  return renderToStaticMarkup(createElement(PluginManager, props))
}

function collectElements(node: ReactNode, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out)
    return out
  }
  if (!isValidElement(node)) return out
  out.push(node)
  const props = node.props as { children?: ReactNode }
  collectElements(props.children, out)
  return out
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

function findRow(tree: ReactNode, pluginId: string): ReactElement {
  const rows = collectElements(tree).filter(
    (element) =>
      element.type === 'li' &&
      (element.props as Record<string, unknown>)['data-plugin-id'] === pluginId,
  )
  assert.equal(rows.length, 1, `插件 ${pluginId} 应恰好渲染一行`)
  return rows[0]!
}

function findButton(row: ReactElement, label: string): ReactElement {
  const buttons = collectElements(row).filter(
    (element) => element.type === 'button' && textOf(element) === label,
  )
  assert.equal(buttons.length, 1, `行内应恰好有一个「${label}」按钮`)
  return buttons[0]!
}

function rowMarkup(html: string, pluginId: string): string {
  const marker = `data-plugin-id="${pluginId}"`
  const start = html.indexOf(marker)
  assert.ok(start >= 0, `插件 ${pluginId} 应渲染一行`)
  const end = html.indexOf('</li>', start)
  return html.slice(start, end)
}

test('三种来源徽标按 origin 显示：随包、项目本地、外部', () => {
  const html = render(baseProps())

  const expected = [
    ['bundle-plugin', 'builtin', '随包'],
    ['local-plugin', 'local', '项目本地'],
    ['external-plugin', 'external', '外部'],
    ['external-gone', 'external', '外部'],
  ] as const

  for (const [id, origin, label] of expected) {
    const row = rowMarkup(html, id)
    assert.match(row, new RegExp(`class="plugin-origin plugin-origin-${origin}"`))
    assert.match(row, new RegExp(`>${label}<`))
  }
})

test('已启用与已卸载两个分组，合并时按 id 去重', () => {
  const html = render(baseProps())

  assert.match(html, /已启用/)
  assert.match(html, /已卸载/)
  assert.equal(
    html.split('data-plugin-id="gone-plugin"').length - 1,
    1,
    '已卸载插件在两组之间只能出现一次',
  )

  const [enabledSection, uninstalledSection] = html.split('<h3>已卸载</h3>')
  assert.doesNotMatch(enabledSection!, /data-plugin-id="gone-plugin"/)
  assert.match(uninstalledSection!, /data-plugin-id="gone-plugin"/)
  assert.match(uninstalledSection!, /已卸载的随包插件/)
  assert.doesNotMatch(html, /重复的卸载记录/, '去重时保留扫描结果里的展示信息')

  assert.match(html, /1\.0\.0/)
  assert.match(html, /2\.3\.4/)
})

test('卸载与启用按钮调用注入的回调', () => {
  const calls: string[] = []
  const tree = PluginManager(
    baseProps({
      onUninstall: async (id) => {
        calls.push(`uninstall:${id}`)
      },
      onEnable: async (id) => {
        calls.push(`enable:${id}`)
      },
    }),
  )

  const uninstall = findButton(findRow(tree, 'bundle-plugin'), '卸载')
  ;(uninstall.props as { onClick(): void }).onClick()

  const enable = findButton(findRow(tree, 'external-gone'), '启用')
  ;(enable.props as { onClick(): void }).onClick()

  assert.deepEqual(calls, ['uninstall:bundle-plugin', 'enable:external-gone'])
})

test('reinstallable: false 时禁用启用按钮并说明原因', () => {
  const tree = PluginManager(baseProps())

  const blocked = findRow(tree, 'unreinstallable')
  const blockedButton = findButton(blocked, '启用')
  assert.equal((blockedButton.props as { disabled?: boolean }).disabled, true)
  assert.match(textOf(blocked), /无法一键重装/)
  assert.match(textOf(blocked), /安装表单/)

  const allowedButton = findButton(findRow(tree, 'external-gone'), '启用')
  assert.equal((allowedButton.props as { disabled?: boolean }).disabled, false)
})

test('失败列表显示 API 返回的全部失败', () => {
  const html = render(baseProps())

  assert.match(html, /以下插件加载失败/)
  // API 已经排除已卸载插件；前端不再二次过滤，否则会把 API 认为有效的失败藏起来。
  assert.match(html, /入口加载失败/)
  assert.match(html, /已卸载插件的历史失败/)
})

test('界面不出现「停用」按钮或文案', () => {
  const html = render(baseProps())

  assert.doesNotMatch(html, /停用/)
})
