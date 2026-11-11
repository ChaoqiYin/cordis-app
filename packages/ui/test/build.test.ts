/**
 * 项目构建的对外契约：目录布局、body 替换、共享模块与幂等。
 *
 * 断言只绑定 `build` 文档承诺的文件，不绑定 Vite 的内部文件名。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
import {
  SHARED_MODULE_TABLE,
  SHARED_PREFIX,
  PLUGIN_SOURCE_BUILT_PATH,
  WS_PATH,
} from '@cordis-app/protocol'
import {
  assertSharedModulesReady,
  buildProject,
  createProjectDevServer,
  createProjectWatcher,
  swapIntoPlace,
} from '../src/build/index.ts'
import {
  SHARED_BUILD_COMMAND,
  SHARED_PROFILE_DIRS,
  sharedProfileMarker,
} from '../shared-modules.mjs'

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

/** 通过开发服务器的公共 URL 读取一个共享模块产物。 */
async function fetchSharedModule(port: number, file: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}${SHARED_PREFIX}/${file}`)
  assert.equal(response.status, 200, `${file} 必须由开发服务器提供`)
  return response.text()
}

/** 正则里的字面量转义，用于断言错误信息包含路径。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 在临时根下铺一套完整的共享模块产物。 */
function createSharedProfileDir(
  root: string,
  profile: 'development' | 'production',
): string {
  const dir = join(root, SHARED_PROFILE_DIRS[profile])
  mkdirSync(dir, { recursive: true })
  for (const definition of Object.values(SHARED_MODULE_TABLE)) {
    writeFileSync(join(dir, definition.file), `${sharedProfileMarker(profile)}\nexport {}\n`)
  }
  return dir
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

test('build 的共享模块是生产构建态，文件集合与清单一致', async () => {
  const root = createProject()
  const result = await buildProject({ projectRoot: root })
  const shared = join(result.resourcesDir, 'shared')

  const expected = Object.values(SHARED_MODULE_TABLE).map((definition) => definition.file)
  assert.deepEqual(
    readdirSync(shared)
      .filter((name) => name.endsWith('.js'))
      .sort(),
    [...expected].sort(),
    '发布布局里的共享模块文件名必须与清单一致',
  )

  for (const definition of Object.values(SHARED_MODULE_TABLE)) {
    const source = readFileSync(join(shared, definition.file), 'utf8')
    assert.ok(
      source.startsWith(sharedProfileMarker('production')),
      `${definition.file} 必须带生产构建态标记`,
    )
  }

  assert.doesNotMatch(
    readFileSync(join(shared, SHARED_MODULE_TABLE['react-dom/client'].file), 'utf8'),
    /injectInternals/,
    '生产构建的 react-dom/client 不注册 DevTools renderer',
  )
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
    existsSync(join(result.resourcesDir, 'plugins', 'demo', 'client.js')),
    'import type 在转译前被擦除，不应触发客户端内部包边界',
  )
})

test('TSX 入口产出 .js，产物清单改写，源清单与其他字段不变', async () => {
  const root = createProject()
  const pluginRoot = join(root, 'plugins', 'demo')
  mkdirSync(join(pluginRoot, 'src'), { recursive: true })
  const sourceManifest = {
    id: 'demo',
    displayName: 'Demo',
    version: '2.0.0',
    client: 'src/client.tsx',
    server: 'src/server.tsx',
    ui: { pages: true },
    capabilities: ['storage'],
    extra: { keep: true },
  }
  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify(sourceManifest, null, 2) + '\n',
  )
  writeFileSync(
    join(pluginRoot, 'src', 'client.tsx'),
    'export default function activate() { return "TSX_CLIENT" }\n',
  )
  writeFileSync(
    join(pluginRoot, 'src', 'server.tsx'),
    'export default function apply() { return "TSX_SERVER" }\n',
  )

  const result = await buildProject({ projectRoot: root })
  const pluginOut = join(result.resourcesDir, 'plugins', 'demo')

  for (const file of ['client.js', 'server.js', 'client.js.map', 'server.js.map']) {
    assert.ok(existsSync(join(pluginOut, 'src', file)), `应产出 src/${file}`)
  }
  assert.equal(existsSync(join(pluginOut, 'src', 'client.tsx')), false, '不保留源扩展名产物')
  assert.equal(existsSync(join(pluginOut, 'src', 'server.tsx')), false)

  const builtManifest = JSON.parse(readFileSync(join(pluginOut, 'plugin.json'), 'utf8'))
  assert.equal(builtManifest.client, 'src/client.js', '产物清单必须指向 .js 入口')
  assert.equal(builtManifest.server, 'src/server.js')
  assert.equal(builtManifest.displayName, 'Demo', '其他字段原样保留')
  assert.equal(builtManifest.version, '2.0.0')
  assert.deepEqual(builtManifest.ui, { pages: true })
  assert.deepEqual(builtManifest.capabilities, ['storage'])
  assert.deepEqual(builtManifest.extra, { keep: true })

  assert.deepEqual(
    JSON.parse(readFileSync(join(pluginRoot, 'plugin.json'), 'utf8')),
    sourceManifest,
    '源目录的 plugin.json 不能被构建改写',
  )

  const builtPlugin = result.plugins.find((plugin) => plugin.id === 'demo')!
  assert.deepEqual(builtPlugin.files.sort(), [
    'src/client.js',
    'src/client.js.map',
    'src/server.js',
    'src/server.js.map',
  ])
})

test('入口归一化后的产物路径冲突时构建失败，且不产出 dist', async () => {
  const root = createProject()
  const pluginRoot = join(root, 'plugins', 'demo')
  mkdirSync(join(pluginRoot, 'src'), { recursive: true })
  writeFileSync(
    join(pluginRoot, 'plugin.json'),
    JSON.stringify({ id: 'demo', client: 'src/index.tsx', server: 'src/index.ts' }),
  )
  writeFileSync(join(pluginRoot, 'src', 'index.tsx'), 'export default function activate() {}\n')
  writeFileSync(join(pluginRoot, 'src', 'index.ts'), 'export default function apply() {}\n')

  await assert.rejects(
    () => buildProject({ projectRoot: root }),
    (error: Error) => {
      assert.match(error.message, /demo/, '错误应指出插件 id')
      assert.match(error.message, /前端 src\/index\.tsx/, '错误应指出前端入口')
      assert.match(error.message, /服务端 src\/index\.ts/, '错误应指出服务端入口')
      assert.match(error.message, /src\/index\.js/, '错误应指出冲突的产物路径')
      return true
    },
  )
  assert.equal(existsSync(join(root, 'dist')), false, '冲突时不能产出 dist')
})

test('插件入口扩展名不受支持时构建失败，且不产出 dist', async () => {
  const root = createProject()
  writeFileSync(
    join(root, 'plugins', 'demo', 'plugin.json'),
    JSON.stringify({ id: 'demo', client: 'client.vue' }),
  )
  writeFileSync(join(root, 'plugins', 'demo', 'client.vue'), '<template />\n')

  await assert.rejects(
    () => buildProject({ projectRoot: root }),
    (error: Error) => {
      assert.match(error.message, /client\.vue/, '错误应指出不支持的入口')
      assert.match(error.message, /\.tsx/, '错误应列出可接受的 TS/TSX 扩展名')
      assert.match(error.message, /\.js/, '错误应列出可接受的 JS 扩展名')
      return true
    },
  )
  assert.equal(existsSync(join(root, 'dist')), false)
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

test('dev 预构建的依赖复用 /__shared 的 React，不再打第二份', async () => {
  // 回归：Radix / react-i18next 的 hooks 依赖同一个 React 实例。Vite 预构建
  // 若把依赖里的 `import 'react'` 就地打包，useContext 读到的 dispatcher 来自
  // 另一份副本，页面直接报 Cannot read properties of null。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cordis-dev-shared-')))
  const depDir = join(root, 'node_modules', 'hook-dep')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(depDir, { recursive: true })
  writeFileSync(
    join(depDir, 'package.json'),
    JSON.stringify({ name: 'hook-dep', version: '1.0.0', type: 'module', main: 'index.js' }),
  )
  writeFileSync(
    join(depDir, 'index.js'),
    [
      "import React from 'react'",
      "import { createRoot } from 'react-dom/client'",
      'export function useDep() { return React.useContext(React.createContext(null)) }',
      'export { createRoot }',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'src', 'body.tsx'),
    [
      "import { useDep } from 'hook-dep'",
      'export default function Body() { useDep(); return null }',
      '',
    ].join('\n'),
  )

  const dev = await createProjectDevServer({
    projectRoot: root,
    port: await freePort(),
    strictPort: true,
    worker: { port: 9000 },
  })
  try {
    for (const shared of Object.keys(SHARED_MODULE_TABLE)) {
      assert.ok(
        !dev.server.config.optimizeDeps.include?.some(
          (id) => typeof id === 'string' && (id === shared || id.startsWith(`${shared}/`)),
        ),
        `${shared} 不能留在 optimizeDeps.include 里`,
      )
      assert.ok(
        dev.server.config.optimizeDeps.exclude?.includes(shared),
        `${shared} 必须排除出预构建`,
      )
    }

    const body = await dev.server.transformRequest(join(root, 'src', 'body.tsx'))
    const depUrl = [...(body?.code ?? '').matchAll(/from\s+["']([^"']*hook-dep[^"']*)["']/g)][0]?.[1]
    assert.ok(depUrl, 'body 应把 hook-dep 交给 Vite 预构建')

    const dep = await dev.server.transformRequest(depUrl)
    assert.match(
      dep?.code ?? '',
      /from\s+["']\/@id\/__x00__cordis-app:shared:react["']/,
      '预构建依赖的 react 导入必须指向共享模块',
    )
    assert.match(
      dep?.code ?? '',
      /from\s+["']\/@id\/__x00__cordis-app:shared:react-dom\/client["']/,
      'react-dom/client 同样必须指向共享模块',
    )
    assert.doesNotMatch(
      dep?.code ?? '',
      /Symbol\.for\(\s*["']react\.(?:transitional\.element|portal|fragment)["']\s*\)/,
      '预构建依赖不能自带 React 实现',
    )

    // 共享模块的 default 转发要真的能加载：react-i18next 的 IcuTransWithoutContext
    // 写的是 `import React from 'react'`。
    const shared = await fetch(
      `http://127.0.0.1:${dev.port}/@id/__x00__cordis-app:shared:react`,
    )
    assert.equal(shared.status, 200)
    assert.match(await shared.text(), /export default __shared\.default/)
  } finally {
    await dev.close()
  }
})

