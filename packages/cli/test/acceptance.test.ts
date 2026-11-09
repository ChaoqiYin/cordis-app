/**
 * 项目模式端到端验收。
 *
 * 这一条测试只走公开边界：
 *   `new` 脚手架 → 用测试密钥构造并安装 `.cordis-plugin` → `startWorker`
 *   → 拉 `/__plugins` 清单 → `react-dom/server` 渲染项目 body
 *   → 卸载 → 重启后清单与页面都消失。
 *
 * 刻意不联网、不执行 PATH 中的 npm、不启动真实浏览器：bundle 通过注入的
 * `readArchive` 读取本地归档，安装来源是 `BundleInstallSource`；前端靠
 * `ClientRuntime` 动态 import 插件客户端，再用 SSR 观察它注册的出口。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build as esbuild } from 'esbuild'
import { serverPreset } from '@cordis-app/preset'
import { ClientRuntime, RuntimeContext } from '@cordis-app/ui'
import { buildProject } from '@cordis-app/ui/build'
import {
  BodyHost,
  PluginMenuTrigger,
  PluginPageOutlet,
  PluginSlot,
  SettingsPanel,
} from '@cordis-app/ui/host'
import { FRAMEWORK_VERSION } from '@cordis-app/protocol'
import type { ClientManifest } from '@cordis-app/protocol'
import {
  BUNDLE_FILE,
  BundleInstallSource,
  PluginInstaller,
  bundleSignaturePayload,
  computeBundleHash,
  createTarGz,
  findFreePort,
  generateToken,
  readTarGz,
  scanPluginRoots,
  startWorker,
} from '@cordis-app/runtime'
import type { BundleManifest, WorkerHandle } from '@cordis-app/runtime'
import { commandEnable, commandNew, commandRemove, parseArgs } from '../lib/index.js'

/** 插件前端必须不 import 任何模块：它经 data URL 加载，没有模块解析环境。 */
const PLUGIN_CLIENT = `
export default (ctx) => {
  ctx.page({ path: '/hello', name: 'Hello', component: () => '来自签名插件包的页面' })
  ctx.slot({ type: 'header.right', component: () => '来自插件包的插槽' })
  ctx.menu('activity', [{ id: '.open', label: '插件菜单项' }])
  ctx.settings({ id: 'main', title: '插件设置面板' })
}
`

const PLUGIN_SERVER = `
export const name = 'hello'
export const inject = ['router']

export function apply(ctx) {
  ctx.router.get('/api/plugin-hello', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ from: 'bundle' }))
  })
}
`

const PLUGIN_UI = {
  pages: true,
  slots: ['header.right'],
  menus: ['activity'],
  settings: true,
}

interface TestBundle {
  bytes: Buffer
  publicKey: string
  manifest: BundleManifest
}

interface BuildBundleOptions {
  id?: string
  displayName?: string
  /** 已构建的服务端入口内容；缺省用不带依赖的最小实现。 */
  server?: string
}

