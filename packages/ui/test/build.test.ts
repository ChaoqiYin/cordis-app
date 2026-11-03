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
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build as esbuild } from 'esbuild'
import { serverPreset } from '@cordis-app/preset'
import { SHARED_MODULE_TABLE, PLUGIN_SOURCE_BUILT_PATH, WS_PATH } from '@cordis-app/protocol'
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

interface InstalledPluginOptions {
  /** 插件 id；缺省取包名最后一段。 */
  id?: string
  /** 覆盖默认文件内容，用来注入依赖或 marker。 */
  files?: Record<string, string>
  /**
   * 以符号链接安装，模拟 npm 的 `file:` 依赖。
   *
   * 源目录放在 `linked-plugins/`，与 `node_modules` 分开，链接目标才真实存在。
   */
  linked?: boolean
}

function writePluginFiles(
  dir: string,
  name: string,
  id: string,
  files: Record<string, string>,
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', type: 'module' }),
  )
  const defaults: Record<string, string> = {
    'plugin.json': JSON.stringify({
      id,
      displayName: id,
      client: 'client.js',
      server: 'server.js',
    }),
    'client.js': `export const marker = '${id}-client'\n`,
    'server.js': `export default function apply() { return '${id}-server' }\n`,
  }
  for (const [file, contents] of Object.entries({ ...defaults, ...files })) {
    const target = join(dir, file)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents)
  }
}