test('dev 把 /__shared/*.js 当作浏览器 URL，不解析成文件、不追加 ?v=', async () => {
  // 回归：框架装进 node_modules 后（pnpm / npm file: 依赖），shell 里的
  // /__shared/*.js 若可解析，Vite 会把它当 node_modules 模块并追加
  // ?v=<browserHash>；而共享 bundle 之间仍写不带查询的同一 URL，同一份
  // React 因此被加载两次，body 里的第一个 hook 读到 null dispatcher。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cordis-dev-shared-url-')))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'body.tsx'),
    [
      "import { useLayoutEffect } from 'react'",
      'export default function Body() { useLayoutEffect(() => {}, []); return null }',
      '',
    ].join('\n'),
  )

  const dev = await createProjectDevServer({
    projectRoot: root,
    port: await freePort(),
    strictPort: true,
    worker: { port: 9000 },
  })
  try {
    // 共享模块不能出现在 shell root 下，否则 vite:resolve 会把它们当文件。
    assert.equal(
      existsSync(join(dev.server.config.root, '__shared')),
      false,
      'shell root 不能带 __shared 目录',
    )

    for (const definition of Object.values(SHARED_MODULE_TABLE)) {
      const url = `${SHARED_PREFIX}/${definition.file}`
      const resolved = await dev.server.pluginContainer.resolveId(url)
      assert.equal(resolved?.id, url, `${url} 必须原样保留`)
      assert.equal(resolved?.external, true, `${url} 必须作为 external 交给浏览器`)
    }

    // 宿主模块拿到的是规范 URL，与插件 bundle 里写的一致。
    const shared = await fetch(
      `http://127.0.0.1:${dev.port}/@id/__x00__cordis-app:shared:react`,
    )
    assert.equal(shared.status, 200)
    const code = await shared.text()
    assert.match(code, /from "\/__shared\/react\.js"/)
    assert.doesNotMatch(code, /__shared\/react\.js\?/, '共享模块 URL 不能带版本查询')
  } finally {
    await dev.close()
  }
})

