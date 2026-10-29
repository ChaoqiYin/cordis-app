/**
 * `startApp()` 的生命周期契约。
 *
 * 大部分用例注入假的 supervisor 子进程：这里要验证的是握手解析、事件、
 * 幂等停止与错误分类，不需要真实端口。最后一条用例跑真实子进程，确认
 * 「supervisor 是子进程」这条约束没有被实现偷懒成进程内启动。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeHandshake, type HandshakeLine } from '@cordis-app/protocol'
import {
  startApp,
  StartAppError,
  type SpawnSupervisor,
  type SupervisorChild,
} from '../lib/start-app.js'

class FakeChild extends EventEmitter implements SupervisorChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killed: NodeJS.Signals[] = []

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed.push(signal)
    queueMicrotask(() => this.emit('exit', 0, signal))
    return true
  }
}

function handshake(overrides: Partial<HandshakeLine> = {}): HandshakeLine {
  return {
    ready: true,
    port: 4321,
    token: 'test-token',
    version: '1.0.0',
    failures: [],
    ...overrides,
  }
}

/** 注入 spawn：每个子进程启动后异步写入握手行。 */
function fakeSpawn(payload: HandshakeLine = handshake()) {
  const children: FakeChild[] = []
  const calls: string[][] = []
  const spawn: SpawnSupervisor = (_command, args) => {
    calls.push(args)
    const child = new FakeChild()
    children.push(child)
    queueMicrotask(() => child.stdout.write(encodeHandshake(payload) + '\n'))
    return child
  }
  return { spawn, children, calls }
}

const baseOptions = { projectRoot: '/tmp/cordis-start-app-test', stderr: { write() {} } }

test('startApp 解析握手行并返回 url / token / port', async () => {
  const fake = fakeSpawn(handshake({ port: 5140, token: 'abc' }))
  const app = await startApp({ ...baseOptions, spawn: fake.spawn })

  assert.equal(app.port, 5140)
  assert.equal(app.token, 'abc')
  assert.equal(app.url, 'http://127.0.0.1:5140/#token=abc')
  // 项目根与 resources 都通过参数交给 supervisor，而不是由 startApp 自己加载。
  assert.match(fake.calls[0]![0]!, /supervisor[\\/]main\.js$/)
  assert.deepEqual(fake.calls[0]!.slice(1), ['--project', baseOptions.projectRoot])
  await app.stop()
})

test('ready 与 plugin-failure 事件在返回后仍能被订阅到', async () => {
  const fake = fakeSpawn(
    handshake({ failures: [{ id: 'broken', reason: '缺少 plugin.json' }] }),
  )
  const app = await startApp({ ...baseOptions, spawn: fake.spawn })

  const ready: number[] = []
  const failures: string[] = []
  app.on('ready', (payload) => ready.push(payload.port))
  app.on('plugin-failure', (failure) => failures.push(failure.id))
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.deepEqual(ready, [4321])
  assert.deepEqual(failures, ['broken'])
  await app.stop()
})

test('stop 幂等，只向同一个子进程发一次终止信号', async () => {
  const fake = fakeSpawn()
  const app = await startApp({ ...baseOptions, spawn: fake.spawn })

  await app.stop()
  await app.stop()

  assert.deepEqual(fake.children[0]!.killed, ['SIGTERM'])
})

test('restart 先停后起，并暴露新的端口与 token', async () => {
  const payloads = [handshake({ port: 4001, token: 'one' }), handshake({ port: 4002, token: 'two' })]
  const children: FakeChild[] = []
  const spawn: SpawnSupervisor = () => {
    const payload = payloads[children.length]!
    const child = new FakeChild()
    children.push(child)
    queueMicrotask(() => child.stdout.write(encodeHandshake(payload) + '\n'))
    return child
  }

  const app = await startApp({ ...baseOptions, spawn })
  assert.equal(app.port, 4001)

  await app.restart()
  assert.equal(children.length, 2)
  assert.deepEqual(children[0]!.killed, ['SIGTERM'])
  assert.equal(app.port, 4002)
  assert.equal(app.token, 'two')

  await app.stop()
})

test('就绪前以 76 退出映射为可读的端口占用错误', async () => {
  const spawn: SpawnSupervisor = () => {
    const child = new FakeChild()
    queueMicrotask(() => child.emit('exit', 76, null))
    return child
  }

  await assert.rejects(
    () => startApp({ ...baseOptions, spawn }),
    (error: unknown) => {
      assert.ok(error instanceof StartAppError)
      assert.equal(error.kind, 'exit')
      assert.equal(error.exitCode, 76)
      assert.match(error.message, /端口被占用/)
      return true
    },
  )
})

test('启动超时会 reject 并终止子进程', async () => {
  const children: FakeChild[] = []
  const spawn: SpawnSupervisor = () => {
    const child = new FakeChild()
    children.push(child)
    return child
  }

  await assert.rejects(
    () => startApp({ ...baseOptions, spawn, timeoutMs: 20 }),
    (error: unknown) => {
      assert.ok(error instanceof StartAppError)
      assert.equal(error.kind, 'timeout')
      assert.match(error.message, /启动超时/)
      return true
    },
  )
  assert.deepEqual(children[0]!.killed, ['SIGTERM'])
})

test('start 形态把 resources 与 server 入口传给 supervisor', async () => {
  const fake = fakeSpawn()
  const app = await startApp({
    ...baseOptions,
    spawn: fake.spawn,
    resourcesDir: '/p/dist/resources',
    serverEntry: '/p/dist/server/index.js',
  })
  assert.deepEqual(fake.calls[0]!.slice(1), [
    '--project',
    baseOptions.projectRoot,
    '--resources',
    '/p/dist/resources',
    '--server-entry',
    '/p/dist/server/index.js',
  ])
  await app.stop()
})

test('真实子进程生命周期：握手可访问，stop 后退出', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cordis-start-app-real-'))
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0', private: true, type: 'module' }),
  )
  writeFileSync(join(projectRoot, 'app.json'), JSON.stringify({ name: 't', version: '1.0.0', plugins: [] }))

  const app = await startApp({ projectRoot, stderr: { write() {} }, timeoutMs: 20_000 })
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/__health`)
    assert.equal(res.status, 200)
    const body = (await res.json()) as { ok: boolean }
    assert.equal(body.ok, true)
  } finally {
    await app.stop()
  }

  await assert.rejects(() => fetch(`http://127.0.0.1:${app.port}/__health`, { signal: AbortSignal.timeout(1000) }))
})
