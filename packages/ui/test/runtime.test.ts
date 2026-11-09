/**
 * 客户端运行时菜单状态的纯逻辑测试。
 *
 * 运行时刻意不依赖 React，因此可以直接在 Node 里断言「打开 → 读取 → 关闭」
 * 这一条链路；宿主组件与 Hooks 都只是它的调用方。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClientRuntime } from '../src/client/runtime.ts'

test('打开菜单时保存调用上下文，关闭后清空', () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  const context = { recordId: 42 }

  runtime.openMenu('activity', 10, 20, context)

  assert.equal(runtime.getMenu()?.context, context)

  runtime.closeMenu()

  assert.equal(runtime.getMenu(), null, '关闭菜单必须同时清空上下文')
})

test('未传上下文时菜单状态保持原有形状', () => {
  const runtime = new ClientRuntime({ token: 'test-token' })

  runtime.openMenu('activity', 10, 20)

  const menu = runtime.getMenu()
  assert.deepEqual(menu, { menuId: 'activity', x: 10, y: 20 })
  assert.equal(
    Object.prototype.hasOwnProperty.call(menu, 'context'),
    false,
    '未传上下文时不应多出 context 自有属性',
  )
})
