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

test('未传上下文时菜单状态仍写入 context 字段', () => {
  const runtime = new ClientRuntime({ token: 'test-token' })

  runtime.openMenu('activity', 10, 20)

  assert.deepEqual(runtime.getMenu(), {
    menuId: 'activity',
    x: 10,
    y: 20,
    context: undefined,
  })
})

test('服务恢复时逐个通知重连监听者，退订后不再通知', async () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  const calls: string[] = []

  const unsubscribeFirst = runtime.onReconnected(() => {
    calls.push('first')
  })
  runtime.onReconnected(async () => {
    calls.push('second')
  })

  await runtime.notifyReconnected()
  assert.deepEqual(calls, ['first', 'second'])

  unsubscribeFirst()
  await runtime.notifyReconnected()
  assert.deepEqual(calls, ['first', 'second', 'second'], '退订的监听者不应再被调用')
})

test('单个重连监听者抛错不影响其他监听者', async () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  const calls: string[] = []
  const originalError = console.error
  console.error = () => {}

  try {
    runtime.onReconnected(() => {
      throw new Error('刷新失败')
    })
    runtime.onReconnected(() => {
      calls.push('after-failure')
    })

    await runtime.notifyReconnected()
    assert.deepEqual(calls, ['after-failure'])
  } finally {
    console.error = originalError
  }
})
