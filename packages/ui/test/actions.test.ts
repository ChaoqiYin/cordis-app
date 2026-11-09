/**
 * 行为调用入口的纯逻辑测试。
 *
 * `invokeAction` 是 Hooks 与测试共用的最小缝隙：它只负责「找到行为、判断
 * disabled、带上下文执行」，不读取菜单状态。菜单渲染器显式把上下文传进来。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClientRuntime } from '../src/client/runtime.ts'
import { invokeAction } from '../src/client/actions.ts'

/** 行为在微任务里执行；等一轮宏任务让 Promise 链落地。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('invokeAction 把调用上下文原样传给行为', async () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  const context = { recordId: 42 }
  let received: unknown = '尚未调用'

  runtime.registry.addAction('demo', '.run', {
    action: (value) => {
      received = value
    },
  })

  invokeAction(runtime, 'demo/run', context)
  await flush()

  assert.equal(received, context)
})

test('invokeAction 未传上下文时行为收到 undefined', async () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  let received: unknown = '尚未调用'

  runtime.registry.addAction('demo', '.run', {
    action: (value) => {
      received = value
    },
  })

  invokeAction(runtime, 'demo/run')
  await flush()

  assert.equal(received, undefined)
})

test('invokeAction 在行为 disabled 时不执行', async () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  let calls = 0

  runtime.registry.addAction('demo', '.run', {
    disabled: true,
    action: () => {
      calls++
    },
  })

  invokeAction(runtime, 'demo/run', { recordId: 42 })
  await flush()

  assert.equal(calls, 0)
})