/** 用一次性 Ed25519 密钥构造一个合法的签名插件包。 */
function buildBundle(options: BuildBundleOptions = {}): TestBundle {
  const id = options.id ?? 'hello'
  const version = '1.0.0'
  const peer = { 'cordis-app': '^1.0.0' }
  const ui = PLUGIN_UI
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const files = new Map<string, Uint8Array>()
  files.set(
    'plugin.json',
    Buffer.from(
      JSON.stringify(
        {
          id,
          displayName: options.displayName ?? 'Hello',
          description: '验收测试用的假插件',
          version,
          server: 'server.js',
          client: 'client.js',
          ui,
        },
        null,
        2,
      ),
    ),
  )
  files.set(
    'package.json',
    Buffer.from(
      JSON.stringify(
        {
          name: `cordis-plugin-${id}`,
          version,
          type: 'module',
          peerDependencies: peer,
        },
        null,
        2,
      ),
    ),
  )
  files.set('server.js', Buffer.from(options.server ?? PLUGIN_SERVER))
  files.set('client.js', Buffer.from(PLUGIN_CLIENT))

  const hash = computeBundleHash(files)
  const signature = sign(
    null,
    bundleSignaturePayload({ id, version, hash, peer, ui }),
    privateKey,
  ).toString('base64')
  const manifest: BundleManifest = {
    id,
    version,
    hash,
    signature,
    algorithm: 'ed25519',
    peer,
    ui,
  }
  files.set(BUNDLE_FILE, Buffer.from(JSON.stringify(manifest, null, 2)))
  return {
    bytes: createTarGz(files),
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    manifest,
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

async function startPackagedWorker(
  projectRoot: string,
  userDataDir: string,
  publicKey: string,
  dist?: { resourcesDir: string; serverEntry: string; appJson: string },
): Promise<{ handle: WorkerHandle; token: string; base: string }> {
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({
    port,
    token,
    projectRoot,
    userPluginsDir: join(userDataDir, 'plugins'),
    mode: 'packaged',
    bundle: { publicKey },
    ...(dist ?? {}),
  })
  return { handle, token, base: `http://127.0.0.1:${port}` }
}

/** 轮询健康检查，避免 supervisor 握手与 HTTP 监听之间的短暂竞态。 */
async function waitForHealth(base: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/__health`)
      if (res.status === 200) return
      lastError = new Error(`健康检查返回 ${res.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw lastError ?? new Error('健康检查超时')
}

/** 在项目 node_modules 里放一个假 npm 依赖；构建期必须把它打进产物。 */
function writeDependency(root: string, name: string, marker: string): string {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.js' }),
  )
  writeFileSync(join(dir, 'index.js'), `export const marker = '${marker}'\n`)
  return marker
}

function writeProjectDependency(root: string, name: string): string {
  return writeDependency(root, name, 'PROCESS_SELF_CONTAINED_MARKER')
}

/** 用插件作者实际使用的 `serverPreset` 构建插件服务端入口。 */
async function buildPluginServer(
  pluginRoot: string,
  entry: string,
  outfile: string,
): Promise<string> {
  await esbuild({
    ...serverPreset({ entry, outfile, root: pluginRoot, minify: false, sourcemap: false }),
    absWorkingDir: pluginRoot,
    logLevel: 'silent',
  })
  return readFileSync(join(pluginRoot, outfile), 'utf8')
}

async function fetchManifest(base: string, token: string): Promise<ClientManifest> {
  const res = await fetch(`${base}/__plugins`, {
    headers: { authorization: `Bearer ${token}` },
  })
  assert.equal(res.status, 200)
  return (await res.json()) as ClientManifest
}

/** 项目 body：自己布局，同时保留四个宿主出口。 */
function ProjectBody(): ReactNode {
  return createElement(
    BodyHost,
    null,
    createElement(
      'div',
      { className: 'acceptance-body' },
      createElement(
        PluginMenuTrigger,
        { menuId: 'activity' },
        createElement('button', { type: 'button' }, '活动栏'),
      ),
      createElement(PluginSlot, { name: 'header.right' }),
      createElement(PluginPageOutlet, { path: '/hello' }),
      createElement(SettingsPanel),
    ),
  )
}

function renderBody(runtime: ClientRuntime): string {
  return renderToStaticMarkup(
    createElement(RuntimeContext.Provider, { value: runtime }, createElement(ProjectBody)),
  )
}

test('项目模式闭环：new → 安装签名插件包 → 启动 → 渲染 → 卸载 → 页面消失', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cordis-acceptance-'))
  const projectRoot = join(work, 'demo')
  const userDataDir = join(work, 'userdata')
  const pluginRoot = join(userDataDir, 'plugins', 'hello@1.0.0')
  const bundle = buildBundle()
  const bundlePath = join(work, 'hello.cordis-plugin')
  writeFileSync(bundlePath, bundle.bytes)

  try {
    // 1. 脚手架：只写文件，不联网。
    const io = {
      out: () => {},
      err: () => {},
      frameworkVersion: FRAMEWORK_VERSION,
    }
    assert.equal(
      await commandNew(parseArgs(['new', 'demo', '--project', projectRoot]), io),
      0,
    )

    const projectPackage = readJson(join(projectRoot, 'package.json'))
    assert.equal(projectPackage.dependencies['cordis-app'], `^${FRAMEWORK_VERSION}`)
    assert.equal(projectPackage.dependencies.react, '^19.0.0')
    assert.equal(projectPackage.dependencies['react-dom'], '^19.0.0')
    const appJson = readJson(join(projectRoot, 'app.json'))
    assert.equal(appJson.name, 'demo')
    assert.deepEqual(appJson.plugins, [])
    assert.equal(appJson.ui.pages, true)

    // 2. 安装插件包：测试密钥 + 本地归档，完全不经过 npm。
    let npmCalls = 0
    const installer = new PluginInstaller({
      projectRoot,
      frameworkVersion: FRAMEWORK_VERSION,
      source: new BundleInstallSource({
        userDataDir,
        frameworkVersion: FRAMEWORK_VERSION,
        publicKey: bundle.publicKey,
        appJsonPath: join(projectRoot, 'app.json'),
        readArchive: async () => readFileSync(bundlePath),
      }),
      run: async () => {
        npmCalls++
      },
    })
    const installed = await installer.install(bundlePath)
    assert.equal(npmCalls, 0, 'bundle 安装不得执行包管理器')
    assert.equal(installed.id, 'hello')
    assert.equal(installed.version, '1.0.0')
    assert.equal(installed.uiCompatibility, 'full')
    assert.equal(existsSync(join(pluginRoot, 'plugin.json')), true)
    assert.equal(existsSync(join(pluginRoot, 'client.js')), true)
    const installedIndex = readJson(join(userDataDir, 'installed.json'))
    assert.equal(installedIndex.plugins.hello.hash, bundle.manifest.hash)

    // 项目事实文件不因 bundle 安装而改变；也不再产生公共 app.lock。
    assert.deepEqual(readJson(join(projectRoot, 'package.json')), projectPackage)
    assert.deepEqual(readJson(join(projectRoot, 'app.json')), appJson)
    assert.equal(existsSync(join(projectRoot, 'app.lock')), false)
    assert.equal(existsSync(join(projectRoot, '.cordis', 'install-journal.json')), false)

    // 3. 启动 worker，从清单里发现插件，并验证服务端路由已被挂载。
    const first = await startPackagedWorker(projectRoot, userDataDir, bundle.publicKey)
    try {
      assert.equal(first.handle.sourceKind, 'bundle')
      const manifest = await fetchManifest(first.base, first.token)
      assert.equal(manifest.uiContractVersion, 1)
      const entry = manifest.plugins.hello
      assert.ok(entry, '清单必须包含已安装的插件')
      assert.deepEqual(entry.ui, PLUGIN_UI)
      assert.equal(entry.files.length, 1)

      const api = await fetch(`${first.base}/api/plugin-hello`, {
        headers: { authorization: `Bearer ${first.token}` },
      })
      assert.equal(api.status, 200)
      assert.deepEqual(await api.json(), { from: 'bundle' })
    } finally {
      await first.handle.close()
    }

    // 4. 新开 worker：拉取客户端源码，装进前端运行时，再用 SSR 渲染项目 body。
    const second = await startPackagedWorker(projectRoot, userDataDir, bundle.publicKey)
    try {
      const manifest = await fetchManifest(second.base, second.token)
      const entry = manifest.plugins.hello!
      const clientRes = await fetch(`${second.base}${entry.files[0]}`, {
        headers: { authorization: `Bearer ${second.token}` },
      })
      assert.equal(clientRes.status, 200)
      const clientSource = await clientRes.text()

      const runtime = new ClientRuntime({ token: second.token })
      const loaded = await runtime.loadPlugin({
        ...entry,
        files: [`data:text/javascript,${encodeURIComponent(clientSource)}`],
      })
      assert.equal(loaded.error, undefined)

      const html = renderBody(runtime)
      assert.match(html, /来自签名插件包的页面/)
      assert.match(html, /来自插件包的插槽/)
      assert.match(html, /插件设置面板/)
      assert.equal(runtime.registry.listMenu('activity').length, 1)
    } finally {
      await second.handle.close()
    }

    // 5. 卸载：磁盘状态回到安装前，且没有残留事务日志。
    const removed = await installer.remove('hello')
    assert.equal(removed.id, 'hello')
    assert.equal(existsSync(pluginRoot), false)
    assert.equal(existsSync(join(userDataDir, 'plugins', 'hello@1.0.0')), false)
    assert.equal(readJson(join(userDataDir, 'installed.json')).plugins.hello, undefined)
    assert.equal(existsSync(join(projectRoot, '.cordis', 'install-journal.json')), false)

    // 6. 重启后清单里没有插件；用同一份 body 渲染，插件页面与插槽消失。
    const third = await startPackagedWorker(projectRoot, userDataDir, bundle.publicKey)
    try {
      const manifest = await fetchManifest(third.base, third.token)
      assert.equal(manifest.plugins.hello, undefined)
      const html = renderBody(new ClientRuntime({ token: third.token }))
      assert.doesNotMatch(html, /来自签名插件包的页面/)
      assert.doesNotMatch(html, /来自插件包的插槽/)
      assert.doesNotMatch(html, /插件设置面板/)
    } finally {
      await third.handle.close()
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('构建把 TSX 插件入口规范化为 .js，worker 按 JS 类型提供', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cordis-entry-js-'))
  const projectRoot = join(work, 'demo')
  const userDataDir = join(work, 'userdata')

  try {
    const io = {
      out: () => {},
      err: () => {},
      frameworkVersion: FRAMEWORK_VERSION,
    }
    assert.equal(
      await commandNew(parseArgs(['new', 'demo', '--project', projectRoot]), io),
      0,
    )
    mkdirSync(join(userDataDir, 'plugins'), { recursive: true })

    const pluginRoot = join(projectRoot, 'plugins', 'tsx-demo')
    mkdirSync(join(pluginRoot, 'src'), { recursive: true })
    const sourceManifest = {
      id: 'tsx-demo',
      displayName: 'TSX Demo',
      version: '1.0.0',
      client: 'src/client.tsx',
      server: 'src/server.ts',
      ui: { pages: true },
    }
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify(sourceManifest, null, 2) + '\n',
    )
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: 'cordis-tsx-demo',
        version: '1.0.0',
        type: 'module',
        peerDependencies: { 'cordis-app': `^${FRAMEWORK_VERSION}` },
      }),
    )
    writeFileSync(
      join(pluginRoot, 'src', 'client.tsx'),
      'export default function activate() {}\n',
    )
    writeFileSync(
      join(pluginRoot, 'src', 'server.ts'),
      `export const inject = ['router']
export function apply(ctx) {
  ctx.router.get('/api/tsx-demo', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ from: 'tsx' }))
  })
}
`,
    )

    const built = await buildProject({ projectRoot })

    // 构建产物：入口与清单都指向 .js；源清单保持不变。
    const builtPlugin = join(built.resourcesDir, 'plugins', 'tsx-demo')
    assert.ok(existsSync(join(builtPlugin, 'src', 'client.js')), '前端入口应产出 .js')
    assert.ok(existsSync(join(builtPlugin, 'src', 'server.js')), '服务端入口应产出 .js')
    assert.equal(readJson(join(builtPlugin, 'plugin.json')).client, 'src/client.js')
    assert.equal(readJson(join(builtPlugin, 'plugin.json')).server, 'src/server.js')
    assert.deepEqual(
      readJson(join(pluginRoot, 'plugin.json')),
      sourceManifest,
      '源目录的 plugin.json 不能被构建改写',
    )

    const { publicKey } = generateKeyPairSync('ed25519')
    const worker = await startPackagedWorker(
      projectRoot,
      userDataDir,
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      {
        resourcesDir: built.resourcesDir,
        serverEntry: built.serverEntry,
        appJson: built.appJson,
      },
    )
    try {
      await waitForHealth(worker.base)
      const headers = { authorization: `Bearer ${worker.token}` }

      const api = await fetch(`${worker.base}/api/tsx-demo`, { headers })
      assert.equal(api.status, 200, '改写后的服务端入口应被 worker 加载')
      assert.deepEqual(await api.json(), { from: 'tsx' })

      const entry = await fetch(`${worker.base}/__plugins/tsx-demo/src/client.js`)
      assert.equal(entry.status, 200, '产物清单指向的 .js 入口应可被 HTTP 取到')
      assert.equal(
        entry.headers.get('content-type'),
        'text/javascript; charset=utf-8',
        '静态服务必须按 JS 类型分发构建产物',
      )
      assert.match(await entry.text(), /activate/)
      assert.deepEqual(worker.handle.failures, [])
    } finally {
      await worker.handle.close()
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('打包形态删掉项目 node_modules 后，项目与本地插件路由仍可用', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cordis-self-contained-'))
  const projectRoot = join(work, 'demo')
  const userDataDir = join(work, 'userdata')
  const nodeModules = join(projectRoot, 'node_modules')
  const movedNodeModules = join(projectRoot, 'node_modules.off')
  let nodeModulesMoved = false

  mkdirSync(join(userDataDir, 'plugins'), { recursive: true })
  try {
    const io = {
      out: () => {},
      err: () => {},
      frameworkVersion: FRAMEWORK_VERSION,
    }
    assert.equal(
      await commandNew(parseArgs(['new', 'demo', '--project', projectRoot]), io),
      0,
    )

    const marker = writeProjectDependency(projectRoot, 'cordis-fake-dep')
    writeFileSync(
      join(projectRoot, 'server', 'index.js'),
      `import { marker } from 'cordis-fake-dep'
export default function apply(ctx) {
  ctx.router.get('/api/project-dependency', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ marker, from: 'project' }))
  })
}
`,
    )

    const pluginRoot = join(projectRoot, 'plugins', 'local-dep')
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        id: 'local-dep',
        displayName: 'Local Dependency',
        server: 'server.js',
      }),
    )
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: 'cordis-local-dep',
        version: '1.0.0',
        type: 'module',
        peerDependencies: { 'cordis-app': `^${FRAMEWORK_VERSION}` },
        dependencies: { 'cordis-fake-dep': '^1.0.0' },
      }),
    )
    writeFileSync(
      join(pluginRoot, 'server.js'),
      `import { marker } from 'cordis-fake-dep'
export const inject = ['router']

export function apply(ctx) {
  ctx.router.get('/api/local-plugin-dependency', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ marker, from: 'plugin' }))
  })
}
`,
    )

    const appJson = readJson(join(projectRoot, 'app.json'))
    appJson.plugins = ['local-dep']
    writeFileSync(join(projectRoot, 'app.json'), JSON.stringify(appJson, null, 2) + '\n')

    const built = await buildProject({ projectRoot })
    assert.equal(existsSync(join(built.outDir, 'node_modules')), false, 'dist 不能携带 node_modules')

    // 先改名再启动：产物若仍保留裸导入，Node 会在这里解析失败。
    renameSync(nodeModules, movedNodeModules)
    nodeModulesMoved = true

    const { publicKey } = generateKeyPairSync('ed25519')
    const worker = await startPackagedWorker(
      projectRoot,
      userDataDir,
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      {
        resourcesDir: built.resourcesDir,
        serverEntry: built.serverEntry,
        appJson: built.appJson,
      },
    )
    try {
      await waitForHealth(worker.base)
      const headers = { authorization: `Bearer ${worker.token}` }
      for (const [path, from] of [
        ['/api/project-dependency', 'project'],
        ['/api/local-plugin-dependency', 'plugin'],
      ] as const) {
        const res = await fetch(`${worker.base}${path}`, { headers })
        assert.equal(res.status, 200, `${from} 路由应在删除项目 node_modules 后仍可用`)
        assert.deepEqual(await res.json(), { marker, from })
      }
      assert.deepEqual(worker.handle.failures, [])
    } finally {
      await worker.handle.close()
    }
  } finally {
    if (nodeModulesMoved && existsSync(movedNodeModules)) {
      renameSync(movedNodeModules, nodeModules)
    }
    rmSync(work, { recursive: true, force: true })
  }
})

