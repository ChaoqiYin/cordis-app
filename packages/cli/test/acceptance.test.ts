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
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
  scanPluginRoots,
  startWorker,
} from '@cordis-app/runtime'
import type { BundleManifest, WorkerHandle } from '@cordis-app/runtime'
import { commandNew, parseArgs } from '../lib/index.js'

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

/** 用一次性 Ed25519 密钥构造一个合法的签名插件包。 */
function buildBundle(): TestBundle {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const files = new Map<string, Uint8Array>()
  files.set(
    'plugin.json',
    Buffer.from(
      JSON.stringify(
        {
          id: 'hello',
          displayName: 'Hello',
          description: '验收测试用的假插件',
          version: '1.0.0',
          server: 'server.js',
          client: 'client.js',
          ui: PLUGIN_UI,
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
          name: 'cordis-plugin-hello',
          version: '1.0.0',
          type: 'module',
          peerDependencies: { 'cordis-app': '^1.0.0' },
        },
        null,
        2,
      ),
    ),
  )
  files.set('server.js', Buffer.from(PLUGIN_SERVER))
  files.set('client.js', Buffer.from(PLUGIN_CLIENT))

  const hash = computeBundleHash(files)
  const signature = sign(
    null,
    bundleSignaturePayload({
      id: 'hello',
      version: '1.0.0',
      hash,
      peer: { 'cordis-app': '^1.0.0' },
      ui: PLUGIN_UI,
    }),
    privateKey,
  ).toString('base64')
  const manifest: BundleManifest = {
    id: 'hello',
    version: '1.0.0',
    hash,
    signature,
    algorithm: 'ed25519',
    peer: { 'cordis-app': '^1.0.0' },
    ui: PLUGIN_UI,
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
  })
  return { handle, token, base: `http://127.0.0.1:${port}` }
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
