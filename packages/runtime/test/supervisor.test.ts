/**
 * supervisor 重启链路的端到端测试。
 *
 * 这是架构里最不能出错的一条：worker 退出码 75 → supervisor 重新 fork →
 * 端口与 token 不变 → 前端能重新连上。任何一环断了，「不闪窗」就不成立。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../lib/supervisor/supervisor.js'
import { decodeHandshake } from '@cordis-app/protocol'

interface Fixture {
  dataDir: string
  instanceDir: string
  resourcesDir: string
}

function createFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'cordis-sup-'))
  const instanceDir = join(dataDir, 'instances', 'default')
  const resourcesDir = join(dataDir, 'resources')
  mkdirSync(join(resourcesDir, 'ui'), { recursive: true })
  mkdirSync(join(resourcesDir, 'shared'), { recursive: true })
  mkdirSync(instanceDir, { recursive: true })
  writeFileSync(join(resourcesDir, 'ui', 'index.html'), '<!doctype html><title>t</title>')
  writeFileSync(
    join(instanceDir, 'app.json'),
    JSON.stringify({ name: 't', version: '1.0.0', framework: '^1.0.0', plugins: {} }, null, 2),
  )
  return { dataDir, instanceDir, resourcesDir }
}

test('握手行只出现在 stdout，格式可解析', async () => {
  const fixture = createFixture()
  const lines: string[] = []
  const supervisor = new Supervisor({
    dataDir: fixture.dataDir,
    resourcesDir: fixture.resourcesDir,
    stdout: {
      write(chunk: string | Uint8Array) {
        lines.push(chunk.toString())
        return true
      },
    } as any,
  })

  const handshake = await supervisor.start()
  try {
    assert.equal(lines.length, 1, 'stdout 上应该只有一行握手')
    const parsed = decodeHandshake(lines[0]!.trim())
    assert.ok(parsed, '握手行必须能被解析')
    assert.equal(parsed!.token, handshake.token)
    assert.equal(parsed!.ready, true)
    assert.deepEqual(parsed!.failures, [])

    const runtimeFile = JSON.parse(readFileSync(join(fixture.dataDir, 'runtime.json'), 'utf8'))
    assert.equal(runtimeFile.port, handshake.port)
    assert.equal(runtimeFile.token, handshake.token)
  } finally {
    await supervisor.stop()
  }
})

test('退出码 75 触发重新 fork，端口与 token 保持不变', async () => {
  const fixture = createFixture()
  const lines: string[] = []
  const readyEvents: number[] = []
  const supervisor = new Supervisor({
    dataDir: fixture.dataDir,
    resourcesDir: fixture.resourcesDir,
    onReady: (payload) => readyEvents.push(payload.port),
    stdout: {
      write(chunk: string | Uint8Array) {
        lines.push(chunk.toString())
        return true
      },
    } as any,
  })

  const first = await supervisor.start()
  try {
    // 服务可用
    const before = await fetch(`http://127.0.0.1:${first.port}/__health`)
    assert.equal(before.status, 200)

    // 触发优雅重启：worker 收到 SIGTERM 后 process.exit(75)
    supervisor.restart()

    // 等到 supervisor 报告第二次就绪
    await waitFor(() => readyEvents.length >= 2, 15000)

    assert.equal(lines.length, 2, '每次就绪都应输出一行握手')
    const second = decodeHandshake(lines[1]!.trim())!
    assert.equal(second.port, first.port, '端口必须跨重启不变，否则页面落在旧 origin 上')
    assert.equal(second.token, first.token, 'token 必须跨重启不变，否则无法重连')

    // 重启后服务恢复，且用原 token 仍能访问
    const after = await waitForHealthy(first.port)
    assert.equal(after, 200)
  } finally {
    await supervisor.stop()
  }
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('等待超时')
}

async function waitForHealthy(port: number): Promise<number | undefined> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/__health`)
      if (res.status === 200) return res.status
    } catch {
      // 服务还没起来，继续轮询——这正是前端在重启期间的盲区
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return undefined
}