test('签名插件包在构建期自包含：删除源 node_modules 后安装、启动与路由仍可用', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cordis-signed-self-contained-'))
  const projectRoot = join(work, 'demo')
  const userDataDir = join(work, 'userdata')
  const pluginSource = join(work, 'plugin-source')
  const projectNodeModules = join(projectRoot, 'node_modules')
  const movedNodeModules = join(projectRoot, 'node_modules.off')
  const pluginMarker = 'SIGNED_PLUGIN_DEP_MARKER'
  let nodeModulesMoved = false
  let worker: Awaited<ReturnType<typeof startPackagedWorker>> | undefined

  try {
    const io = {
      out: () => {},
      err: () => {},
      frameworkVersion: FRAMEWORK_VERSION,
    }
    assert.equal(
      await commandNew(parseArgs(['new', 'demo', '--project', projectRoot]), io),
      0,
    )

    // 插件作者视角：依赖写在临时插件目录的 node_modules，源码直接按包名导入。
    mkdirSync(join(pluginSource, 'lib'), { recursive: true })
    writeFileSync(
      join(pluginSource, 'plugin.json'),
      JSON.stringify({
        id: 'plugin-dependency',
        displayName: 'Plugin Dependency',
        version: '1.0.0',
        server: 'lib/server.js',
      }),
    )
    writeFileSync(
      join(pluginSource, 'package.json'),
      JSON.stringify({
        name: 'cordis-plugin-dependency',
        version: '1.0.0',
        type: 'module',
        peerDependencies: { 'cordis-app': `^${FRAMEWORK_VERSION}` },
        dependencies: { 'cordis-plugin-dep': '^1.0.0' },
      }),
    )
    writeDependency(pluginSource, 'cordis-plugin-dep', pluginMarker)
    writeFileSync(
      join(pluginSource, 'server-entry.js'),
      `import { marker } from 'cordis-plugin-dep'
export const inject = ['router']

export function apply(ctx) {
  ctx.router.get('/api/plugin-dependency', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ marker, from: 'signed-plugin' }))
  })
}
`,
    )

    const serverSource = await buildPluginServer(
      pluginSource,
      'server-entry.js',
      'lib/server.js',
    )
    assert.match(serverSource, new RegExp(pluginMarker), '第三方依赖代码必须进入插件产物')
    assert.doesNotMatch(
      serverSource,
      /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']cordis-plugin-dep["']/,
      '构建后的插件服务端不得保留假依赖的裸导入',
    )

    // 构建完成后删掉源码依赖：打包、安装、运行都不再需要它。
    rmSync(join(pluginSource, 'node_modules'), { recursive: true, force: true })

    const bundle = buildBundle({
      id: 'plugin-dependency',
      displayName: 'Plugin Dependency',
      server: serverSource,
    })
    const bundlePath = join(work, 'plugin-dependency.cordis-plugin')
    writeFileSync(bundlePath, bundle.bytes)

    // 归档只含构建产物：解析 tar 条目，而不是只看文件系统。
    const archiveFiles = readTarGz(readFileSync(bundlePath))
    const archiveEntries = [...archiveFiles.keys()]
    assert.ok(archiveEntries.includes('server.js'), '归档必须包含服务端产物')
    assert.deepEqual(
      archiveEntries.filter((name) => name.split('/').includes('node_modules')),
      [],
      '归档不得包含 node_modules',
    )

    // 项目侧也放一个构建期依赖，证明 dist 与签名插件同时自包含。
    const projectMarker = writeDependency(projectRoot, 'cordis-fake-dep', 'PROJECT_DEP_MARKER')
    writeFileSync(
      join(projectRoot, 'server', 'index.js'),
      `import { marker } from 'cordis-fake-dep'
export default function apply(ctx) {
  ctx.router.get('/api/project-dependency', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ marker, from: 'project' }))
  })
}
`,
    )
    const built = await buildProject({ projectRoot })
    assert.equal(existsSync(join(built.outDir, 'node_modules')), false, 'dist 不能携带 node_modules')

    const installed = await new PluginInstaller({
      projectRoot,
      frameworkVersion: FRAMEWORK_VERSION,
      source: new BundleInstallSource({
        userDataDir,
        frameworkVersion: FRAMEWORK_VERSION,
        publicKey: bundle.publicKey,
        appJsonPath: join(projectRoot, 'app.json'),
        readArchive: async () => readFileSync(bundlePath),
      }),
      run: async () => {
        throw new Error('签名插件安装不得执行包管理器')
      },
    }).install(bundlePath)
    assert.equal(installed.id, 'plugin-dependency')
    assert.equal(installed.version, '1.0.0')
    assert.equal(
      existsSync(join(userDataDir, 'plugins', 'plugin-dependency@1.0.0', 'server.js')),
      true,
    )

    // 启动前改名：项目 server 与插件 server 若还依赖 node_modules，这里会失败。
    renameSync(projectNodeModules, movedNodeModules)
    nodeModulesMoved = true

    worker = await startPackagedWorker(projectRoot, userDataDir, bundle.publicKey, {
      resourcesDir: built.resourcesDir,
      serverEntry: built.serverEntry,
      appJson: built.appJson,
    })
    await waitForHealth(worker.base)

    const headers = { authorization: `Bearer ${worker.token}` }
    for (const [path, expected] of [
      ['/api/project-dependency', { marker: projectMarker, from: 'project' }],
      ['/api/plugin-dependency', { marker: pluginMarker, from: 'signed-plugin' }],
    ] as const) {
      const res = await fetch(`${worker.base}${path}`, { headers })
      assert.equal(res.status, 200, `${path} 应在删除 node_modules 后仍可用`)
      assert.deepEqual(await res.json(), expected)
    }
    assert.deepEqual(worker.handle.failures, [])
  } finally {
    await worker?.handle.close()
    if (nodeModulesMoved && existsSync(movedNodeModules)) {
      renameSync(movedNodeModules, projectNodeModules)
    }
    rmSync(work, { recursive: true, force: true })
  }
})

