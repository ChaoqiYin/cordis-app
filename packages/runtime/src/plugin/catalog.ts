/**
 * 插件身份目录。
 *
 * 「哪些包是插件、它的 id 是什么、包名是什么、前端资源挂在哪个前缀下」——
 * 这三个问题原本散落在 loader、worker API 与 CLI 里，各自读一遍 plugin.json，
 * 于是出现了「设置页按 id 卸载、安装器按包名卸载」这类错位。
 *
 * 现在只有这一个模块回答它们：loader 拿它去挂载，API 拿它去列表与卸载，
 * CLI 拿它去展示。扫描是纯读操作，不做缓存——安装/卸载之后重启 worker，
 * 目录自然重新生成。
 *
 * 四个根按固定优先级合并：builtin > local > dependency > user。每个根只扫
 * 一层，带 plugin.json 的包才是插件。重复 id 保留高优先级插件，并为低优先级
 * 的冲突产生一条可读失败；应用继续启动，只让冲突插件不可用。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import semver from 'semver'
import {
  CORE_PACKAGE,
  FRAMEWORK_VERSION,
  PLUGINS_PREFIX,
  SHARED_MODULES,
  SHARED_PEER_RANGES,
  type PluginFailure,
  type PluginManifest,
} from '@cordis-app/protocol'

export interface PackageJsonLike {
  name?: string
  version?: string
  main?: string
  module?: string
  exports?: unknown
  peerDependencies?: Record<string, string>
}

export type PluginRootKind = 'builtin' | 'local' | 'dependency' | 'user'

/** 一个插件根。`dir` 不存在时扫描会安静跳过。 */
export interface PluginRoot {
  kind: PluginRootKind
  dir: string
}

/** 一个已安装、清单合法的插件。id 与包名是两套身份，这里都保留。 */
export interface InstalledPlugin {
  /** plugin.json 里的 id，也是 `/__plugins/<id>/` 的挂载键 */
  id: string
  /** npm 包名 */
  packageName: string
  /** 包根目录，仅用于磁盘寻址；不进入 URL */
  root: string
  /** 插件来自哪个根 */
  rootKind: PluginRootKind
  manifest: PluginManifest
  packageJson: PackageJsonLike
}

export interface PluginScan {
  plugins: InstalledPlugin[]
  /** 清单非法、peer 不兼容、id 冲突等「这个包是插件但不能用」的记录 */
  failures: PluginFailure[]
  /** id → 包根目录。静态服务只查这张表，绝不把 URL 拼到磁盘路径。 */
  roots: Map<string, string>
}

export interface ScanOptions {
  /** 启动 doctor 使用的框架版本；缺省取构建期注入的 FRAMEWORK_VERSION */
  frameworkVersion?: string
}

/**
 * 根的优先级，数字越小越优先。
 *
 * 内置插件排第一是安全边界：用户插件不能靠同名 id 静默替换随应用分发的代码。
 */
const ROOT_PRIORITY: Record<PluginRootKind, number> = {
  builtin: 0,
  local: 1,
  dependency: 2,
  user: 3,
}

const ROOT_LABEL: Record<PluginRootKind, string> = {
  builtin: '内置插件',
  local: '项目本地',
  dependency: '项目依赖',
  user: '用户插件',
}

/**
 * 扫描多个插件根并按优先级合并。
 *
 * 传入顺序不重要：这里会先按 kind 排序，再依次扫描，因此高优先级根总是先
 * 占用 id。重复 id 只在最终结果里留下一条失败，失败原因列出冲突双方来自哪个根。
 */
