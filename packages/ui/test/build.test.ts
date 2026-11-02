/**
 * 项目构建的对外契约：目录布局、body 替换、共享模块与幂等。
 *
 * 断言只绑定 `build` 文档承诺的文件，不绑定 Vite 的内部文件名。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SHARED_MODULE_TABLE, WS_PATH } from '@cordis-app/protocol'
import {
  buildProject,
  createProjectDevServer,
  createProjectWatcher,
  swapIntoPlace,
} from '../src/build/index.ts'

const here = dirname(fileURLToPath(import.meta.url))
// test/ → ui/ → packages/ → 仓库根
const repo = join(here, '..', '..', '..')
const runtimeNodeModules = join(repo, 'packages', 'runtime', 'node_modules')

/** 取一个当前空闲的端口，避免测试与开发者本机的 5173 冲突。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'cordis-build-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'server'), { recursive: true })
  mkdirSync(join(root, 'plugins', 'demo'), { recursive: true })

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-app', version: '0.1.0', private: true, type: 'module' }),
  )
  writeFileSync(
    join(root, 'app.json'),
    JSON.stringify({ name: 'demo-app', version: '0.1.0', plugins: ['demo'] }),
  )
  writeFileSync(
    join(root, 'src', 'body.tsx'),
    'export default function Body() { return null }\n',
  )
  writeFileSync(
    join(root, 'server', 'index.ts'),
    'const answer: number = 42\nexport default function apply() { return answer }\n',
  )
  writeFileSync(
    join(root, 'plugins', 'demo', 'plugin.json'),
    JSON.stringify({ id: 'demo', displayName: 'Demo', client: 'client.js', server: 'server.js' }),
  )
  writeFileSync(
    join(root, 'plugins', 'demo', 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '0.0.1', peerDependencies: { 'cordis-app': '*' } }),
  )
  writeFileSync(join(root, 'plugins', 'demo', 'client.js'), 'export const marker = "demo"\n')
  writeFileSync(join(root, 'plugins', 'demo', 'server.js'), 'export default function apply() {}\n')
  return root
}

/** 在临时项目的 node_modules 里放一个假 npm 依赖。 */
function writeDependency(
  root: string,
  name: string,
  options: {
    type?: 'module' | 'commonjs'
    main?: string
    files: Record<string, string>
  },
): void {
  const dir = join(root, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: '1.0.0',
      type: options.type ?? 'module',
      main: options.main ?? 'index.js',
    }),
  )
  for (const [file, contents] of Object.entries(options.files)) {
    const target = join(dir, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

/** 递归找出目录下所有的 node_modules，用来证明发布产物没有携带依赖树。 */
function findNodeModules(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.name === 'node_modules') {
      found.push(full)
      continue
    }
    if (entry.isDirectory()) found.push(...findNodeModules(full))
  }
  return found
}

function assertNoBareImport(source: string, specifier: string, label: string): void {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `(?:\\bfrom\\s+|\\bimport\\s+|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*)['"]${escaped}['"]`,
  )
  assert.doesNotMatch(source, pattern, `${label} 不应保留 ${specifier} 的裸导入`)
}

test('build 产出发布布局，body 与 server 都来自项目源码', async () => {
  const root = createProject()
  const result = await buildProject({ projectRoot: root })

  assert.equal(result.projectRoot, root)
  assert.ok(existsSync(join(result.outDir, 'app.json')))
  assert.ok(existsSync(join(result.outDir, 'package.json')))
  assert.ok(existsSync(join(result.resourcesDir, 'ui', 'index.html')))
  assert.ok(existsSync(result.serverEntry))

  // 共享模块清单只有协议一份；构建必须逐个落盘。
  for (const definition of Object.values(SHARED_MODULE_TABLE)) {
    assert.ok(
      existsSync(join(result.resourcesDir, 'shared', definition.file)),
      `缺少共享模块 ${definition.file}`,
    )
  }

  assert.ok(existsSync(join(result.resourcesDir, 'plugins', 'demo', 'plugin.json')))
  assert.ok(existsSync(join(result.resourcesDir, 'plugins', 'demo', 'client.js')))
  assert.ok(existsSync(join(result.resourcesDir, 'plugins', 'demo', 'server.js')))

  const server = readFileSync(result.serverEntry, 'utf8')
  assert.match(server, /apply/, '项目 server 入口应被打包成可 import 的 ESM')
  assert.doesNotMatch(server, /interface|: number/, 'TypeScript 类型应被剥离')
})

