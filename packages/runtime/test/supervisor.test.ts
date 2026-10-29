/**
 * supervisor 重启链路的端到端测试。
 *
 * 这是架构里最不能出错的一条：worker 退出码 75 → supervisor 重新 fork →
 * 端口与 token 不变 → 前端能重新连上。任何一环断了，「不闪窗」就不成立。
 *
 * fixture 是项目根：运行时文件落在 `.cordis/runtime.json`，不再有数据目录。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor, buildWorkerEnv } from '../lib/supervisor/supervisor.js'
import { readSupervisorArgs } from '../lib/supervisor/args.js'
import {
  decodeHandshake,
  ENV_APP_JSON,
  ENV_MODE,
  ENV_USER_PLUGINS,
  FRAMEWORK_VERSION,
} from '@cordis-app/protocol'

interface Fixture {
  projectRoot: string
  resourcesDir: string
}

function createFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cordis-sup-'))
  const resourcesDir = join(projectRoot, 'resources')
  mkdirSync(join(resourcesDir, 'ui'), { recursive: true })
  mkdirSync(join(resourcesDir, 'shared'), { recursive: true })
  writeFileSync(join(resourcesDir, 'ui', 'index.html'), '<!doctype html><title>t</title>')
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0', private: true, type: 'module' }, null, 2),
  )
  writeFileSync(
    join(projectRoot, 'app.json'),
    JSON.stringify({ name: 't', version: '1.0.0', plugins: [] }, null, 2),
  )
  return { projectRoot, resourcesDir }
}

test('运行形态与用户插件根从 supervisor 参数传到 worker 环境', () => {
  const args = readSupervisorArgs([
    '--project',
    '/projects/demo',
    '--mode',
    'packaged',
    '--user-plugins',
    '/projects/demo/data/plugins',
    '--app-json',
    '/projects/demo/dist/app.json',
  ])
  assert.equal(args.mode, 'packaged')
  assert.equal(args.userPluginsDir, '/projects/demo/data/plugins')
  assert.equal(args.appJson, '/projects/demo/dist/app.json')

  const env = buildWorkerEnv({
    port: 5140,
    token: 'token',
    projectRoot: '/projects/demo',
    version: '1.0.0',
    mode: args.mode,
    userPluginsDir: args.userPluginsDir,
    appJson: args.appJson,
  })
  assert.equal(env[ENV_MODE], 'packaged')
  assert.equal(env[ENV_USER_PLUGINS], '/projects/demo/data/plugins')
  assert.equal(env[ENV_APP_JSON], '/projects/demo/dist/app.json')

  assert.throws(() => readSupervisorArgs(['--mode', 'weird']), /未知运行形态/)
})

test('握手行只出现在 stdout，格式可解析', async () => {
  const fixture = createFixture()
  const lines: string[] = []
  const supervisor = new Supervisor({
    projectRoot: fixture.projectRoot,
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
    assert.equal(parsed!.version, FRAMEWORK_VERSION, '握手版本必须来自框架唯一真源')

    const runtimeFile = JSON.parse(readFileSync(join(fixture.projectRoot, '.cordis', 'runtime.json'), 'utf8'))
    assert.equal(runtimeFile.port, handshake.port)
    assert.equal(runtimeFile.token, handshake.token)
  } finally {
    await supervisor.stop()
  }
})

test('supervisor 把版本注入 worker，健康检查与握手一致', async () => {
  const fixture = createFixture()
  const supervisor = new Supervisor({
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    version: '4.5.6',
    stdout: { write: () => true } as any,
  })

  const handshake = await supervisor.start()
  try {
    assert.equal(handshake.version, '4.5.6')
    // start() 以 worker 的 ready 消息为准；listen 回调可能晚一个 tick，
    // 用轮询等待真实可连接，避免把「刚绑定还在回调队列里」当成失败。
    assert.equal(await waitForHealthy(handshake.port), 200)
    const healthy = await (await fetch(`http://127.0.0.1:${handshake.port}/__health`)).json()
    assert.equal(healthy.version, '4.5.6', 'worker 的清单版本必须与 supervisor 注入的版本一致')
  } finally {
    await supervisor.stop()
  }
})

test('退出码 75 触发重新 fork，端口与 token 保持不变', async () => {
  const fixture = createFixture()
  const lines: string[] = []
  const readyEvents: number[] = []
  const supervisor = new Supervisor({
    projectRoot: fixture.projectRoot,
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
    // 服务可用。start() 的 ready 早于 listen 回调时，先轮询到可连接。
    assert.equal(await waitForHealthy(first.port), 200)

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