test('npm 安装的插件经 build 进入打包形态：删除项目 node_modules 后仍能加载', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cordis-installed-plugin-'))
  const projectRoot = join(work, 'demo')
  const userDataDir = join(work, 'userdata')
  const nodeModules = join(projectRoot, 'node_modules')
  const movedNodeModules = join(projectRoot, 'node_modules.off')
  const marker = 'INSTALLED_PLUGIN_BUNDLE_MARKER'
  let nodeModulesMoved = false

  mkdirSync(join(userDataDir, 'plugins'), { recursive: true })
  try {
    const io = {
      out: () => {},
      err: () => {},
      frameworkVersion: FRAMEWORK_VERSION,
    }
    assert.equal(
      await commandNew(parseArgs(['new', 'demo', '--project', projectRoot]), io),
      0,
    )

    // 模拟 `add file:.../plugin` 之后的磁盘状态：插件包本身与它的依赖
    // 都位于项目 node_modules 里，插件源码不在项目 plugins/ 下。
    writeDependency(projectRoot, 'cordis-fake-dep', marker)
    const pluginRoot = join(nodeModules, 'cordis-plugin-installed')
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: 'cordis-plugin-installed',
        version: '1.0.0',
        type: 'module',
        peerDependencies: { 'cordis-app': `^${FRAMEWORK_VERSION}` },
        dependencies: { 'cordis-fake-dep': '^1.0.0' },
      }),
    )
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({
        id: 'installed',
        displayName: 'Installed Plugin',
        server: 'server.js',
      }),
    )
    writeFileSync(
      join(pluginRoot, 'server-source.js'),
      `import { marker } from 'cordis-fake-dep'
export const inject = ['router']

export function apply(ctx) {
  ctx.router.get('/api/installed-plugin', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ marker, from: 'installed' }))
  })
}
`,
    )
    // npm 上分发的插件带的是预构建入口，这里按插件作者的真实流程先构建一次。
    await buildPluginServer(pluginRoot, 'server-source.js', 'server.js')
    rmSync(join(pluginRoot, 'server-source.js'))

    const appJson = readJson(join(projectRoot, 'app.json'))
    appJson.plugins = ['installed']
    writeFileSync(join(projectRoot, 'app.json'), JSON.stringify(appJson, null, 2) + '\n')

    const built = await buildProject({ projectRoot })
    const pluginEntry = join(built.resourcesDir, 'plugins', 'installed', 'server.js')
    assert.equal(existsSync(pluginEntry), true, '依赖根插件应被打进 resources/plugins')
    const source = readFileSync(pluginEntry, 'utf8')
    assert.match(source, new RegExp(marker), '插件产物应自包含其依赖')
    assert.doesNotMatch(source, /from\s*['"]cordis-fake-dep['"]/, '插件产物不应保留裸导入')
    assert.equal(existsSync(join(built.outDir, 'node_modules')), false, 'dist 不能携带 node_modules')

    // 先改名再启动：产物若仍依赖项目 node_modules，这里会直接失败。
    renameSync(nodeModules, movedNodeModules)
    nodeModulesMoved = true

    const { publicKey } = generateKeyPairSync('ed25519')
    const worker = await startPackagedWorker(
      projectRoot,
      userDataDir,
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      {
        resourcesDir: built.resourcesDir,
        serverEntry: built.serverEntry,
        appJson: built.appJson,
      },
    )
    try {
      await waitForHealth(worker.base)
      assert.deepEqual(worker.handle.failures, [], '打包形态不应有插件加载失败')
      const res = await fetch(`${worker.base}/api/installed-plugin`, {
        headers: { authorization: `Bearer ${worker.token}` },
      })
      assert.equal(res.status, 200, 'npm 安装的插件路由应在删除项目 node_modules 后仍可用')
      assert.deepEqual(await res.json(), { marker, from: 'installed' })
    } finally {
      await worker.handle.close()
    }
  } finally {
    if (nodeModulesMoved && existsSync(movedNodeModules)) {
      renameSync(movedNodeModules, nodeModules)
    }
    rmSync(work, { recursive: true, force: true })
  }
})