test('dev server 的 /__shared 提供开发构建态，文件集合与清单一致', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cordis-dev-profile-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'body.tsx'), 'export default function Body() { return null }\n')

  const dev = await createProjectDevServer({
    projectRoot: root,
    port: await freePort(),
    strictPort: true,
    worker: { port: 9000 },
  })
  try {
    for (const definition of Object.values(SHARED_MODULE_TABLE)) {
      const source = await fetchSharedModule(dev.port, definition.file)
      assert.ok(
        source.startsWith(sharedProfileMarker('development')),
        `${definition.file} 必须带开发构建态标记`,
      )
    }

    const reactDomClient = await fetchSharedModule(
      dev.port,
      SHARED_MODULE_TABLE['react-dom/client'].file,
    )
    assert.match(
      reactDomClient,
      /injectInternals/,
      '开发构建的 react-dom/client 必须注册 DevTools renderer',
    )

    const reactDom = await fetchSharedModule(dev.port, SHARED_MODULE_TABLE['react-dom'].file)
    assert.doesNotMatch(
      reactDom,
      new RegExp(escapeRegExp(sharedProfileMarker('production'))),
      '开发服务器不能回退到生产产物',
    )
  } finally {
    await dev.close()
  }
})

test('dev server 的 /__shared 提供开发构建的 sourcemap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cordis-dev-sourcemap-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'body.tsx'), 'export default function Body() { return null }\n')

  const dev = await createProjectDevServer({
    projectRoot: root,
    port: await freePort(),
    strictPort: true,
    worker: { port: 9000 },
  })
  try {
    const url = `${SHARED_PREFIX}/${SHARED_MODULE_TABLE['react-dom'].file}.map`
    const response = await fetch(`http://127.0.0.1:${dev.port}${url}`)
    assert.equal(response.status, 200, `${url} 必须由开发服务器提供`)
    assert.match(
      response.headers.get('content-type') ?? '',
      /^application\/json/,
      'sourcemap 必须以 JSON content-type 返回',
    )

    const map = JSON.parse(await response.text()) as { sources?: unknown }
    assert.ok(
      Array.isArray(map.sources) && map.sources.length > 0,
      'sourcemap 必须可解析且包含 sources',
    )
  } finally {
    await dev.close()
  }
})

