/**
 * runtime 的端到端测试。
 *
 * 测试直连 startWorker 而不是 fork，省掉进程间时序的不确定性；
 * supervisor 的进程行为另有测试覆盖。
 *
 * 所有 fixture 都是「项目根」：package.json、app.json、node_modules、
 * server/index.js、data、.cordis 都在同一个目录下，不再有 instances/default。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker, readWorkerOptions } from '../lib/worker/worker.js'
import { findFreePort, generateToken, buildWorkerEnv } from '../lib/supervisor/supervisor.js'
import { NpmInstallSource } from '../lib/plugin/npm-source.js'
import { safeJoin } from '../lib/builtin/http-utils.js'
import {
  ENV_APP_JSON,
  ENV_MODE,
  ENV_PORT,
  ENV_PROJECT,
  ENV_TOKEN,
  ENV_USER_PLUGINS,
  ENV_VERSION,
  FRAMEWORK_VERSION,
  UI_CONTRACT_VERSION,
} from '@cordis-app/protocol'

interface Fixture {
  projectRoot: string
  resourcesDir: string
  /** 打包形态的用户插件根；默认不创建 */
  userPluginsDir: string
}

interface FixtureOptions {
  /** 写进 app.json.plugins 的启用顺序 */
  enabled?: string[]
  /** node_modules 下要生成的插件 id；默认只有 demo */
  plugins?: string[]
  /** 项目 package.json 的 dependencies；默认不写 cordis-app（只产生 warning） */
  dependencies?: Record<string, string>
  /** 项目 app.json 的 ui 能力 */
  ui?: Record<string, unknown>
  /** 项目后端入口内容；null 表示不生成 server/index.js */
  server?: string | null
}

const DEFAULT_SERVER = `export default function apply(ctx) {
  ctx.router.get('/api/hello', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
  ctx.router.get('/api/order', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ source: 'project' }))
  })
}
`

/** 造一个最小项目根：插件、后端入口、UI 产物都在项目自己的布局里。 */
function createFixture(options: FixtureOptions = {}): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cordis-e2e-'))
  const resourcesDir = join(projectRoot, 'resources')
  mkdirSync(join(resourcesDir, 'ui'), { recursive: true })
  mkdirSync(join(resourcesDir, 'shared'), { recursive: true })
  writeFileSync(join(resourcesDir, 'ui', 'index.html'), '<!doctype html><title>test</title>')

  const pluginIds = options.plugins ?? ['demo']
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'test',
        version: '1.0.0',
        private: true,
        type: 'module',
        ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      },
      null,
      2,
    ),
  )
  writeFileSync(
    join(projectRoot, 'app.json'),
    JSON.stringify(
      {
        name: 'test',
        version: '1.0.0',
        plugins: options.enabled ?? pluginIds,
        ...(options.ui ? { ui: options.ui } : {}),
      },
      null,
      2,
    ),
  )

  if (options.server !== null) {
    mkdirSync(join(projectRoot, 'server'), { recursive: true })
    writeFileSync(join(projectRoot, 'server', 'index.js'), options.server ?? DEFAULT_SERVER)
  }

  for (const id of pluginIds) writePlugin(projectRoot, id)

  return { projectRoot, resourcesDir, userPluginsDir: join(projectRoot, 'user-plugins') }
}

function writePlugin(
  projectRoot: string,
  id: string,
  options: { peer?: Record<string, string>; ui?: Record<string, unknown>; client?: string } = {},
): void {
  writePluginAt(join(projectRoot, 'node_modules', id), id, options)
}

/** 在任意插件根下写一个最小可加载插件。 */
function writePluginAt(
  pluginDir: string,
  id: string,
  options: { peer?: Record<string, string>; ui?: Record<string, unknown>; client?: string } = {},
): void {
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      peerDependencies: options.peer ?? { 'cordis-app': '^1.0.0' },
      type: 'module',
    }),
  )
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      id,
      displayName: `插件 ${id}`,
      server: './index.js',
      client: './client.js',
      ...(options.ui ? { ui: options.ui } : {}),
    }),
  )
  writeFileSync(
    join(pluginDir, 'index.js'),
    `export const name = ${JSON.stringify(id)}
export const inject = ['router']
export function apply(ctx) {
  ctx.router.get('/api/${id}', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ plugin: ${JSON.stringify(id)} }))
  })
  ${id === 'demo' ? `ctx.router.get('/api/order', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ source: 'plugin' }))
  })` : ''}
}
${id === 'demo' ? "export const data = { accent: '#4f7cff' }\n" : ''}`,
  )
  writeFileSync(join(pluginDir, 'client.js'), options.client ?? 'export default () => {}')
}

