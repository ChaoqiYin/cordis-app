/**
 * 行为调用入口的纯逻辑测试。
 *
 * `runAction` 是 Hooks 与测试共用的最小缝隙：它只负责「判断 disabled、带
 * 上下文执行、把 Promise 拒绝交给 console.error」，不读取菜单状态。
 * `invokeAction` 与 `useShortcuts` 都通过它执行行为。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ClientRuntime } from '../src/client/runtime.ts'
import { invokeAction, runAction } from '../src/client/actions.ts'

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

test('runAction 返回行为是否可执行，并把上下文原样传给行为', async () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  const context = { recordId: 42 }
  let received: unknown = '尚未调用'

  runtime.registry.addAction('demo', '.run', {
    action: (value) => {
      received = value
    },
  })
  runtime.registry.addAction('demo', '.off', {
    disabled: true,
    action: () => {},
  })

  assert.equal(runAction(runtime.registry.findAction('demo/run')!, context), true)
  assert.equal(runAction(runtime.registry.findAction('demo/off')!), false)
  await flush()

  assert.equal(received, context)
})

test('runAction 把行为的 Promise 拒绝交给 console.error', async () => {
  const runtime = new ClientRuntime({ token: 'test-token' })
  const errors: unknown[][] = []
  const original = console.error
  console.error = (...args: unknown[]) => errors.push(args)
  try {
    runtime.registry.addAction('demo', '.fail', {
      action: () => Promise.reject(new Error('行为失败')),
    })

    assert.equal(runAction(runtime.registry.findAction('demo/fail')!), true)
    await flush()

    assert.equal(errors.length, 1, 'Promise 拒绝必须走 console.error')
    assert.match(String(errors[0]![0]), /demo\/fail/)
  } finally {
    console.error = original
  }
})