export function scanPluginRoots(roots: readonly PluginRoot[], options: ScanOptions = {}): PluginScan {
  const frameworkVersion = options.frameworkVersion ?? FRAMEWORK_VERSION
  const ordered = [...roots].sort((a, b) => ROOT_PRIORITY[a.kind] - ROOT_PRIORITY[b.kind])

  const candidates: InstalledPlugin[] = []
  const failures: PluginFailure[] = []

  for (const root of ordered) {
    if (!existsSync(root.dir)) continue
    for (const packageRoot of packageDirectories(root.dir)) {
      const found = readPlugin(packageRoot, root.kind, frameworkVersion)
      if (!found) continue
      if ('failure' in found) failures.push(found.failure)
      else candidates.push(found.plugin)
    }
  }

  const winners = new Map<string, InstalledPlugin>()
  const conflicts = new Map<string, { winner: InstalledPlugin; losers: InstalledPlugin[] }>()

  for (const plugin of candidates) {
    const existing = winners.get(plugin.id)
    if (!existing) {
      winners.set(plugin.id, plugin)
      continue
    }
    // 排序保证 existing 来自更高优先级的根：保留它，只记录冲突。
    const conflict = conflicts.get(plugin.id) ?? { winner: existing, losers: [] }
    conflict.losers.push(plugin)
    conflicts.set(plugin.id, conflict)
  }

  for (const [id, { winner, losers }] of conflicts) {
    const ignored = losers
      .map((plugin) => `${ROOT_LABEL[plugin.rootKind]}（${plugin.root}）`)
      .join('、')
    failures.push({
      id,
      reason: `插件 id "${id}" 在多个根中重复：保留${ROOT_LABEL[winner.rootKind]}（${winner.root}），忽略${ignored}`,
    })
  }

  const plugins = [...winners.values()]
  const rootsById = new Map(plugins.map((plugin) => [plugin.id, plugin.root]))
  return { plugins, failures, roots: rootsById }
}

type ReadResult = { plugin: InstalledPlugin } | { failure: PluginFailure }

function readPlugin(
  root: string,
  rootKind: PluginRootKind,
  frameworkVersion: string,
): ReadResult | undefined {
  const manifestPath = join(root, 'plugin.json')
  if (!existsSync(manifestPath)) return undefined

  let manifest: PluginManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { failure: { id: root, reason: `plugin.json 解析失败: ${(error as Error).message}` } }
  }

  const id: unknown = manifest.id
  if (!isValidPluginId(id)) {
    return {
      failure: {
        id: typeof id === 'string' && id ? id : root,
        reason: `plugin.json 的 id 必须是 URL 安全段（不能为空、不能含 / 或 ..）: ${JSON.stringify(id)}`,
      },
    }
  }
  if (!manifest.server && !manifest.client) {
    return { failure: { id, reason: 'plugin.json 既没有 server 也没有 client 入口' } }
  }

  let packageJson: PackageJsonLike
  try {
    packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return { failure: { id, reason: '缺少或无法解析 package.json' } }
  }

  const reason = validatePeer(packageJson, frameworkVersion)
  if (reason) return { failure: { id, reason } }

  return {
    plugin: {
      id,
      packageName: packageJson.name ?? id,
      root,
      rootKind,
      manifest,
      packageJson,
    },
  }
}

/**
 * 一个根里的候选包目录。
 *
 * node_modules 的 `@scope/name` 是「一个包」，所以作用域目录要再展开一层；
 * 其他插件根（builtin/local/user）同样接受 `@scope/name` 布局，规则保持一致。
 * 点目录（.bin、.pnpm）一律跳过。
 */
function packageDirectories(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSafe(dir)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      const scopeDir = join(dir, entry)
      for (const scoped of readdirSafe(scopeDir)) {
        if (scoped.startsWith('.')) continue
        found.push(join(scopeDir, scoped))
      }
    } else {
      found.push(join(dir, entry))
    }
  }
  return found
}

/**
 * 插件 id 必须是单个 URL 安全路径段。
 *
 * 拒绝空串、`.`、`..`、斜杠、反斜杠、NUL 以及任何需要百分号编码的字符。
 * 这样 `pluginFileUrl` 编出来的 id 段和磁盘目录名一一对应，静态服务解码后
 * 查表不会出现歧义。
 */
export function isValidPluginId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length === 0) return false
  if (id === '.' || id === '..') return false
  if (id.includes('/') || id.includes('\\') || id.includes('\0')) return false
  return encodeURIComponent(id) === id
}