test('构建把项目 server 与本地插件的第三方依赖打进产物，dist 不含 node_modules', async () => {
  const root = createProject()
  writeDependency(root, 'fake-dep', {
    files: { 'index.js': "export const marker = 'SELF_CONTAINED_MARKER'\n" },
  })
  writeFileSync(
    join(root, 'server', 'index.ts'),
    "import { marker } from 'fake-dep'\nexport default function apply() { return marker }\n",
  )
  writeFileSync(
    join(root, 'plugins', 'demo', 'server.js'),
    "import { marker } from 'fake-dep'\nexport default function apply() { return marker }\n",
  )

  const result = await buildProject({ projectRoot: root })
  const pluginEntry = join(result.resourcesDir, 'plugins', 'demo', 'server.js')

  const serverSource = readFileSync(result.serverEntry, 'utf8')
  assert.match(serverSource, /SELF_CONTAINED_MARKER/, '项目 server 产物应包含依赖代码')
  assertNoBareImport(serverSource, 'fake-dep', '项目 server 产物')

  const pluginSource = readFileSync(pluginEntry, 'utf8')
  assert.match(pluginSource, /SELF_CONTAINED_MARKER/, '本地插件 server 产物应包含依赖代码')
  assertNoBareImport(pluginSource, 'fake-dep', '本地插件产物')

  assert.deepEqual(findNodeModules(result.outDir), [], 'dist 不能携带 node_modules')

  // 发布产物搬到没有项目 node_modules 的地方也必须能加载。
  renameSync(join(root, 'node_modules'), join(root, 'node_modules.off'))
  const server = await import(pathToFileURL(result.serverEntry).href)
  assert.equal(server.default(), 'SELF_CONTAINED_MARKER')
  const plugin = await import(pathToFileURL(pluginEntry).href)
  assert.equal(plugin.default(), 'SELF_CONTAINED_MARKER')
})

test('服务端值导入 @cordis-app 内部包时构建失败，import type 通过', async () => {
  const valueRoot = createProject()
  writeFileSync(
    join(valueRoot, 'server', 'index.ts'),
    "import { WS_PATH } from '@cordis-app/protocol'\n" +
      'export default function apply() { return WS_PATH }\n',
  )

  await assert.rejects(
    () => buildProject({ projectRoot: valueRoot }),
    (error: Error) => {
      assert.match(error.message, /@cordis-app\/protocol/, '错误应指出违规说明符')
      assert.match(error.message, /server\/index\.ts/, '错误应指出导入方文件')
      assert.match(error.message, /import type/, '错误应给出修复方向')
      return true
    },
  )

  const typeRoot = createProject()
  writeFileSync(
    join(typeRoot, 'server', 'index.ts'),
    "import type { PluginManifest } from '@cordis-app/protocol'\n" +
      'export default function apply(_manifest?: PluginManifest) {}\n',
  )
  const result = await buildProject({ projectRoot: typeRoot })
  assert.ok(existsSync(result.serverEntry), 'import type 在转译前被擦除，不应触发内部包边界')
})

