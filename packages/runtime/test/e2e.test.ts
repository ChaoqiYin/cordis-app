/**
 * runtime 的端到端测试。
 *
 * 测试直连 startWorker 而不是 fork，省掉进程间时序的不确定性；
 * supervisor 的进程行为另有测试覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker, readWorkerOptions } from '../lib/worker/worker.js'
import { findFreePort, generateToken, buildWorkerEnv } from '../lib/supervisor/supervisor.js'
import { PluginInstaller } from '../lib/plugin/installer.js'
import { safeJoin } from '../lib/builtin/http-utils.js'
import { ENV_DATA, ENV_PORT, ENV_TOKEN, ENV_VERSION, FRAMEWORK_VERSION } from '@cordis-app/protocol'

interface Fixture {
  dataDir: string
  instanceDir: string
  resourcesDir: string
}

/** 造一个最小实例：一个只贡献 server 端点的插件。 */
function createFixture(): Fixture {
  const dataDir = mkdtempSync(join(tmpdir(), 'cordis-e2e-'))
  const instanceDir = join(dataDir, 'instances', 'default')
  const resourcesDir = join(dataDir, 'resources')
  mkdirSync(instanceDir, { recursive: true })
  mkdirSync(join(resourcesDir, 'ui'), { recursive: true })
  mkdirSync(join(resourcesDir, 'shared'), { recursive: true })
  writeFileSync(join(resourcesDir, 'ui', 'index.html'), '<!doctype html><title>test</title>')

  writeFileSync(
    join(instanceDir, 'app.json'),
    JSON.stringify({ name: 'test', version: '1.0.0', framework: '^1.0.0', plugins: { demo: '^1.0.0' } }, null, 2),
  )

  const pluginDir = join(instanceDir, 'node_modules', 'demo')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', peerDependencies: { 'cordis-app': '^1.0.0' }, type: 'module' }),
  )
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'demo', displayName: '演示插件', server: './index.js', client: './client.js' }),
  )
  writeFileSync(
    join(pluginDir, 'index.js'),
    `export const name = 'demo'
export const inject = ['router']
export function apply(ctx) {
  ctx.router.get('/api/demo', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
}
export const data = { accent: '#4f7cff' }
`,
  )
  writeFileSync(join(pluginDir, 'client.js'), 'export default () => {}')

  return { dataDir, instanceDir, resourcesDir }
}

async function withWorker(
  fn: (ctx: { port: number; token: string; base: string; handle: Awaited<ReturnType<typeof startWorker>> }) => Promise<void>,
) {
  const fixture = createFixture()
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({
    port,
    token,
    dataDir: fixture.dataDir,
    resourcesDir: fixture.resourcesDir,
  })
  try {
    await fn({ port, token, base: `http://127.0.0.1:${port}`, handle })
  } finally {
    await handle.close()
  }
}

test('/__health 免 token，只回 200 与版本', async () => {
  await withWorker(async ({ base }) => {
    const res = await fetch(`${base}/__health`)
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.version, FRAMEWORK_VERSION)
  })
})