test('共享模块启动校验：目录缺失、文件缺失与标记不匹配都失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'cordis-shared-profile-'))
  const missingDir = join(root, 'missing', SHARED_PROFILE_DIRS.development)
  const missingFileDir = createSharedProfileDir(join(root, 'missing-file'), 'development')
  const missingFile = join(missingFileDir, SHARED_MODULE_TABLE['react-dom'].file)
  rmSync(missingFile)
  const markerDir = createSharedProfileDir(join(root, 'marker'), 'development')
  const markerFile = join(markerDir, SHARED_MODULE_TABLE['react-dom'].file)
  writeFileSync(markerFile, `${sharedProfileMarker('production')}\nexport {}\n`)

  const cases = [
    { name: '目录缺失', dir: missingDir, path: missingDir, expected: /产物缺失/ },
    { name: '清单中文件缺失', dir: missingFileDir, path: missingFile, expected: /产物缺失/ },
    { name: '标记不匹配', dir: markerDir, path: markerFile, expected: /构建态标记不匹配/ },
  ]

  try {
    for (const item of cases) {
      assert.throws(
        () => assertSharedModulesReady(item.dir, 'development'),
        (error: Error) => {
          assert.match(
            error.message,
            new RegExp(escapeRegExp(item.path)),
            `${item.name}：错误应包含产物路径`,
          )
          assert.match(
            error.message,
            new RegExp(escapeRegExp(SHARED_BUILD_COMMAND)),
            `${item.name}：错误应包含构建命令`,
          )
          assert.match(error.message, item.expected, item.name)
          return true
        },
        item.name,
      )
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('共享模块构建脚本必须显式传入构建态', () => {
  const result = spawnSync(process.execPath, [join(here, '..', 'scripts', 'build-shared.mjs')], {
    encoding: 'utf8',
  })
  assert.notEqual(result.status, 0, '省略构建态时必须失败')
  const output = `${result.stdout}${result.stderr}`
  assert.match(output, /development/, '错误应列出 development')
  assert.match(output, /production/, '错误应列出 production')
})

test('dev 加载项目根 vite.config，但不交出 root 与共享模块约束', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cordis-dev-vite-config-')))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'body.tsx'), 'export default function Body() { return null }\n')
  writeFileSync(
    join(root, 'vite.config.mjs'),
    [
      'export default {',
      "  root: '/definitely-not-the-shell',",
      "  base: '/wrong/',",
      "  define: { __PROJECT_FLAG__: JSON.stringify('mounted') },",
      "  server: { host: '0.0.0.0', port: 1, strictPort: false, headers: { 'x-project': 'yes' }, fs: { allow: ['/tmp/cordis-extra'] } },",
      "  optimizeDeps: { exclude: ['project-only-dep'] },",
      "  plugins: [{ name: 'project-marker-plugin' }],",
      '}',
      '',
    ].join('\n'),
  )

  const port = await freePort()
  const dev = await createProjectDevServer({
    projectRoot: root,
    port,
    strictPort: true,
    worker: { port: 9000 },
    // 程序化挂载点叠加在项目文件之后。
    viteConfig: (config) => ({
      ...config,
      define: { ...config.define, __HOOK_FLAG__: JSON.stringify('yes') },
    }),
  })
  try {
    const config = dev.server.config
    assert.match(config.root, /dist\/shell$/, 'root 必须仍是框架壳')
    assert.equal(config.base, '/', 'base 不能交给项目改')
    assert.equal(config.server.host, '127.0.0.1', 'host 由框架钉住')
    assert.equal(config.server.port, port, '端口由 CLI 决定，项目配置不能改')
    assert.equal(config.server.strictPort, true, 'strictPort 不能被项目配置改回 false')
    assert.equal(config.define?.__PROJECT_FLAG__, JSON.stringify('mounted'))
    assert.equal(config.define?.__HOOK_FLAG__, JSON.stringify('yes'))
    assert.equal(config.server.headers?.['x-project'], 'yes', '项目 server 项要生效')
    assert.ok(config.server.fs.allow.includes('/tmp/cordis-extra'), '项目的 fs.allow 要保留')
    assert.ok(config.server.proxy?.['/api'], '框架代理不能被项目配置挤掉')
    assert.ok(config.plugins.some((plugin) => plugin.name === 'project-marker-plugin'))
    assert.ok(config.optimizeDeps.exclude?.includes('project-only-dep'))
    assert.ok(config.optimizeDeps.exclude?.includes('react'), '共享模块始终排除')
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
