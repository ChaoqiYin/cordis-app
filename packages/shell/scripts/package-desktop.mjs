#!/usr/bin/env node
/**
 * 桌面打包：把一个项目的 dist/ 变成可直接运行的安装目录。
 *
 * 顺序与 spec 一致：
 *   校验 dist → 暂存到外壳嵌入目录 → esbuild 打包 supervisor/worker
 *   → go build → 复制 node 与两个 .mjs 到 <out>/bin/
 *
 * 这个脚本只构建宿主平台的安装目录；交叉打包是安装器/发布流程的事。
 */

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shellDir = resolve(here, '..')
const repoRoot = resolve(shellDir, '..', '..')

/**
 * 打包形态必须具备的 dist 产物。
 *
 * 必须与 packages/shell/app.go 的 requiredAppFiles 保持同一组：打包期放行、
 * 运行期才报缺失的缺口，最容易出现在 package.json 这种「不显眼但必需」的
 * 文件上。修改时两处同步。
 *
 * `package.json` 也在这里：Node 靠它把 `server/*.js` 按 ESM 解析，缺了它
 * 安装目录里的服务端产物会被当成 CommonJS 而直接失败。
 */
export const REQUIRED_DIST_FILES = [
  'app.json',
  'package.json',
  'server/index.js',
  'resources/ui/index.html',
]

/** 暂存到外壳嵌入目录的 dist 顶层条目。 */
const STAGED_DIST_ENTRIES = ['app.json', 'package.json', 'server', 'resources']

/** 外壳 app/ 目录里的仓库占位文件，清空时不能删。 */
const STAGED_PRESERVE = ['.gitignore', '.gitkeep']

/** 随包的签名公钥文件名，必须与 Go 侧 prepareApp 的约定一致。 */
const BUNDLE_PUBLIC_KEY_NAME = 'bundle-public-key.pem'

/** 需要解析成内联空模块的可选原生依赖。 */
const OPTIONAL_NATIVE_MODULE_PATTERN = /^(bufferutil|utf-8-validate)$/

/**
 * 用 createRequire 补齐 ESM 下的 require。
 *
 * ws 的 CJS 产物里有 `require('events')` 之类的动态 require；esbuild 转成
 * ESM 后会走 `__require`，没有这个 banner 就会在加载时抛
 * 「Dynamic require of "events" is not supported」。
 */
const RUNTIME_BANNER = [
  "import { createRequire as __cordisAppCreateRequire } from 'node:module';",
  'const require = __cordisAppCreateRequire(import.meta.url);',
].join('\n')

/**
 * 关闭 ws 的可选原生加速分支。
 *
 * 空模块能让 esbuild 完成解析，但 ws 会在 `require` 成功后改用
 * `bufferUtil.mask/unmask`；空对象没有这些函数，大消息就会在运行期崩溃。
 * 显式定义这两个开关，让 ws 走自带的纯 JS 回退。
 */
const RUNTIME_DEFINE = {
  'process.env.WS_NO_BUFFER_UTIL': '"true"',
  'process.env.WS_NO_UTF_8_VALIDATE': '"true"',
}

// ---------------------------------------------------------------- 纯函数

/**
 * 校验 dist 是否具备打包必要文件。
 *
 * `exists` 可注入，测试不需要真的创建整棵目录。
 */
export function validateDist(distDir, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  const missing = REQUIRED_DIST_FILES.filter(
    (relative) => !exists(join(distDir, ...relative.split('/'))),
  )
  return { ok: missing.length === 0, missing }
}

/**
 * 生成暂存计划：清空 app/（保留占位文件），把 dist 顶层条目搬进去。
 *
 * 纯函数，不碰文件系统。公钥可选，复制时统一改名成运行时约定的 PEM 名。
 */
export function planStaging({ distDir, shellAppDir, publicKeyPath }) {
  const copies = STAGED_DIST_ENTRIES.map((relative) => ({
    from: join(distDir, relative),
    to: join(shellAppDir, relative),
  }))
  if (publicKeyPath) {
    copies.push({
      from: publicKeyPath,
      to: join(shellAppDir, BUNDLE_PUBLIC_KEY_NAME),
    })
  }
  return { target: shellAppDir, preserve: [...STAGED_PRESERVE], copies }
}

/** 非 `node:`、非相对、非绝对路径的导入都算裸导入。 */
export function isBareSpecifier(specifier) {
  return (
    !specifier.startsWith('node:') &&
    !specifier.startsWith('.') &&
    !specifier.startsWith('/')
  )
}

/**
 * 扫描一段 ESM/CJS 源码里的裸导入。
 *
 * 这是发布前的粗筛，不是完整的模块解析器：它只回答「产物里有没有 Node
 * 运行时可能找不到的包名」。注释里的字符串可能被误报，但宁可多报。
 */