test('/__health 与 /__plugins 使用注入的框架版本', async () => {
  const fixture = createFixture()
  const port = await findFreePort()
  const token = generateToken()
  const version = '9.9.9-injected'
  const handle = await startWorker({
    port,
    token,
    dataDir: fixture.dataDir,
    resourcesDir: fixture.resourcesDir,
    version,
  })
  try {
    const healthy = await (await fetch(`http://127.0.0.1:${port}/__health`)).json()
    assert.equal(healthy.version, version, '健康检查必须报告注入的版本，而不是模块内写死的值')

    const manifest = await (
      await fetch(`http://127.0.0.1:${port}/__plugins`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()
    assert.equal(manifest.version, version, '前端清单必须与健康检查同源')
  } finally {
    await handle.close()
  }
})

test('worker 从 supervisor 构造的环境读取框架版本', () => {
  const options = readWorkerOptions({
    [ENV_PORT]: '5140',
    [ENV_TOKEN]: 'token',
    [ENV_DATA]: '/tmp/data',
    [ENV_VERSION]: '2.3.4',
  })
  assert.equal(options.version, '2.3.4')

  const env = buildWorkerEnv({
    port: 5140,
    token: 'token',
    dataDir: '/tmp/data',
    version: '2.3.4',
  })
  assert.equal(env[ENV_VERSION], '2.3.4', 'supervisor 必须把版本随环境注入 worker')
})

test('API 缺少 token 时 401，带上 token 后 200', async () => {
  await withWorker(async ({ base, token }) => {
    const denied = await fetch(`${base}/api/demo`)
    assert.equal(denied.status, 401)

    const allowed = await fetch(`${base}/api/demo`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(allowed.status, 200)
    assert.deepEqual(await allowed.json(), { hello: 'world' })
  })
})

test('伪造 Origin 被拒绝，合法 Origin 放行', async () => {
  await withWorker(async ({ base, token, port }) => {
    const evil = await fetch(`${base}/api/demo`, {
      headers: { authorization: `Bearer ${token}`, origin: 'http://evil.example.com' },
    })
    assert.equal(evil.status, 403)

    const good = await fetch(`${base}/api/demo`, {
      headers: { authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(good.status, 200)
  })
})

test('插件清单含插件数据，因此仍需 token', async () => {
  await withWorker(async ({ base, token }) => {
    const denied = await fetch(`${base}/__plugins`)
    assert.equal(denied.status, 401, '清单含 data 字段，不能让同源之外的页面白拿')

    const res = await fetch(`${base}/__plugins`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    const manifest = await res.json()
    assert.equal(manifest.plugins.demo.displayName, '演示插件')
    assert.deepEqual(manifest.plugins.demo.data, { accent: '#4f7cff' })
    assert.equal(manifest.plugins.demo.files.length, 1)
  })
})

test('插件前端资源可被取到', async () => {
  await withWorker(async ({ base }) => {
    const ok = await fetch(`${base}/__plugins/demo/client.js`)
    assert.equal(ok.status, 200)
    assert.match(await ok.text(), /export default/)
  })
})

test('插件资源不允许路径穿越（safeJoin 直接拦截）', () => {
  // HTTP 层不用测这一条：URL 解析器会先把 %2e%2e 归一化掉，请求到不了越界形态。
  // 真正需要守住的是直接调 safeJoin 的插件代码路径。
  const base = '/tmp/plugin-root'
  assert.equal(safeJoin(base, '/../../../etc/passwd'), undefined)
  assert.equal(safeJoin(base, '%2e%2e/%2e%2e/etc/passwd'), undefined)
  assert.equal(safeJoin(base, 'a\0b'), undefined)
  assert.equal(safeJoin(base, 'client.js'), join(base, 'client.js'))
})

test('SPA 回落到 index.html', async () => {
  await withWorker(async ({ base }) => {
    const res = await fetch(`${base}/some/deep/route`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /<!doctype html>/)
  })
})

test('未声明的核心 peer 会被发现阶段拒绝', async () => {
  const fixture = createFixture()
  const pluginDir = join(fixture.instanceDir, 'node_modules', 'demo')
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module' }),
  )
  const port = await findFreePort()
  const handle = await startWorker({
    port,
    token: generateToken(),
    dataDir: fixture.dataDir,
    resourcesDir: fixture.resourcesDir,
  })
  try {
    assert.equal(handle.failures.length, 1)
    assert.match(handle.failures[0]!.reason, /peerDependencies/)
    assert.equal(Object.keys(handle.manifest.plugins).length, 0)
  } finally {
    await handle.close()
  }
})

test('一个插件失败不影响其他插件加载', async () => {
  const fixture = createFixture()
  const badDir = join(fixture.instanceDir, 'node_modules', 'bad')
  mkdirSync(badDir, { recursive: true })
  writeFileSync(
    join(badDir, 'package.json'),
    JSON.stringify({ name: 'bad', version: '1.0.0', type: 'module', peerDependencies: { 'cordis-app': '^1.0.0' } }),
  )
  writeFileSync(join(badDir, 'plugin.json'), JSON.stringify({ id: 'bad', server: './missing.js' }))

  const handle = await startWorker({
    port: await findFreePort(),
    token: generateToken(),
    dataDir: fixture.dataDir,
    resourcesDir: fixture.resourcesDir,
  })
  try {
    assert.equal(Object.keys(handle.manifest.plugins).length, 1, 'demo 仍应加载成功')
    assert.equal(handle.failures.length, 1)
    assert.equal(handle.failures[0]!.id, 'bad')
  } finally {
    await handle.close()
  }
})

test('布局比对：搬家才需要重启，新增包不算', () => {
  const before = new Map([
    ['lodash', '/nm/lodash'],
    ['demo', '/nm/demo'],
  ])
  const unchanged = new Map([...before, ['newbie', '/nm/newbie']])
  assert.deepEqual(PluginInstaller.layoutChanged(before, unchanged), [])

  const moved = new Map([...before, ['lodash', '/nm/demo/node_modules/lodash']])
  assert.deepEqual(PluginInstaller.layoutChanged(before, moved), ['lodash'])
})

test('布局比对：包被降级到嵌套目录同样算搬家', () => {
  // 顶层那份被删掉、只在 demo 下面留一份——这才是 npm/yarn 处理版本冲突时
  // 最常见的结果，只比较「还存在的键」会完全看不见它
  const before = new Map([
    ['lodash', '/nm/lodash'],
    ['demo', '/nm/demo'],
  ])
  const after = new Map([
    ['demo', '/nm/demo'],
    ['demo/node_modules/lodash', '/nm/demo/node_modules/lodash'],
  ])
  assert.deepEqual(PluginInstaller.layoutChanged(before, after).sort(), ['lodash'])
})

test('/api/restart 需要 token，并要求 worker 走优雅重启', async () => {
  const fixture = createFixture()
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({
    port,
    token,
    dataDir: fixture.dataDir,
    resourcesDir: fixture.resourcesDir,
  })

  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST' })
    assert.equal(denied.status, 401, '重启是高权限动作，不能免 token')

    // 这里不真的发重启：e2e 里 worker 是自己进程，exit(75) 会带走整个测试进程。
    // 端点存在性由上面的 401（而不是 404）证明——路由已注册，卡在鉴权那一层。
  } finally {
    await handle.close()
  }
})