test('客户端值导入 @cordis-app 内部包时构建失败，import type 通过', async () => {
  const valueRoot = createProject()
  writeFileSync(
    join(valueRoot, 'plugins', 'demo', 'plugin.json'),
    JSON.stringify({ id: 'demo', displayName: 'Demo', client: 'client.ts' }),
  )
  writeFileSync(
    join(valueRoot, 'plugins', 'demo', 'client.ts'),
    "import { WS_PATH } from '@cordis-app/protocol'\nexport const marker = WS_PATH\n",
  )

  await assert.rejects(
    () => buildProject({ projectRoot: valueRoot }),
    (error: Error) => {
      assert.match(error.message, /@cordis-app\/protocol/, '错误应指出违规说明符')
      assert.match(error.message, /client\.ts/, '错误应指出导入方文件')
      assert.match(error.message, /import type/, '错误应给出修复方向')
      return true
    },
  )

  const typeRoot = createProject()
  writeFileSync(
    join(typeRoot, 'plugins', 'demo', 'plugin.json'),
    JSON.stringify({ id: 'demo', displayName: 'Demo', client: 'client.ts' }),
  )
  writeFileSync(
    join(typeRoot, 'plugins', 'demo', 'client.ts'),
    "import type { PluginManifest } from '@cordis-app/protocol'\n" +
      'export const manifest: PluginManifest | undefined = undefined\n',
  )
  const result = await buildProject({ projectRoot: typeRoot })
  assert.ok(
    existsSync(join(result.resourcesDir, 'plugins', 'demo', 'client.ts')),
    'import type 在转译前被擦除，不应触发客户端内部包边界',
  )
})

test('CJS 依赖里的动态 require 在 ESM 产物中可用', async () => {
  const root = createProject()
  writeDependency(root, 'dynamic-cjs', {
    type: 'commonjs',
    main: 'index.cjs',
    files: {
      'index.cjs':
        "const builtin = ['node', 'path'].join(':')\n" +
        'module.exports = function resolveFile() {\n' +
        "  return require(builtin).basename('/tmp/example/hello.txt')\n" +
        '}\n',
    },
  })
  writeFileSync(
    join(root, 'server', 'index.ts'),
    "import resolveFile from 'dynamic-cjs'\n" +
      'export default function apply() { return resolveFile() }\n',
  )

  const result = await buildProject({ projectRoot: root })
  const built = await import(pathToFileURL(result.serverEntry).href)
  assert.equal(built.default(), 'hello.txt', 'createRequire banner 必须让动态 require 在 ESM 里工作')
})

test('ws 的服务端入口构建后可用，可选原生依赖不留在产物里', async () => {
  const root = createProject()
  // 模拟插件作者普通安装的 npm 依赖；ws 由 @cordis-app/runtime 声明。
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  cpSync(join(runtimeNodeModules, 'ws'), join(root, 'node_modules', 'ws'), {
    recursive: true,
    dereference: true,
  })
  writeFileSync(
    join(root, 'server', 'index.ts'),
    "import * as bufferutil from 'bufferutil'\n" +
      "import * as utf8 from 'utf-8-validate'\n" +
      "import { WebSocket } from 'ws'\n" +
      'export default function apply() {\n' +
      '  return {\n' +
      '    keys: [...Object.keys(bufferutil), ...Object.keys(utf8)],\n' +
      "    hasWebSocket: typeof WebSocket === 'function',\n" +
      '    noBufferUtil: process.env.WS_NO_BUFFER_UTIL,\n' +
      '    noUtf8: process.env.WS_NO_UTF_8_VALIDATE,\n' +
      '  }\n' +
      '}\n',
  )

  const result = await buildProject({ projectRoot: root })
  const source = readFileSync(result.serverEntry, 'utf8')
  assertNoBareImport(source, 'bufferutil', '服务端产物')
  assertNoBareImport(source, 'utf-8-validate', '服务端产物')

  const built = await import(pathToFileURL(result.serverEntry).href)
  assert.deepEqual(built.default(), {
    keys: [],
    hasWebSocket: true,
    noBufferUtil: 'true',
    noUtf8: 'true',
  })
})

