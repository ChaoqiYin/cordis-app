/**
 * 注册表的纯逻辑测试。
 *
 * 注册表是整个前端扩展点的落点：页面、插槽、菜单、行为、设置都经过它。
 * 它刻意不依赖 React，所以可以像服务端代码一样直接测——这正是当初把它与
 * Hooks 分开的原因。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Registry, expandId, isFrameworkItem, normalizeShortcut } from '../src/client/registry.ts'

/** 注册表不看组件内容，只存引用——所以一个空函数就够充当扩展点。 */
const Stub = () => null

test('相对 id 展开为插件命名空间，绝对 id 原样保留', () => {
  assert.equal(expandId('hello', '.reset'), 'hello/reset')
  assert.equal(expandId('hello', 'other/thing'), 'other/thing')
  assert.equal(expandId('hello', '@separator'), '@separator')
})

test('@ 命名空间归框架所有', () => {
  assert.equal(isFrameworkItem('@separator'), true)
  assert.equal(isFrameworkItem('.reset'), false)
})

test('插件不能定义未知的 @ 项，只能放置已知的', () => {
  const registry = new Registry()
  const warnings: string[] = []
  registry.onWarning((w) => warnings.push(w.message))

  registry.addMenu('hello', 'activity', [{ id: '@nope' }, { id: '@separator', order: 5 }])

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /@nope/)
  const items = registry.listMenu('activity')
  assert.equal(items.length, 1)
  assert.equal(items[0]!.kind, 'separator')
  assert.equal(items[0]!.disabled, true, '@ 项不能有行为')
})

test('菜单项按 order 升序，同序按注册顺序稳定排序', () => {
  const registry = new Registry()
  registry.addMenu('a', 'activity', [{ id: '.b', order: 20 }])
  registry.addMenu('a', 'activity', [{ id: '.a', order: 10 }])
  registry.addMenu('a', 'activity', [{ id: '.c', order: 20 }])

  assert.deepEqual(
    registry.listMenu('activity').map((i) => i.id),
    ['a/a', 'a/b', 'a/c'],
  )
})

test('跨插件占用同一菜单 id：后来者被拒绝并告警', () => {
  const registry = new Registry()
  const warnings: string[] = []
  registry.onWarning((w) => warnings.push(w.message))

  registry.addMenu('a', 'activity', [{ id: 'shared/x' }])
  registry.addMenu('b', 'activity', [{ id: 'shared/x' }])

  assert.equal(warnings.length, 1)
  assert.equal(registry.listMenu('activity').length, 1)
  assert.equal(registry.listMenu('activity')[0]!.pluginId, 'a')
})

test('跨插件占用同一页面路径：后来者被忽略', () => {
  const registry = new Registry()
  const warnings: string[] = []
  registry.onWarning((w) => warnings.push(w.message))

  registry.addPage('a', { path: '/x', name: 'A', component: Stub })
  const rejected = registry.addPage('b', { path: '/x', name: 'B', component: Stub })

  assert.equal(warnings.length, 1)
  assert.equal(registry.getPage('/x')!.pluginId, 'a')
  rejected.dispose() // 不能误删别人的页面
  assert.equal(registry.getPage('/x')!.pluginId, 'a')
})

test('后注册者卸载不会删掉先注册者的同 id 条目', () => {
  const registry = new Registry()
  const first = registry.addSlot('a', { type: 'header.right', component: Stub })
  registry.addSettings('a', { id: 'main', title: 'main' })

  // 手工构造一次「同 key 覆盖」：先撤掉，再重新注册同一插件
  first.dispose()
  const second = registry.addSlot('a', { type: 'header.right', component: Stub })
  first.dispose() // 已经撤过一次，再撤不应影响 second

  assert.equal(registry.listSlots('header.right').length, 1)
  second.dispose()
  assert.equal(registry.listSlots('header.right').length, 0)
})

/**
 * 这一条防的是无限重渲染。
 *
 * `useSyncExternalStore` 每次渲染后都会比较 getSnapshot 的返回值引用，
 * 列表每次新建数组就会被判定为「一直在变」，最终抛 React error #185。
 */
test('同一版本内列表返回同一个数组实例', () => {
  const registry = new Registry()
  registry.addPage('a', { path: '/x', name: 'A', component: Stub })

  const pages = registry.listPages()
  assert.equal(registry.listPages(), pages)
  assert.equal(registry.listSlots('header.right'), registry.listSlots('header.right'))
  assert.equal(registry.listMenu('activity'), registry.listMenu('activity'))
  assert.equal(registry.listSettings(), registry.listSettings())

  // 注册新页面让版本号递增，缓存必须失效
  registry.addPage('a', { path: '/y', name: 'B', component: Stub })
  const after = registry.listPages()
  assert.notEqual(after, pages)
  assert.equal(after.length, 2)
  assert.equal(registry.listPages(), after)
})

test('快捷键归一化：CmdOrCtrl 按平台展开，修饰键顺序无关', () => {
  const isMac = /Mac|iPhone|iPad/.test(process.platform === 'darwin' ? 'Mac' : 'Linux')
  const modifier = isMac ? 'meta' : 'ctrl'

  assert.equal(normalizeShortcut('CmdOrCtrl+Shift+R'), `${modifier}+shift+r`)
  assert.equal(normalizeShortcut('Shift+CmdOrCtrl+R'), `${modifier}+shift+r`)
  assert.equal(normalizeShortcut('cmdorctrl+shift+r'), `${modifier}+shift+r`)
  assert.equal(normalizeShortcut('Ctrl+Alt+P'), 'ctrl+alt+p')
})

test('按快捷键查找行为，找不到返回 undefined', () => {
  const registry = new Registry()
  registry.addAction('hello', '.reset', { action: () => {}, shortcut: 'CmdOrCtrl+Shift+R' })

  const found = registry.findActionByShortcut('CmdOrCtrl+Shift+R')
  assert.equal(found?.id, 'hello/reset')
  assert.equal(registry.findActionByShortcut('CmdOrCtrl+Shift+Q'), undefined)
})

test('菜单项的 action 与菜单项用同一套 id 配对', () => {
  const registry = new Registry()
  registry.addMenu('hello', 'activity', [{ id: '.reset' }])
  registry.addAction('hello', '.reset', { action: () => {} })

  const item = registry.listMenu('activity')[0]!
  assert.ok(registry.findAction(item.id), `菜单项 ${item.id} 应能找到行为`)
})