test('项目 body 示例保留全部 UI 出口，并能构建出可分发布局', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cordis-body-'))
  const projectRoot = join(work, 'demo')
  try {
    const io = {
      out: () => {},
      err: () => {},
      frameworkVersion: FRAMEWORK_VERSION,
    }
    assert.equal(
      await commandNew(parseArgs(['new', 'demo', '--project', projectRoot]), io),
      0,
    )

    // 脚手架原样就应该能构建：模板同时使用 Home、usePath 与 DefaultBody，
    // 不需要先替换成示例文件。
    const scaffold = await buildProject({ projectRoot })
    assert.equal(existsSync(join(scaffold.resourcesDir, 'ui', 'index.html')), true)

    // 示例的唯一要求是能作为 src/body.tsx 直接使用：它只依赖脚手架已生成的
    // pages/Home.tsx 与框架的公开出口。
    const exampleBody = fileURLToPath(
      new URL('../../../examples/full-body/body.tsx', import.meta.url),
    )
    writeFileSync(join(projectRoot, 'src', 'body.tsx'), readFileSync(exampleBody))

    const result = await buildProject({ projectRoot })
    assert.equal(existsSync(join(result.resourcesDir, 'ui', 'index.html')), true)
    assert.equal(existsSync(result.serverEntry), true)
    assert.deepEqual(
      readJson(join(result.outDir, 'app.json')),
      readJson(join(projectRoot, 'app.json')),
    )
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('项目本地插件根能发现 examples/hello-plugin', () => {
  const exampleRoot = fileURLToPath(
    new URL('../../../examples/hello-plugin', import.meta.url),
  )
  const work = mkdtempSync(join(tmpdir(), 'cordis-hello-scan-'))
  try {
    const pluginRoot = join(work, 'plugins', 'hello')
    mkdirSync(pluginRoot, { recursive: true })
    for (const file of ['plugin.json', 'package.json']) {
      copyFileSync(join(exampleRoot, file), join(pluginRoot, file))
    }

    const scan = scanPluginRoots([{ kind: 'local', dir: join(work, 'plugins') }])
    assert.deepEqual(scan.failures, [])
    assert.equal(scan.plugins.length, 1)
    assert.equal(scan.plugins[0]?.id, 'hello')
    assert.equal(scan.plugins[0]?.rootKind, 'local')
    assert.deepEqual(scan.plugins[0]?.manifest.ui, { pages: true })
    assert.equal(scan.roots.get('hello'), pluginRoot)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

/** 项目模式 worker：CLI 生命周期动作之后，用它验证 HTTP 看到同一份状态。 */
async function startProjectWorker(
  projectRoot: string,
): Promise<{ handle: WorkerHandle; token: string; base: string }> {
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({ port, token, projectRoot })
  return { handle, token, base: `http://127.0.0.1:${port}` }
}

test('CLI 与 HTTP 共用生命周期：remove 后插件从清单消失，enable 后恢复', async () => {
  const work = mkdtempSync(join(tmpdir(), 'cordis-cli-lifecycle-'))
  const projectRoot = join(work, 'demo')
  const pluginRoot = join(projectRoot, 'plugins', 'local-demo')

  try {
    const io = {
      out: () => {},
      err: () => {},
      frameworkVersion: FRAMEWORK_VERSION,
    }
    assert.equal(
      await commandNew(parseArgs(['new', 'demo', '--project', projectRoot]), io),
      0,
    )

    // 项目本地插件：卸载只写状态，文件保留。
    mkdirSync(pluginRoot, { recursive: true })
    writeFileSync(
      join(pluginRoot, 'plugin.json'),
      JSON.stringify({ id: 'local-demo', displayName: 'Local Demo', server: 'server.js' }),
    )
    writeFileSync(
      join(pluginRoot, 'package.json'),
      JSON.stringify({
        name: 'cordis-local-demo',
        version: '1.0.0',
        type: 'module',
        peerDependencies: { 'cordis-app': `^${FRAMEWORK_VERSION}` },
      }),
    )
    writeFileSync(
      join(pluginRoot, 'server.js'),
      `export const inject = ['router']
export function apply(ctx) {
  ctx.router.get('/api/local-demo', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ from: 'local-demo' }))
  })
}
`,
    )
    const appJson = readJson(join(projectRoot, 'app.json'))
    appJson.plugins = ['local-demo']
    writeFileSync(join(projectRoot, 'app.json'), JSON.stringify(appJson, null, 2) + '\n')

    let packageManagerCalls = 0
    const commandIO = {
      ...io,
      async packageManager() {
        packageManagerCalls++
      },
    }

    // 卸载：与设置页同一套语义，不跑包管理器，不删文件。
    assert.equal(
      await commandRemove(parseArgs(['remove', 'local-demo', '--project', projectRoot]), commandIO),
      0,
    )
    assert.equal(packageManagerCalls, 0, '项目本地插件卸载不得跑包管理器')
    assert.equal(existsSync(join(pluginRoot, 'plugin.json')), true, '逻辑卸载不删文件')
    assert.deepEqual(readJson(join(projectRoot, 'app.json')).uninstalledPlugins, ['local-demo'])

    // worker 只看到启用视图：路由未挂载，/api/plugins 标为已卸载。
    const first = await startProjectWorker(projectRoot)
    try {
      const route = await fetch(`${first.base}/api/local-demo`, {
        headers: { authorization: `Bearer ${first.token}` },
      })
      assert.equal(route.status, 404, '已卸载插件不得挂载路由')
      const res = await fetch(`${first.base}/api/plugins`, {
        headers: { authorization: `Bearer ${first.token}` },
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        plugins: Array<{ id: string; enabled: boolean; origin: string }>
        uninstalled: unknown[]
      }
      const row = body.plugins.find((entry) => entry.id === 'local-demo')
      assert.ok(row, '完整扫描视图仍应包含物理存在的已卸载插件')
      assert.equal(row.enabled, false)
      assert.equal(row.origin, 'local')
      assert.equal(body.uninstalled.length, 0, '物理存在的插件不重复进已卸载列表')
    } finally {
      await first.handle.close()
    }

    // 启用：只清状态，插件回到启用顺序末尾。
    assert.equal(
      await commandEnable(parseArgs(['enable', 'local-demo', '--project', projectRoot]), commandIO),
      0,
    )
    assert.equal(packageManagerCalls, 0, '恢复项目本地插件不得跑包管理器')
    const appAfterEnable = readJson(join(projectRoot, 'app.json'))
    assert.deepEqual(appAfterEnable.uninstalledPlugins, [])
    assert.deepEqual(appAfterEnable.plugins, ['local-demo'])

    const second = await startProjectWorker(projectRoot)
    try {
      const res = await fetch(`${second.base}/api/plugins`, {
        headers: { authorization: `Bearer ${second.token}` },
      })
      assert.equal(res.status, 200)
      const body = (await res.json()) as {
        plugins: Array<{ id: string; enabled: boolean }>
      }
      assert.equal(body.plugins.find((entry) => entry.id === 'local-demo')?.enabled, true)
      const api = await fetch(`${second.base}/api/local-demo`, {
        headers: { authorization: `Bearer ${second.token}` },
      })
      assert.equal(api.status, 200)
      assert.deepEqual(await api.json(), { from: 'local-demo' })
    } finally {
      await second.handle.close()
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