test('dev watcher 使用同一预设，.cordis/dev 产物自包含', async () => {
  const root = createProject()
  writeDependency(root, 'fake-dep', {
    files: { 'index.js': "export const marker = 'DEV_MARKER'\n" },
  })
  writeFileSync(
    join(root, 'server', 'index.ts'),
    "import { marker } from 'fake-dep'\nexport default function apply() { return marker }\n",
  )
  writeFileSync(
    join(root, 'plugins', 'demo', 'server.js'),
    "import { marker } from 'fake-dep'\nexport default function apply() { return marker }\n",
  )

  const watcher = await createProjectWatcher({ projectRoot: root })
  try {
    const serverSource = readFileSync(watcher.serverEntry, 'utf8')
    assert.match(serverSource, /DEV_MARKER/, 'dev server 产物应包含依赖代码')
    assertNoBareImport(serverSource, 'fake-dep', 'dev server 产物')

    const pluginSource = readFileSync(
      join(watcher.localPluginsDir, 'demo', 'server.js'),
      'utf8',
    )
    assert.match(pluginSource, /DEV_MARKER/, 'dev 本地插件产物应包含依赖代码')
    assertNoBareImport(pluginSource, 'fake-dep', 'dev 本地插件产物')

    assert.deepEqual(findNodeModules(watcher.devRoot), [], '.cordis/dev 不能携带 node_modules')
  } finally {
    await watcher.close()
  }
})

test('dev 代理的 WebSocket 路径与前端连接路径一致', async () => {
  // 通过公共入口 createProjectDevServer 观察代理配置；devProxyConfig 本身
  // 是实现细节，不再单独导出。
  const root = mkdtempSync(join(tmpdir(), 'cordis-dev-proxy-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'body.tsx'), 'export default function Body() { return null }\n')

  const dev = await createProjectDevServer({
    projectRoot: root,
    port: await freePort(),
    strictPort: true,
    worker: { port: 9000, token: 'test-token' },
  })
  try {
    const proxy = dev.server.config.server.proxy as Record<string, { ws?: boolean }>

    assert.deepEqual(
      Object.keys(proxy).sort(),
      ['/api', '/__health', '/__plugins', WS_PATH].sort(),
      'WebSocket 必须代理到 WS_PATH，而不是另一条字面量路径',
    )
    assert.equal(proxy[WS_PATH]?.ws, true, `${WS_PATH} 必须启用 ws 代理`)
    assert.equal(proxy['/api']?.ws, false)
    assert.equal(proxy['/ws'], undefined, '不保留 /ws 别名')
  } finally {
    await dev.close()
  }
})

test('产物切换失败时把旧目录移回原位，而不是丢掉新旧两份', () => {
  const calls: Array<[string, string]> = []
  let renames = 0
  let removed = false

  assert.throws(
    () =>
      swapIntoPlace('/project/dist.tmp', '/project/dist', {
        existsSync: () => true,
        renameSync(from, to) {
          calls.push([from, to])
          renames += 1
          // 第一次：旧产物 → 备份；第二次：staging → outDir 失败。
          if (renames === 2) throw new Error('rename 失败')
        },
        rmSync() {
          removed = true
        },
      }),
    /rename 失败/,
  )

  assert.equal(calls.length, 3, '旧目录移出、切换失败、旧目录移回')
  assert.equal(calls[0]![0], '/project/dist')
  assert.match(calls[0]![1], /^\/project\/dist\.old-/)
  assert.deepEqual(calls[2]!, [calls[0]![1], '/project/dist'], '失败后必须把备份移回原位')
  assert.equal(removed, false, '切换失败时不能删除旧产物')
})

test('重复 build 幂等，不残留上一次的文件', async () => {
  const root = createProject()
  const first = await buildProject({ projectRoot: root })
  const stale = join(first.resourcesDir, 'ui', 'stale.txt')
  writeFileSync(stale, 'stale')

  const second = await buildProject({ projectRoot: root })
  assert.equal(second.outDir, first.outDir)
  assert.equal(existsSync(stale), false)
  assert.ok(existsSync(join(second.resourcesDir, 'ui', 'index.html')))
})

test('缺少 body 时构建失败，且不留下可运行目录', async () => {
  const root = createProject()
  const { rmSync } = await import('node:fs')
  rmSync(join(root, 'src', 'body.tsx'))

  await assert.rejects(() => buildProject({ projectRoot: root }), /body/)
  assert.equal(existsSync(join(root, 'dist')), false)
})
