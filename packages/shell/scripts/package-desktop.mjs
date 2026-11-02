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
import { isBuiltin } from 'node:module'
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
 * 发布产物允许保留的裸导入。
 *
 * 框架提供的服务端依赖只有两类：不带前缀的 Node 内置模块（例如 `events`）
 * 与 `cordis-app` 的类型面（含子路径）。`@cordis-app/*` 是框架内部包，
 * 不属于公开契约，必须判为违规。
 */
export function isAllowedBareSpecifier(specifier) {
  return (
    isBuiltin(specifier) ||
    specifier === 'cordis-app' ||
    specifier.startsWith('cordis-app/')
  )
}

/**
 * 扫描一段 ESM/CJS 源码里未被框架提供的裸导入。
 *
 * 这是发布门禁的粗筛，不是完整的模块解析器：它只回答「产物里有没有运行
 * 时可能找不到的包名」。注释里的字符串可能被误报，但宁可多报。
 *
 * `__require` 是 esbuild 把 CJS 依赖的动态 `require` 转换后的产物；漏掉它
 * 会放过真正的外部依赖。
 */
export function scanBareImports(source, file) {
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'"]*?\s+from\s+)['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:__)?require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]

  const specifiers = new Set()
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (isBareSpecifier(match[1]) && !isAllowedBareSpecifier(match[1])) {
        specifiers.add(match[1])
      }
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
 * 清单损坏时跳过：构建阶段已经校验过插件，发布门禁只扫描能识别的入口；
 * 不因为一个读不懂的文件在这里制造误导性的失败。
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

/**
 * 校验 dist 里的服务端产物是否还能在运行时解析依赖。
 *
 * 白名单只有 Node 内置模块与 `cordis-app`；其余裸导入（包括 `@cordis-app/*`）
 * 都说明构建期没有把依赖打进产物，桌面安装目录启动后会失败。
 */
export function validateBareImports(distDir) {
  const pluginManifests = collectPluginManifests(distDir)
  const violations = []
  for (const target of planBareImportScan({ distDir, pluginManifests })) {
    if (!existsSync(target.file)) continue
    violations.push(...scanBareImports(readFileSync(target.file, 'utf8'), target.label))
  }
  return { ok: violations.length === 0, violations }
}

function printBareImportViolations(violations) {
  if (violations.length === 0) return

  console.error('服务端产物包含未内联的第三方依赖，无法打包：')
  for (const { file, specifier } of violations) {
    console.error(`  ${file}  →  ${specifier}`)
  }
  console.error(
    '白名单只有 node:* 与 cordis-app；请把这些包声明在项目或插件的依赖里，' +
      '然后重新执行 cordis-app build，让构建期把依赖打进产物。',
  )
}

// ---------------------------------------------------------------- 运行时打包

/**
 * 用 esbuild 把入口打成两个自包含的 ESM `.mjs`。
 *
 * banner、可选原生依赖的空模块与 `WS_NO_*` 定义来自 @cordis-app/preset 的
 * 共享片段：服务端预设与桌面运行时打包器必须是同一套规则。
 *
 * `format: 'esm'` + `platform: 'node'` + `target: 'node22'` 与根 engines
 * （node >= 22.18）对齐；ESM 天然保留顶层 await。`nodePaths` 只用于测试
 * 夹具解析工作区里的 ws，生产路径不需要。
 */
export async function bundleRuntime({ entries, outDir, nodePaths }) {
  const { build } = await import('esbuild')
  const { RUNTIME_BANNER, RUNTIME_DEFINE, optionalNativeModulesPlugin } =
    await import(
      pathToFileURL(join(repoRoot, 'packages', 'preset', 'lib', 'index.js')).href
    )
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

  // 发布门禁：不完整的产物不能进入暂存、runtime 打包或 go build。
  const bareImports = validateBareImports(distDir)
  if (!bareImports.ok) {
    printBareImportViolations(bareImports.violations)
    return 1
  }

  if (publicKeyPath && !existsSync(publicKeyPath)) {
    console.error(`找不到签名公钥：${publicKeyPath}`)
    return 1
  }

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
