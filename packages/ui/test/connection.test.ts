/**
 * 连接状态机的契约测试。
 *
 * 重连是整条链路里最难手工复现的部分：要真的让 worker 退出、再等它回来。
 * 把 WebSocket、fetch、时钟收进 Transport 端口后，这里用假传输把每条状态
 * 迁移都跑一遍——包括「旧连接的 close 事件迟到」这种只在竞态下出现的场景。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RECONNECT_EVENT } from '@cordis-app/protocol/client'
import { connect, type ConnectionState, type Transport, type TransportSocket } from '../src/client/connection.ts'
// 只取类型：连接状态机只需要 runtime.token，不必真的构造一个 ClientRuntime
import type { ClientRuntime } from '../src/client/runtime.ts'

function fakeRuntime(): ClientRuntime {
  return { token: 'secret' } as unknown as ClientRuntime
}

/** 等一轮宏任务：状态机内部的 await 链会在这之前全部排空。 */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

class FakeSocket implements TransportSocket {
  closed = false
  private readonly openListeners: Array<() => void> = []
  private readonly messageListeners: Array<(data: string) => void> = []
  private readonly closeListeners: Array<() => void> = []

  onOpen(listener: () => void): void {
    this.openListeners.push(listener)
  }

  onMessage(listener: (data: string) => void): void {
    this.messageListeners.push(listener)
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  close(): void {
    this.closed = true
  }

  fireOpen(): void {
    for (const listener of this.openListeners) listener()
  }

  fireMessage(data: string): void {
    for (const listener of this.messageListeners) listener(data)
  }

  fireClose(): void {
    for (const listener of this.closeListeners) listener()
  }
}

/** 假传输：探测结果按队列回放，等待只推进假时钟。 */
class FakeTransport implements Transport {
  readonly sockets: FakeSocket[] = []
  readonly waits: number[] = []
  readonly probeResults: boolean[] = []
  probes = 0
  private time = 0

  open(): TransportSocket {
    const socket = new FakeSocket()
    this.sockets.push(socket)
    return socket
  }

  async probe(): Promise<boolean> {
    this.probes++
    return this.probeResults.shift() ?? false
  }

  async wait(ms: number): Promise<void> {
    this.waits.push(ms)
    this.time += ms
  }

  now(): number {
    return this.time
  }
}

function setup() {
  const transport = new FakeTransport()
  const runtime = fakeRuntime()
  const connection = connect(runtime, transport)
  const states: ConnectionState[] = []
  connection.onStateChange((state) => states.push(state))
  return { transport, connection, states }
}

test('连接建立后从 connecting 进入 ready', () => {
  const { transport, connection, states } = setup()

  assert.equal(transport.sockets.length, 1)
  const socket = transport.sockets[0]!
  assert.equal(socket.closed, false)

  socket.fireOpen()
  assert.deepEqual(states, ['ready'])

  connection.close()
  assert.equal(socket.closed, true, 'close 必须真的关掉底层连接')
})

test('server:reconnect：轮询恢复后先重放清单，再建立新连接', async () => {
  const transport = new FakeTransport()
  const runtime = fakeRuntime()
  const connection = connect(runtime, transport)
  transport.probeResults.push(false, true)

  const observations: string[] = []
  connection.onReconnected(async () => {
    observations.push(`reload@${transport.sockets.length}`)
  })

  const first = transport.sockets[0]!
  first.fireOpen()
  first.fireMessage(JSON.stringify({ type: RECONNECT_EVENT }))

  assert.equal(first.closed, true, '收到重连通知应立即断开旧连接')

  await tick()

  assert.deepEqual(transport.waits, [200], '第一次探测失败后应按最短间隔重试')
  assert.deepEqual(observations, ['reload@1'], '清单重放时新连接尚未建立')
  assert.equal(transport.sockets.length, 2)
  connection.close()
})

test('意外断开后按退避节奏轮询，恢复后重建连接', async () => {
  const { transport, connection, states } = setup()
  transport.probeResults.push(false, false, true)

  const first = transport.sockets[0]!
  first.fireOpen()
  first.fireClose()
  await tick()

  assert.deepEqual(states, ['ready', 'reconnecting', 'connecting'])
  assert.deepEqual(transport.waits, [200, 400], '前几次探测密集，随后放宽')
  assert.equal(transport.sockets.length, 2)

  transport.sockets[1]!.fireOpen()
  assert.deepEqual(states, ['ready', 'reconnecting', 'connecting', 'ready'])
  connection.close()
})

test('重放监听者尚未完成时不会建立新连接', async () => {
  const { transport, connection } = setup()
  transport.probeResults.push(true)

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let reloaded = false
  connection.onReconnected(async () => {
    await gate
    reloaded = true
  })

  transport.sockets[0]!.fireClose()
  await tick()

  assert.equal(reloaded, false)
  assert.equal(transport.sockets.length, 1, '清单没到位就不该开连接')

  release()
  await tick()

  assert.equal(reloaded, true)
  assert.equal(transport.sockets.length, 2)
  connection.close()
})

test('轮询超过 30 秒仍不可用则进入 failed，且不会无限空转', async () => {
  const { transport, connection, states } = setup()

  transport.sockets[0]!.fireOpen()
  transport.sockets[0]!.fireClose()
  await tick()

  assert.deepEqual(states, ['ready', 'reconnecting', 'failed'])
  assert.ok(transport.probes > 1)
  assert.ok(transport.waits.length < 30, '退避必须收窄成有限次探测')
  assert.ok(transport.now() >= 30_000)
  connection.close()
})

test('旧连接迟到的关闭事件不会打断新连接', async () => {
  const { transport, connection } = setup()
  transport.probeResults.push(true)

  const first = transport.sockets[0]!
  first.fireOpen()
  first.fireMessage(JSON.stringify({ type: RECONNECT_EVENT }))
  await tick()

  const second = transport.sockets[1]!
  second.fireOpen()

  // 旧连接在主动 close 之后才姗姗来迟地报告关闭
  first.fireClose()
  await tick()

  assert.equal(transport.sockets.length, 2, '不应被迟到事件拖入第二轮重连')
  transport.probes = 0
  second.fireMessage('not json')
  assert.equal(transport.probes, 0, '非重连消息不应触发轮询')
  connection.close()
})

test('close 之后不再连、也不再探测', async () => {
  const { transport, connection } = setup()

  const socket = transport.sockets[0]!
  connection.close()
  socket.fireClose()
  await tick()

  assert.equal(transport.sockets.length, 1)
  assert.equal(transport.probes, 0)
})