async function withWorker(
  fn: (ctx: {
    port: number
    token: string
    base: string
    projectRoot: string
    handle: Awaited<ReturnType<typeof startWorker>>
  }) => Promise<void>,
  fixture = createFixture(),
) {
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({
    port,
    token,
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    userPluginsDir: fixture.userPluginsDir,
  })
  try {
    await fn({ port, token, base: `http://127.0.0.1:${port}`, projectRoot: fixture.projectRoot, handle })
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

test('运行形态决定安装来源：项目模式 npm，打包模式 bundle', async () => {
  // 项目模式即使有可写用户插件根，也仍然走 npm：来源由进程形态决定，
  // 不能因为某个可选目录存在就悄悄换掉安装语义。
  await withWorker(async ({ handle }) => {
    assert.equal(handle.sourceKind, 'npm')
  })

  const fixture = createFixture()
  mkdirSync(fixture.userPluginsDir, { recursive: true })
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({
    port,
    token,
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    userPluginsDir: fixture.userPluginsDir,
    mode: 'packaged',
  })
  try {
    assert.equal(handle.sourceKind, 'bundle')
  } finally {
    await handle.close()
  }
})

test('打包模式缺少可写用户插件根时拒绝启动', async () => {
  const fixture = createFixture()
  await assert.rejects(
    startWorker({
      port: await findFreePort(),
      token: generateToken(),
      projectRoot: fixture.projectRoot,
      resourcesDir: fixture.resourcesDir,
      mode: 'packaged',
    }),
    /打包模式必须提供 userPluginsDir/,
  )
})

test('/__health 与 /__plugins 使用注入的框架版本', async () => {
  const fixture = createFixture()
  const port = await findFreePort()
  const token = generateToken()
  const version = '9.9.9-injected'
  const handle = await startWorker({
    port,
    token,
    projectRoot: fixture.projectRoot,
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

test('worker 从 supervisor 构造的环境读取项目根与框架版本', () => {
  const options = readWorkerOptions({
    [ENV_PORT]: '5140',
    [ENV_TOKEN]: 'token',
    [ENV_PROJECT]: '/tmp/project',
    [ENV_VERSION]: '2.3.4',
    [ENV_MODE]: 'packaged',
    [ENV_USER_PLUGINS]: '/tmp/project/data/plugins',
    [ENV_APP_JSON]: '/tmp/project/dist/app.json',
  })
  assert.equal(options.projectRoot, '/tmp/project')
  assert.equal(options.version, '2.3.4')
  assert.equal(options.mode, 'packaged', '运行形态必须从环境进入 worker')
  assert.equal(options.userPluginsDir, '/tmp/project/data/plugins')
  assert.equal(options.appJson, '/tmp/project/dist/app.json', '清单覆盖必须从环境进入 worker')

  const env = buildWorkerEnv({
    port: 5140,
    token: 'token',
    projectRoot: '/tmp/project',
    version: '2.3.4',
    mode: 'packaged',
    userPluginsDir: '/tmp/project/data/plugins',
    appJson: '/tmp/project/dist/app.json',
  })
  assert.equal(env[ENV_PROJECT], '/tmp/project', 'supervisor 必须把项目根随环境注入 worker')
  assert.equal(env[ENV_VERSION], '2.3.4', 'supervisor 必须把版本随环境注入 worker')
  assert.equal(env[ENV_MODE], 'packaged', 'supervisor 必须把运行形态随环境注入 worker')
  assert.equal(env[ENV_USER_PLUGINS], '/tmp/project/data/plugins')
  assert.equal(env[ENV_APP_JSON], '/tmp/project/dist/app.json')
  assert.equal(env.HOME, '/tmp/project', 'worker 的 HOME 指向项目根，插件落盘不会跑到仓库里')

  assert.throws(
    () => readWorkerOptions({ [ENV_PORT]: '1', [ENV_TOKEN]: 't', [ENV_PROJECT]: '/p', [ENV_MODE]: 'weird' }),
    /未知运行形态/,
  )
})

test('API 缺少 token 时 401，带上 token 后 200', async () => {
  await withWorker(async ({ base, token }) => {
    const denied = await fetch(`${base}/api/demo`)
    assert.equal(denied.status, 401)

    const allowed = await fetch(`${base}/api/demo`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(allowed.status, 200)
    assert.deepEqual(await allowed.json(), { plugin: 'demo' })
  })
})

test('项目后端入口 server/index.js 的路由可访问', async () => {
  await withWorker(async ({ base, token }) => {
    const denied = await fetch(`${base}/api/hello`)
    assert.equal(denied.status, 401, '项目路由与插件路由一样受 token 保护')

    const allowed = await fetch(`${base}/api/hello`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(allowed.status, 200)
    assert.deepEqual(await allowed.json(), { hello: 'world' })
  })
})

test('项目后端入口先于应用插件注册路由', async () => {
  await withWorker(async ({ base, token }) => {
    const res = await fetch(`${base}/api/order`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { source: 'project' }, '同名路由应由项目入口先命中，说明它先于插件挂载')
  })
})

test('缺少 server/index.js 时跳过项目入口，不影响启动', async () => {
  await withWorker(
    async ({ base, token, handle }) => {
      assert.deepEqual(handle.failures, [])
      assert.equal((await fetch(`${base}/__health`)).status, 200)
      const missing = await fetch(`${base}/api/hello`, { headers: { authorization: `Bearer ${token}` } })
      assert.equal(missing.status, 404, '没有入口就没有 /api/hello，但不是启动失败')
    },
    createFixture({ server: null }),
  )
})

test('server/index.js 默认导出不是函数时启动失败并给出清晰原因', async () => {
  const fixture = createFixture({ server: 'export default 42\n' })
  const port = await findFreePort()
  await assert.rejects(
    () =>
      startWorker({
        port,
        token: generateToken(),
        projectRoot: fixture.projectRoot,
        resourcesDir: fixture.resourcesDir,
      }),
    /默认导出 apply\(ctx\)/,
  )
})

test('应用插件按 app.json.plugins 的顺序加载', async () => {
  await withWorker(
    async ({ handle }) => {
      assert.deepEqual(Object.keys(handle.manifest.plugins), ['beta', 'alpha'])
    },
    createFixture({ plugins: ['alpha', 'beta'], enabled: ['beta', 'alpha'] }),
  )
})

test('appJson 覆盖决定启用顺序与 UI 能力，源码根清单不再参与', async () => {
  // start 形态的清单在 dist/app.json，源码根的 app.json 可能不存在，
  // 也可能还是上一次构建前的旧内容。worker 只能读覆盖后的那一份。
  const fixture = createFixture({ plugins: ['alpha', 'beta'], enabled: ['alpha', 'beta'] })
  const distDir = join(fixture.projectRoot, 'dist')
  mkdirSync(distDir, { recursive: true })
  const appJson = join(distDir, 'app.json')
  const ui = { pages: true, slots: ['header.right'] }
  writeFileSync(
    appJson,
    JSON.stringify({ name: 'test', version: '1.0.0', plugins: ['beta', 'alpha'], ui }),
  )
  rmSync(join(fixture.projectRoot, 'app.json'))

  const port = await findFreePort()
  const handle = await startWorker({
    port,
    token: generateToken(),
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    userPluginsDir: fixture.userPluginsDir,
    appJson,
  })
  try {
    assert.deepEqual(
      Object.keys(handle.manifest.plugins),
      ['beta', 'alpha'],
      '启用顺序必须来自覆盖清单',
    )
    assert.deepEqual(handle.manifest.ui, ui, 'UI 能力必须来自覆盖清单')
  } finally {
    await handle.close()
  }
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
    assert.equal(manifest.plugins.demo.displayName, '插件 demo')
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
  const pluginDir = join(fixture.projectRoot, 'node_modules', 'demo')
  writeFileSync(
    join(pluginDir, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module' }),
  )
  const port = await findFreePort()
  const handle = await startWorker({
    port,
    token: generateToken(),
    projectRoot: fixture.projectRoot,
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
  const badDir = join(fixture.projectRoot, 'node_modules', 'bad')
  mkdirSync(badDir, { recursive: true })
  writeFileSync(
    join(badDir, 'package.json'),
    JSON.stringify({ name: 'bad', version: '1.0.0', type: 'module', peerDependencies: { 'cordis-app': '^1.0.0' } }),
  )
  writeFileSync(join(badDir, 'plugin.json'), JSON.stringify({ id: 'bad', server: './missing.js' }))

  const handle = await startWorker({
    port: await findFreePort(),
    token: generateToken(),
    projectRoot: fixture.projectRoot,
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

test('配置写进项目 data/config.json，项目根没有 instances 与 app.lock', async () => {
  await withWorker(async ({ base, token, projectRoot }) => {
    const res = await fetch(`${base}/api/config/demo`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: { accent: '#000' } }),
    })
    assert.equal(res.status, 200)

    const configPath = join(projectRoot, 'data', 'config.json')
    assert.equal(existsSync(configPath), true, '配置必须落在 <project>/data/config.json')
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { demo: { accent: '#000' } })

    assert.equal(existsSync(join(projectRoot, 'instances')), false, '项目模式不再有 instances/')
    assert.equal(existsSync(join(projectRoot, 'app.lock')), false, 'app.json 之外不再有公共 lock')
  })
})

test('布局比对：搬家才需要重启，新增包不算', () => {
  const before = new Map([
    ['lodash', '/nm/lodash'],
    ['demo', '/nm/demo'],
  ])
  const unchanged = new Map([...before, ['newbie', '/nm/newbie']])
  assert.deepEqual(NpmInstallSource.layoutChanged(before, unchanged), [])

  const moved = new Map([...before, ['lodash', '/nm/demo/node_modules/lodash']])
  assert.deepEqual(NpmInstallSource.layoutChanged(before, moved), ['lodash'])
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
  assert.deepEqual(NpmInstallSource.layoutChanged(before, after).sort(), ['lodash'])
})

test('/api/restart 需要 token，并要求 worker 走优雅重启', async () => {
  const fixture = createFixture()
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({
    port,
    token,
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    userPluginsDir: fixture.userPluginsDir,
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

test('前端清单带 UI 契约版本、body 能力、插件 UI 需求与失败记录', async () => {
  const ui = { pages: true, slots: ['header.right'], menus: ['activity'], settings: true }
  const fixture = createFixture({ plugins: [], ui })
  writePluginAt(join(fixture.projectRoot, 'node_modules', 'withui'), 'withui', {
    ui: { pages: true, slots: ['header.right'] },
  })

  await withWorker(async ({ base, token }) => {
    const manifest = await (
      await fetch(`${base}/__plugins`, { headers: { authorization: `Bearer ${token}` } })
    ).json()

    assert.equal(manifest.uiContractVersion, UI_CONTRACT_VERSION)
    assert.deepEqual(manifest.ui, ui, 'body 能力来自 app.json，随清单下发')
    assert.deepEqual(manifest.plugins.withui.ui, { pages: true, slots: ['header.right'] })
    assert.deepEqual(manifest.failures, [], '清单本身要带上前端可读的失败记录')
  }, fixture)
})

test('四个根各放一个插件，都能加载并提供客户端资源', async () => {
  const fixture = createFixture({ plugins: [] })
  writePluginAt(join(fixture.resourcesDir, 'plugins', 'builtin-one'), 'builtin-one')
  writePluginAt(join(fixture.projectRoot, 'plugins', 'local-one'), 'local-one')
  writePluginAt(join(fixture.projectRoot, 'node_modules', 'dep-one'), 'dep-one')
  writePluginAt(join(fixture.userPluginsDir, 'user-one'), 'user-one')
  const ids = ['builtin-one', 'local-one', 'dep-one', 'user-one']

  await withWorker(async ({ base, token, handle }) => {
    assert.deepEqual(Object.keys(handle.manifest.plugins).sort(), [...ids].sort())

    for (const id of ids) {
      const res = await fetch(`${base}/__plugins/${id}/client.js`)
      assert.equal(res.status, 200, `${id} 的客户端资源应可从 /__plugins/<id>/ 取到`)
      assert.match(await res.text(), /export default/)
    }

    // /api/plugins 与启动扫描使用同一套发现逻辑
    const list = await (
      await fetch(`${base}/api/plugins`, { headers: { authorization: `Bearer ${token}` } })
    ).json()
    assert.deepEqual(
      list.plugins.map((plugin: { id: string }) => plugin.id).sort(),
      [...ids].sort(),
    )
  }, fixture)
})

test('打包模式用户插件根生效，且不把项目源码插件根当成本地根', async () => {
  const fixture = createFixture({ plugins: [] })
  // 同名插件同时存在于构建产出的内置根与项目源码 plugins/：start 形态下
  // 源码根已由 build 复制进内置根，再扫一遍只会产生重复 id failure。
  writePluginAt(join(fixture.resourcesDir, 'plugins', 'same'), 'same', {
    client: "export default 'builtin'",
  })
  writePluginAt(join(fixture.projectRoot, 'plugins', 'same'), 'same')
  // 用户安装的插件仍然必须被发现。
  writePluginAt(join(fixture.userPluginsDir, 'user-only'), 'user-only')

  const handle = await startWorker({
    port: await findFreePort(),
    token: generateToken(),
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    userPluginsDir: fixture.userPluginsDir,
    mode: 'packaged',
  })
  try {
    assert.deepEqual(handle.failures, [], '内置与源码同名不应产生重复 id failure')
    assert.deepEqual(Object.keys(handle.manifest.plugins).sort(), ['same', 'user-only'])
  } finally {
    await handle.close()
  }
})

test('打包模式不扫描项目依赖根：node_modules 里的插件不会被加载', async () => {
  // 打包应用只应加载内置产物与用户签名安装的插件。可执行目录旁边恰好存在
  // node_modules 时，未签名的依赖不能被当成插件挂上。
  const fixture = createFixture({ plugins: [] })
  writePluginAt(join(fixture.projectRoot, 'node_modules', 'dep-only'), 'dep-only')
  writePluginAt(join(fixture.resourcesDir, 'plugins', 'builtin-one'), 'builtin-one')
  writePluginAt(join(fixture.userPluginsDir, 'user-one'), 'user-one')

  const handle = await startWorker({
    port: await findFreePort(),
    token: generateToken(),
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    userPluginsDir: fixture.userPluginsDir,
    mode: 'packaged',
  })
  try {
    assert.deepEqual(handle.failures, [])
    assert.deepEqual(
      Object.keys(handle.manifest.plugins).sort(),
      ['builtin-one', 'user-one'],
      '打包模式只认识内置根与用户根',
    )
  } finally {
    await handle.close()
  }
})

test('跨根重复 id 只产生一条失败，高优先级插件仍可用', async () => {
  const fixture = createFixture({ plugins: [] })
  writePluginAt(join(fixture.resourcesDir, 'plugins', 'dup'), 'dup', {
    client: "export default 'builtin'",
  })
  writePluginAt(join(fixture.projectRoot, 'plugins', 'dup'), 'dup', {
    client: "export default 'local'",
  })
  writePluginAt(join(fixture.projectRoot, 'node_modules', 'dup'), 'dup', {
    client: "export default 'dependency'",
  })

  await withWorker(async ({ base, handle }) => {
    assert.equal(handle.failures.length, 1, '同一个 id 的跨根冲突只报一条')
    assert.equal(handle.failures[0]!.id, 'dup')
    assert.match(handle.failures[0]!.reason, /内置插件/)
    assert.deepEqual(Object.keys(handle.manifest.plugins), ['dup'])

    const res = await fetch(`${base}/__plugins/dup/client.js`)
    assert.equal(res.status, 200)
    assert.match(await res.text(), /builtin/, '静态资源也必须解析到高优先级的内置插件')
  }, fixture)
})

test('不兼容的 cordis-app peer 在启动时失败并给出可读原因', async () => {
  const fixture = createFixture({ plugins: [] })
  writePluginAt(join(fixture.projectRoot, 'node_modules', 'too-old'), 'too-old', {
    peer: { 'cordis-app': '^0.9.0' },
  })

  await withWorker(async ({ handle }) => {
    assert.equal(handle.failures.length, 1)
    assert.equal(handle.failures[0]!.id, 'too-old')
    assert.match(handle.failures[0]!.reason, /\^0\.9\.0/)
    assert.ok(
      handle.failures[0]!.reason.includes(FRAMEWORK_VERSION),
      '失败原因必须同时给出当前框架版本',
    )
    assert.deepEqual(Object.keys(handle.manifest.plugins), [], '不兼容插件不进入前端清单')
  }, fixture)
})

test('项目 cordis-app 依赖不兼容时启动失败并给出清晰原因', async () => {
  const fixture = createFixture({ plugins: [], dependencies: { 'cordis-app': '^0.9.0' } })
  const port = await findFreePort()

  await assert.rejects(
    () =>
      startWorker({
        port,
        token: generateToken(),
        projectRoot: fixture.projectRoot,
        resourcesDir: fixture.resourcesDir,
        userPluginsDir: fixture.userPluginsDir,
      }),
    /cordis-app@\^0\.9\.0.*不兼容/,
  )
})

test('项目依赖 doctor 覆盖手工安装（未走 CLI）的插件', async () => {
  const fixture = createFixture({ plugins: [], dependencies: { 'cordis-app': '^1.0.0' } })
  writePluginAt(join(fixture.projectRoot, 'node_modules', 'manual'), 'manual')

  await withWorker(async ({ handle }) => {
    assert.deepEqual(Object.keys(handle.manifest.plugins), ['manual'])
  }, fixture)
})