/**
 * 插件的启动期兼容性检查。
 *
 * 这三件事原先只在安装器里做，手工 `pnpm add` 或直接拷进 node_modules 的插件
 * 可以绕过。扫描时统一校验，失败只记录为这个插件的失败，不影响其他插件。
 */
export function validatePeer(
  packageJson: PackageJsonLike,
  frameworkVersion: string = FRAMEWORK_VERSION,
): string | undefined {
  const peers = packageJson.peerDependencies ?? {}

  const coreRange = peers[CORE_PACKAGE]
  if (!coreRange) {
    return `必须把 ${CORE_PACKAGE} 声明为 peerDependencies`
  }

  let coreSatisfied: boolean
  try {
    coreSatisfied = semver.satisfies(frameworkVersion, coreRange, { includePrerelease: true })
  } catch {
    return `无法解析插件声明的 ${CORE_PACKAGE} peer 范围: ${coreRange}`
  }
  if (!coreSatisfied) {
    return `插件要求 ${CORE_PACKAGE}@${coreRange}，当前框架版本是 ${frameworkVersion}`
  }

  for (const shared of SHARED_MODULES) {
    const range = peers[shared]
    if (!range) continue
    // 省略范围的模块（如 cordis-app/client）由框架直接提供，没有可比较的版本承诺
    const provided = SHARED_PEER_RANGES[shared]
    if (!provided) continue

    let compatible: boolean
    try {
      compatible = semver.intersects(range, provided, { includePrerelease: true })
    } catch {
      return `无法解析插件声明的 ${shared} peer 范围: ${range}`
    }
    if (!compatible) {
      return `插件要求 ${shared}@${range}，框架提供 ${provided}，两者不兼容`
    }
  }

  return undefined
}

/** 按插件 id 或包名查已安装条目。两个身份都接受，调用方不必知道自己拿的是哪个。 */
export function findPlugin(scan: PluginScan, idOrPackageName: string): InstalledPlugin | undefined {
  return (
    scan.plugins.find((plugin) => plugin.id === idOrPackageName) ??
    scan.plugins.find((plugin) => plugin.packageName === idOrPackageName)
  )
}

/**
 * 只读包名对应的插件 id，不做可加载性校验。
 *
 * 列表类场景（CLI `list`）要能展示「装了但清单不全」的插件，因此不能复用
 * scanPluginRoots 的严格过滤；但读 plugin.json 这件事仍然只在这里发生。
 */
export function readPluginId(nodeModulesDir: string, packageName: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(nodeModulesDir, packageName, 'plugin.json'), 'utf8'))
    return typeof manifest?.id === 'string' ? manifest.id : undefined
  } catch {
    return undefined
  }
}

/**
 * 包内文件 → 浏览器可访问的 URL。
 *
 * 挂载键是插件 id，不是磁盘相对路径：插件包放在 `@scope/name` 还是扁平目录，
 * URL 都只有 `/__plugins/<id>/...`。相对文件路径逐段编码，静态服务再解码。
 *
 * `version` 会作为查询参数附在 URL 后：生产构建传内容 hash，开发模式传时间戳，
 * 避免浏览器 ESM 缓存继续使用旧模块。查询串不参与静态服务的路径解析。
 */
export function pluginFileUrl(
  plugin: InstalledPlugin,
  filePath: string,
  version?: string | number,
): string {
  const relativeFile = relative(plugin.root, filePath)
  if (relativeFile === '' || relativeFile.startsWith('..') || isAbsolute(relativeFile)) {
    throw new Error(`插件资源必须位于插件根内: ${filePath}`)
  }
  const file = relativeFile.split(/[\\/]/).map(encodeURIComponent).join('/')
  const url = `${PLUGINS_PREFIX}/${encodeURIComponent(plugin.id)}/${file}`
  return version === undefined ? url : `${url}?v=${encodeURIComponent(String(version))}`
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