/** 在临时项目的 node_modules 里放一个已安装的插件包。 */
function writeInstalledPlugin(
  root: string,
  name: string,
  options: InstalledPluginOptions = {},
): string {
  const id = options.id ?? basename(name)
  const files = options.files ?? {}
  if (!options.linked) {
    const dir = join(root, 'node_modules', name)
    writePluginFiles(dir, name, id, files)
    return dir
  }

  const source = join(root, 'linked-plugins', name.replace(/[\\/]/g, '__'))
  writePluginFiles(source, name, id, files)
  const target = join(root, 'node_modules', name)
  mkdirSync(dirname(target), { recursive: true })
  symlinkSync(source, target, 'dir')
  return target
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

test('server 目录的多入口各自产出到 dist/server/<name>.js', async () => {
  const root = createProject()
  writeFileSync(
    join(root, 'server', 'scan-worker.ts'),
    "export default function scan() { return 'SCAN_WORKER' }\n",
  )
  // 识别规则：只认脚本扩展名，不递归子目录，忽略 .d.ts。
  mkdirSync(join(root, 'server', 'nested'), { recursive: true })
  writeFileSync(join(root, 'server', 'nested', 'deep.ts'), 'export default 1\n')
  writeFileSync(join(root, 'server', 'scan-worker.d.ts'), 'export declare const x: number\n')
  writeFileSync(join(root, 'server', 'notes.txt'), 'not an entry\n')

  const result = await buildProject({ projectRoot: root })
  const workerEntry = join(result.outDir, 'server', 'scan-worker.js')

  assert.ok(existsSync(result.serverEntry), '主入口仍是 dist/server/index.js')
  assert.ok(existsSync(workerEntry), '第二个入口应产出 dist/server/scan-worker.js')
  assert.equal(existsSync(join(result.outDir, 'server', 'deep.js')), false, '不递归子目录')
  assert.equal(
    existsSync(join(result.outDir, 'server', 'scan-worker.d.js')),
    false,
    '.d.ts 不是入口',
  )
  assert.equal(existsSync(join(result.outDir, 'server', 'notes.js')), false, '只认脚本扩展名')

  const worker = await import(pathToFileURL(workerEntry).href)
  assert.equal(worker.default(), 'SCAN_WORKER', '第二个入口应作为独立模块可加载')
})

test('单入口项目的 server 产物保持不变', async () => {
  const root = createProject()
  const result = await buildProject({ projectRoot: root })

  assert.deepEqual(
    readdirSync(join(result.outDir, 'server')).sort(),
    ['index.js', 'index.js.map'],
    '只有 index 时不额外产出其他入口',
  )
  const server = await import(pathToFileURL(result.serverEntry).href)
  assert.equal(server.default(), 42, '主入口的原有行为不变')
})

test('dev watcher 把 server 多入口产出到开发目录，路径与 build 一致', async () => {
  const root = createProject()
  writeFileSync(
    join(root, 'server', 'scan-worker.ts'),
    "export default function scan() { return 'DEV_SCAN' }\n",
  )

  const watcher = await createProjectWatcher({ projectRoot: root })
  try {
    const workerEntry = join(watcher.devRoot, 'server', 'scan-worker.js')
    assert.ok(existsSync(watcher.serverEntry), '主入口仍产出 server/index.js')
    assert.ok(existsSync(workerEntry), '开发目录应产出 server/scan-worker.js')

    const worker = await import(pathToFileURL(workerEntry).href)
    assert.equal(worker.default(), 'DEV_SCAN')
  } finally {
    await watcher.close()
  }
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

test('build 把 node_modules 里的插件（含 scope 与 file: 链接）打进 resources/plugins', async () => {
  const root = createProject()
  writeDependency(root, 'fake-dep', {
    files: { 'index.js': "export const marker = 'INSTALLED_PLUGIN_MARKER'\n" },
  })
  writeInstalledPlugin(root, 'installed-plugin', {
    id: 'installed',
    files: {
      'server.js':
        "import { marker } from 'fake-dep'\n" +
        'export default function apply() { return marker }\n',
    },
  })
  writeInstalledPlugin(root, '@scope/scoped-plugin', { id: 'scoped' })
  writeInstalledPlugin(root, 'linked-plugin', { id: 'linked', linked: true })

  const result = await buildProject({ projectRoot: root })

  const ids = result.plugins.map((plugin) => plugin.id).sort()
  assert.deepEqual(
    ids,
    ['demo', 'installed', 'linked', 'scoped'],
    '本地插件与依赖根插件都应出现在构建结果里',
  )

  for (const id of ['installed', 'linked', 'scoped']) {
    const pluginOut = join(result.resourcesDir, 'plugins', id)
    assert.ok(existsSync(join(pluginOut, 'plugin.json')), `${id} 应产出 plugin.json`)
    assert.ok(existsSync(join(pluginOut, 'client.js')), `${id} 应产出 client.js`)
    assert.ok(existsSync(join(pluginOut, 'server.js')), `${id} 应产出 server.js`)
  }

  const installedSource = readFileSync(
    join(result.resourcesDir, 'plugins', 'installed', 'server.js'),
    'utf8',
  )
  assert.match(installedSource, /INSTALLED_PLUGIN_MARKER/, '依赖根插件也必须自包含其依赖')
  assertNoBareImport(installedSource, 'fake-dep', '依赖根插件产物')

  // 构建只读取 node_modules，不复制它。
  assert.deepEqual(findNodeModules(result.outDir), [], 'dist 不能携带 node_modules')

  // 产物搬到没有 node_modules 的环境后仍可加载。
  rmSync(join(root, 'node_modules'), { recursive: true, force: true })
  const built = await import(
    pathToFileURL(join(result.resourcesDir, 'plugins', 'installed', 'server.js')).href
  )
  assert.equal(built.default(), 'INSTALLED_PLUGIN_MARKER')
})

test('依赖插件已是服务端预设产物时不会重复注入 banner', async () => {
  const root = createProject()
  const dir = writeInstalledPlugin(root, 'prebuilt-plugin', { id: 'prebuilt' })
  // 模拟 npm 包中已构建的入口：插件作者先用 serverPreset 产出 lib/server.js。
  writeFileSync(
    join(dir, 'server-source.js'),
    "export default function apply() { return 'PREBUILT_PLUGIN' }\n",
  )
  await esbuild(
    serverPreset({
      entry: 'server-source.js',
      outfile: 'server.js',
      root: dir,
      minify: false,
      sourcemap: false,
    }),
  )
  rmSync(join(dir, 'server-source.js'))

  const result = await buildProject({ projectRoot: root })
  const entry = join(result.resourcesDir, 'plugins', 'prebuilt', 'server.js')
  const source = readFileSync(entry, 'utf8')

  assert.equal(
    (source.match(/createRequire as __cordisAppCreateRequire/g) ?? []).length,
    1,
    '二次构建不能再注入一份 createRequire banner',
  )
  const built = await import(pathToFileURL(entry).href)
  assert.equal(built.default(), 'PREBUILT_PLUGIN', '预构建入口重新打包后仍可加载')
})

test('本地插件与依赖插件同 id 时保留本地插件', async () => {
  const root = createProject()
  writeFileSync(
    join(root, 'plugins', 'demo', 'server.js'),
    "export default function apply() { return 'FROM_LOCAL' }\n",
  )
  writeInstalledPlugin(root, 'demo-plugin', {
    id: 'demo',
    files: {
      'server.js': "export default function apply() { return 'FROM_DEPENDENCY' }\n",
    },
  })

  const lines: string[] = []
  const result = await buildProject({ projectRoot: root, log: (line) => lines.push(line) })

  assert.equal(
    result.plugins.filter((plugin) => plugin.id === 'demo').length,
    1,
    '同 id 只能产出一份插件',
  )
  const source = readFileSync(join(result.resourcesDir, 'plugins', 'demo', 'server.js'), 'utf8')
  assert.match(source, /FROM_LOCAL/)
  assert.doesNotMatch(source, /FROM_DEPENDENCY/)
  assert.ok(
    lines.some((line) => line.includes('本地插件优先')),
    `构建日志应说明跳过了依赖插件：${lines.join(' | ')}`,
  )
})

test('两个依赖插件 id 重复时构建失败，且不产出 dist', async () => {
  const root = createProject()
  writeInstalledPlugin(root, 'first-plugin', { id: 'duplicated' })
  writeInstalledPlugin(root, 'second-plugin', { id: 'duplicated' })

  await assert.rejects(() => buildProject({ projectRoot: root }), /插件 id 重复：duplicated/)
  assert.equal(existsSync(join(root, 'dist')), false)
})

test('依赖插件入口缺失时构建失败，且不产出 dist', async () => {
  const root = createProject()
  const dir = writeInstalledPlugin(root, 'broken-plugin', { id: 'broken' })
  rmSync(join(dir, 'server.js'))

  await assert.rejects(
    () => buildProject({ projectRoot: root }),
    /插件 broken 的 server 入口不存在/,
  )
  assert.equal(existsSync(join(root, 'dist')), false)
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

test('dev server 没有 worker token 时地址不带 token fragment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cordis-dev-no-token-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'body.tsx'), 'export default function Body() { return null }\n')

  const dev = await createProjectDevServer({
    projectRoot: root,
    port: await freePort(),
    strictPort: true,
    worker: { port: 9000 },
  })
  try {
    assert.equal(dev.url, `http://127.0.0.1:${dev.port}/`)
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

test('build 把 pluginSource 打进 dist 并改写产物清单', async () => {
  const root = createProject()
  writeDependency(root, 'source-dep', {
    type: 'module',
    files: { 'index.js': 'export const SOURCE_MARKER = "SOURCE_DEP"\n' },
  })
  writeFileSync(
    join(root, 'server', 'plugin-source.ts'),
    `import { SOURCE_MARKER } from 'source-dep'
export async function readArchive(spec: string): Promise<Uint8Array> {
  return new TextEncoder().encode(spec + ':' + SOURCE_MARKER)
}
`,
  )
  const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'))
  writeFileSync(
    join(root, 'app.json'),
    JSON.stringify({ ...app, pluginSource: 'server/plugin-source.ts' }),
  )

  const result = await buildProject({ projectRoot: root })

  assert.equal(result.pluginSource, join(result.outDir, 'server', 'plugin-source.js'))
  assert.ok(existsSync(result.pluginSource!))
  const builtApp = JSON.parse(readFileSync(result.appJson, 'utf8'))
  assert.equal(
    builtApp.pluginSource,
    PLUGIN_SOURCE_BUILT_PATH,
    '产物清单必须指向构建后的固定位置',
  )

  const source = readFileSync(result.pluginSource!, 'utf8')
  assert.match(source, /SOURCE_DEP/, '来源模块的第三方依赖应打进产物')
  assertNoBareImport(source, 'source-dep', '插件来源产物')

  const mod = await import(pathToFileURL(result.pluginSource!).href)
  assert.equal(typeof mod.readArchive, 'function')
  assert.equal(
    new TextDecoder().decode(await mod.readArchive('demo', {})),
    'demo:SOURCE_DEP',
  )
})

test('build 拒绝项目根之外的 pluginSource，也不留下 dist', async () => {
  const root = createProject()
  const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'))
  writeFileSync(
    join(root, 'app.json'),
    JSON.stringify({ ...app, pluginSource: '../outside.js' }),
  )

  await assert.rejects(() => buildProject({ projectRoot: root }), /不能指向项目根之外/)
  assert.equal(existsSync(join(root, 'dist')), false)
})

test('build 在 pluginSource 文件缺失时失败', async () => {
  const root = createProject()
  const app = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8'))
  writeFileSync(
    join(root, 'app.json'),
    JSON.stringify({ ...app, pluginSource: 'server/missing.js' }),
  )

  await assert.rejects(() => buildProject({ projectRoot: root }), /找不到插件来源模块/)
  assert.equal(existsSync(join(root, 'dist')), false)
})