export function scanBareImports(source, file) {
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  const specifiers = new Set()
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (isBareSpecifier(match[1])) specifiers.add(match[1])
    }
  }

  return [...specifiers].sort().map((specifier) => ({ file, specifier }))
}

/**
 * 规划裸导入扫描目标：项目 server 与内置插件的服务端产物。
 *
 * 插件清单由调用方读好传进来，函数本身只做路径规划。
 */
export function planBareImportScan({ distDir, pluginManifests = [] }) {
  const targets = [
    { file: join(distDir, 'server', 'index.js'), label: 'server/index.js' },
  ]

  for (const { dir, manifest } of pluginManifests) {
    if (!manifest || typeof manifest.server !== 'string' || manifest.server === '') {
      continue
    }
    const relative = ['resources', 'plugins', dir, manifest.server].join('/')
    targets.push({
      file: join(distDir, ...relative.split('/')),
      label: relative,
    })
  }

  return targets
}

/** 解析命令行。未知参数直接失败，避免拼错参数后被静默忽略。 */
export function parseArgs(argv) {
  const options = {
    project: undefined,
    out: undefined,
    publicKey: undefined,
    help: false,
  }
  const valueFlags = {
    '--project': 'project',
    '-p': 'project',
    '--out': 'out',
    '-o': 'out',
    '--bundle-public-key': 'publicKey',
    '--key': 'publicKey',
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    const key = valueFlags[arg]
    if (!key) throw new Error(`未知参数：${arg}`)

    const value = argv[index + 1]
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${arg} 缺少参数值`)
    }
    options[key] = value
    index++
  }

  return options
}

// ---------------------------------------------------------------- 文件系统

function applyStaging(plan) {
  mkdirSync(plan.target, { recursive: true })
  for (const name of readdirSync(plan.target)) {
    if (plan.preserve.includes(name)) continue
    rmSync(join(plan.target, name), { recursive: true, force: true })
  }
  for (const { from, to } of plan.copies) {
    cpSync(from, to, { recursive: true })
  }
}

/**
 * 收集内置插件的清单。
 *
 * 清单损坏时跳过：构建阶段已经校验过插件，这里只做发布前提示，不该因为
 * 一个读不懂的文件阻断打包。
 */
function collectPluginManifests(distDir) {
  const pluginsDir = join(distDir, 'resources', 'plugins')
  if (!existsSync(pluginsDir)) return []

  const manifests = []
  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const manifestPath = join(pluginsDir, entry.name, 'plugin.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        manifests.push({ dir: entry.name, manifest })
      }
    } catch {
      // 忽略
    }
  }
  return manifests
}

/** 读取并扫描服务端产物，返回需要提示的裸导入。 */
export function collectBareImportWarnings(distDir) {
  const pluginManifests = collectPluginManifests(distDir)
  const warnings = []
  for (const target of planBareImportScan({ distDir, pluginManifests })) {
    if (!existsSync(target.file)) continue
    warnings.push(...scanBareImports(readFileSync(target.file, 'utf8'), target.label))
  }
  return warnings
}

function printBareImportWarnings(warnings) {
  if (warnings.length === 0) return

  console.warn('警告：服务端产物包含未内联的第三方依赖，安装后可能启动失败。')
  for (const { file, specifier } of warnings) {
    console.warn(`  ${file}  →  ${specifier}`)
  }
  console.warn(
    "当前服务端预设使用 packages: 'external'，这些依赖不会随包分发；" +
      '请把服务端依赖内联进产物，或等待 distribution 预设。',
  )
}

// ---------------------------------------------------------------- 运行时打包

/** 把可选原生依赖解析成内联空模块。 */
export function optionalNativeModulesPlugin() {
  return {
    name: 'cordis-app-optional-native-modules',
    setup(build) {
      build.onResolve(
        { filter: OPTIONAL_NATIVE_MODULE_PATTERN },
        (args) => ({ path: args.path, namespace: 'cordis-app-empty' }),
      )
      build.onLoad({ filter: /.*/, namespace: 'cordis-app-empty' }, () => ({
        contents: 'export {}',
        loader: 'js',
      }))
    },
  }
}

/**
 * 用 esbuild 把入口打成两个自包含的 ESM `.mjs`。
 *
 * `format: 'esm'` + `platform: 'node'` + `target: 'node22'` 与根 engines
 * （node >= 22.18）对齐；ESM 天然保留顶层 await。`nodePaths` 只用于测试
 * 夹具解析工作区里的 ws，生产路径不需要。
 */
export async function bundleRuntime({ entries, outDir, nodePaths }) {
  const { build } = await import('esbuild')
  mkdirSync(outDir, { recursive: true })

  for (const { entry, outfile } of entries) {
    await build({
      entryPoints: [entry],
      outfile: join(outDir, outfile),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      logLevel: 'warning',
      banner: { js: RUNTIME_BANNER },
      define: { ...RUNTIME_DEFINE },
      plugins: [optionalNativeModulesPlugin()],
      ...(nodePaths ? { nodePaths } : {}),
    })
  }
}

// 默认数据目录由 Go 外壳按平台解析；这里只提示可用 --data 覆盖，避免在
// 脚本里维护第三份平台规则。

function printUsage() {
  console.log(
    [
      '用法：node packages/shell/scripts/package-desktop.mjs --project <项目目录> --out <输出目录> [--bundle-public-key <PEM 文件>]',
      '',
      '前置：项目已执行 cordis-app build；仓库已执行 pnpm build:runtime。',
      '输出：<out>/cordis-app 与 <out>/bin/{node, cordis-app-supervisor.mjs, cordis-app-worker.mjs}',
    ].join('\n'),
  )
}

// ---------------------------------------------------------------- 主流程

/** 执行完整打包，返回进程退出码。 */
export async function runPackage(options) {
  const projectDir = resolve(options.project)
  const outDir = resolve(options.out)
  const distDir = join(projectDir, 'dist')
  const shellAppDir = join(shellDir, 'app')
  const publicKeyPath = options.publicKey ? resolve(options.publicKey) : undefined

  const validation = validateDist(distDir)
  if (!validation.ok) {
    console.error('找不到可打包的项目产物：')
    for (const relative of validation.missing) {
      console.error(`  缺少 ${join(distDir, ...relative.split('/'))}`)
    }
    console.error(`先执行 cordis-app build（项目目录：${projectDir}）`)
    return 1
  }

  if (publicKeyPath && !existsSync(publicKeyPath)) {
    console.error(`找不到签名公钥：${publicKeyPath}`)
    return 1
  }

  printBareImportWarnings(collectBareImportWarnings(distDir))

  applyStaging(
    planStaging({ distDir, shellAppDir, publicKeyPath }),
  )

  const runtimeLib = join(repoRoot, 'packages', 'runtime', 'lib')
  const entries = [
    {
      entry: join(runtimeLib, 'supervisor', 'main.js'),
      outfile: 'cordis-app-supervisor.mjs',
    },
    {
      entry: join(runtimeLib, 'worker', 'main.js'),
      outfile: 'cordis-app-worker.mjs',
    },
  ]
  const missingRuntime = entries
    .filter(({ entry }) => !existsSync(entry))
    .map(({ entry }) => entry)
  if (missingRuntime.length > 0) {
    console.error('找不到 runtime 构建产物：')
    for (const entry of missingRuntime) console.error(`  缺少 ${entry}`)
    console.error('先执行 pnpm build:runtime（或使用 pnpm package:desktop）')
    return 1
  }

  const binDir = join(outDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  await bundleRuntime({ entries, outDir: binDir })

  const exeName = process.platform === 'win32' ? 'cordis-app.exe' : 'cordis-app'
  const exePath = join(outDir, exeName)
  const goBuild = spawnSync('go', ['build', '-o', exePath, '.'], {
    cwd: shellDir,
    stdio: 'inherit',
  })
  if (goBuild.error) {
    console.error(`无法执行 go build：${goBuild.error.message}`)
    return 1
  }
  if (goBuild.status !== 0) {
    console.error(`go build 失败（退出码 ${goBuild.status}）`)
    return 1
  }

  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
  const nodePath = join(binDir, nodeName)
  copyFileSync(process.execPath, nodePath)
  chmodSync(nodePath, 0o755)

  const supervisorPath = join(binDir, 'cordis-app-supervisor.mjs')
  const workerPath = join(binDir, 'cordis-app-worker.mjs')

  console.log(`桌面安装目录已生成：${outDir}`)
  console.log(`  可执行文件  ${exePath}`)
  console.log(`  运行时      ${nodePath}`)
  console.log(`  supervisor  ${supervisorPath}`)
  console.log(`  worker      ${workerPath}`)
  console.log('  数据目录    默认按平台标准目录（可用 --data 覆盖）')
  console.log(`启动：${exePath}`)
  if (publicKeyPath) {
    console.log('已随包分发签名公钥：bundle-public-key.pem')
  }
  return 0
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    printUsage()
    process.exitCode = 1
    return
  }

  if (options.help) {
    printUsage()
    return
  }
  if (!options.project || !options.out) {
    console.error('缺少 --project 或 --out')
    printUsage()
    process.exitCode = 1
    return
  }

  try {
    process.exitCode = await runPackage(options)
  } catch (error) {
    console.error(`打包失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  await main()
}
