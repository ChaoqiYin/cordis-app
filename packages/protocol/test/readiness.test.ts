/**
 * 就绪模型的契约测试。
 *
 * 重点在 waitForReady 的两段式语义：重启场景必须先看到一次「不可用」，
 * 否则会把即将退出的旧进程当成重启完成。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handshakeOf, isRuntimeFile, runtimeFileOf, waitForReady } from '../lib/readiness.js'
import type { HandshakeLine, RuntimeFile } from '../lib/types.js'

function clock(): { now(): number; sleep(ms: number): Promise<void> } {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
  }
}

test('handshakeOf 把握手行归一成就绪描述', () => {
  const line: HandshakeLine = {
    ready: true,
    port: 5199,
    token: 'secret',
    version: '1.2.3',
    failures: [{ id: 'bad', reason: '坏了' }],
  }

  assert.deepEqual(handshakeOf(line), {
    port: 5199,
    token: 'secret',
    version: '1.2.3',
    failures: [{ id: 'bad', reason: '坏了' }],
  })
})

test('runtimeFileOf 与握手描述同一组字段，失败列表为空', () => {
  const file: RuntimeFile = {
    port: 5199,
    token: 'secret',
    version: '1.2.3',
    pid: 42,
    startedAt: '2026-10-29T00:00:00.000Z',
  }

  assert.deepEqual(runtimeFileOf(file), {
    port: 5199,
    token: 'secret',
    version: '1.2.3',
    failures: [],
  })
})

test('isRuntimeFile 拒绝残留的半截文件', () => {
  const valid: RuntimeFile = {
    port: 5199,
    token: 'secret',
    version: '1.2.3',
    pid: 42,
    startedAt: '2026-10-29T00:00:00.000Z',
  }

  assert.equal(isRuntimeFile(valid), true)
  assert.equal(isRuntimeFile({ ...valid, token: '' }), false)
  assert.equal(isRuntimeFile({ ...valid, port: '5199' }), false)
  assert.equal(isRuntimeFile({ port: 5199, pid: 42 }), false)
  assert.equal(isRuntimeFile(null), false)
})

test('requireDownFirst：先等旧进程下线，再等新进程就绪', async () => {
  const c = clock()
  const answers = [true, true, false, true]
  let probes = 0

  const ready = await waitForReady({
    requireDownFirst: true,
    intervalMs: 10,
    timeoutMs: 1000,
    now: c.now,
    sleep: c.sleep,
    probe: async () => {
      probes++
      return answers.shift() ?? false
    },
  })

  assert.equal(ready, true)
  assert.equal(probes, 4, '三次探测确认下线，第四次确认上线')
})

test('不要求先下线时，第一次探测成功即返回', async () => {
  const c = clock()
  let probes = 0

  const ready = await waitForReady({
    intervalMs: 10,
    timeoutMs: 1000,
    now: c.now,
    sleep: c.sleep,
    probe: async () => {
      probes++
      return true
    },
  })

  assert.equal(ready, true)
  assert.equal(probes, 1)
})

test('超时后返回 false，且不会无限轮询', async () => {
  const c = clock()
  let probes = 0

  const ready = await waitForReady({
    requireDownFirst: true,
    intervalMs: 10,
    timeoutMs: 100,
    downTimeoutMs: 30,
    now: c.now,
    sleep: c.sleep,
    probe: async () => {
      probes++
      return false
    },
  })

  assert.equal(ready, false)
  // 第一次探测确认「已经下线」后进入就绪段；就绪段在 0..90ms 各探一次，共 11 次
  assert.equal(probes, 11)
})
