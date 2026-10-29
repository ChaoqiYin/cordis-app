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
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  CORE_PACKAGE,
  PLUGINS_PREFIX,
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

/** 一个已安装、清单合法的插件。id 与包名是两套身份，这里都保留。 */
export interface InstalledPlugin {
  /** plugin.json 里的 id */
  id: string
  /** npm 包名 */
  packageName: string
  /** 包根目录 */
  root: string
  /**
   * 包在 node_modules 下的相对路径，如 `demo` 或 `@scope/demo`。
   * 它同时是 `/__plugins/<mountPath>/` 的挂载点——用目录而不是 id，
   * 因为静态文件服务是按磁盘布局寻址的。
   */
  mountPath: string
  manifest: PluginManifest
  packageJson: PackageJsonLike
}

export interface PluginScan {
  plugins: InstalledPlugin[]
  /** 清单非法、peer 缺失等「这个包是插件但不能用」的记录 */
  failures: PluginFailure[]
}

/**
 * 扫描 node_modules 一层，找出声明了 plugin.json 的包。
 *
 * 只扫一层：插件的传递依赖不需要被框架挂载，它们由 require 自己解析。
 * 这也保证「装了多少个直接插件 = 挂载多少个」。
 */
export function scanPlugins(nodeModulesDir: string): PluginScan {
  const plugins: InstalledPlugin[] = []
  const failures: PluginFailure[] = []
  if (!existsSync(nodeModulesDir)) return { plugins, failures }

  const collect = (root: string): void => {
    const found = readPlugin(root, nodeModulesDir)
    if (!found) return
    if ('failure' in found) {
      failures.push(found.failure)
      return
    }
    plugins.push(found.plugin)
  }

  for (const entry of readdirSafe(nodeModulesDir)) {
    // 跳过 .bin、.pnpm 之类的框架目录
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, entry)
      for (const scoped of readdirSafe(scopeDir)) collect(join(scopeDir, scoped))
    } else {
      collect(join(nodeModulesDir, entry))
    }
  }
  return { plugins, failures }
}

type ReadResult = { plugin: InstalledPlugin } | { failure: PluginFailure }

function readPlugin(root: string, nodeModulesDir: string): ReadResult | undefined {
  const manifestPath = join(root, 'plugin.json')
  if (!existsSync(manifestPath)) return undefined

  let manifest: PluginManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { failure: { id: root, reason: `plugin.json 解析失败: ${(error as Error).message}` } }
  }

  const id = manifest.id
  if (!id) return { failure: { id: root, reason: 'plugin.json 缺少 id' } }
  if (!manifest.server && !manifest.client) {
    return { failure: { id, reason: 'plugin.json 既没有 server 也没有 client 入口' } }
  }

  let packageJson: PackageJsonLike
  try {
    packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return { failure: { id, reason: '缺少或无法解析 package.json' } }
  }

  const reason = validatePeer(packageJson)
  if (reason) return { failure: { id, reason } }

  return {
    plugin: {
      id,
      packageName: packageJson.name ?? id,
      root,
      mountPath: relative(nodeModulesDir, root).split(/[\\/]/).join('/'),
      manifest,
      packageJson,
    },
  }
}

/**
 * 核心包必须声明为 peerDependencies。
 *
 * 框架核心包持有服务注册表与事件总线，出现第二份会导致插件各自正常、
 * 彼此失联——这是最难排查的一类问题，所以在安装/加载时强制校验。
 */
export function validatePeer(packageJson: PackageJsonLike): string | undefined {
  const peers = packageJson.peerDependencies ?? {}
  if (!(CORE_PACKAGE in peers)) {
    return `必须把 ${CORE_PACKAGE} 声明为 peerDependencies`
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
 * scanPlugins 的严格过滤；但读 plugin.json 这件事仍然只在这里发生。
 */
export function readPluginId(nodeModulesDir: string, packageName: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(nodeModulesDir, packageName, 'plugin.json'), 'utf8'))
    return typeof manifest?.id === 'string' ? manifest.id : undefined
  } catch {
    return undefined
  }
}

/** 包内文件 → 浏览器可访问的 URL。按包目录挂载，作用域包不会退化成裸名。 */
export function pluginFileUrl(plugin: InstalledPlugin, filePath: string): string {
  const relativeFile = relative(plugin.root, filePath)
    .split(/[\\/]/)
    .map(encodePathSegment)
    .join('/')
  const mount = plugin.mountPath.split('/').map(encodePathSegment).join('/')
  return `${PLUGINS_PREFIX}/${mount}/${relativeFile}`
}

/**
 * 目录名 → URL 片段。
 *
 * `@` 必须保留字面量：静态资源 middleware 直接拿 `url.pathname` 去拼磁盘路径，
 * 不做事后解码；把它编码成 `%40` 会让作用域插件全部 404。
 */
function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%40/g, '@')
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
