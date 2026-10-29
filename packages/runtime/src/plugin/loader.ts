/**
 * 插件加载。
 *
 * 职责：
 *   1. 从实例的 node_modules 中找出所有声明了 plugin.json 的包
 *   2. 校验清单（入口存在、可解析）
 *   3. 逐个挂到 kernel 上，失败的记录下来但不影响其他插件
 *   4. 收集前端清单（files + 服务端导出的初始状态）
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Kernel, KernelContext, MountedPlugin } from '@cordis-app/kernel'
import {
  CORE_PACKAGE,
  PLUGINS_PREFIX,
  type ClientManifest,
  type ClientPluginEntry,
  type PluginFailure,
  type PluginManifest,
} from '@cordis-app/protocol'

export interface DiscoveredPlugin {
  /** plugin.json 里的 id */
  id: string
  /** npm 包名 */
  packageName: string
  /** 包根目录 */
  root: string
  manifest: PluginManifest
  packageJson: PackageJsonLike
}

export interface PackageJsonLike {
  name?: string
  version?: string
  main?: string
  module?: string
  exports?: unknown
  peerDependencies?: Record<string, string>
}

/**
 * 扫描 node_modules，找出声明了 plugin.json 的包。
 *
 * 只扫一层：插件的传递依赖不需要被框架挂载，它们由 require 自己解析。
 * 这也保证「装了多少个直接插件 = 挂载多少个」。
 */
export function discoverPlugins(nodeModulesDir: string): {
  plugins: DiscoveredPlugin[]
  failures: PluginFailure[]
} {
  const plugins: DiscoveredPlugin[] = []
  const failures: PluginFailure[] = []
  if (!existsSync(nodeModulesDir)) return { plugins, failures }

  for (const entry of readdirSafe(nodeModulesDir)) {
    // 跳过 .bin、.pnpm 之类的框架目录
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, entry)
      for (const scoped of readdirSafe(scopeDir)) {
        collect(join(scopeDir, scoped), plugins, failures)
      }
    } else {
      collect(join(nodeModulesDir, entry), plugins, failures)
    }
  }
  return { plugins, failures }
}

function collect(
  root: string,
  plugins: DiscoveredPlugin[],
  failures: PluginFailure[],
): void {
  const manifestPath = join(root, 'plugin.json')
  if (!existsSync(manifestPath)) return

  let manifest: PluginManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    failures.push({ id: root, reason: `plugin.json 解析失败: ${(error as Error).message}` })
    return
  }

  const id = manifest.id
  if (!id) {
    failures.push({ id: root, reason: 'plugin.json 缺少 id' })
    return
  }
  if (!manifest.server && !manifest.client) {
    failures.push({ id, reason: 'plugin.json 既没有 server 也没有 client 入口' })
    return
  }

  let packageJson: PackageJsonLike = {}
  try {
    packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    failures.push({ id, reason: '缺少或无法解析 package.json' })
    return
  }

  const reason = validatePeer(packageJson)
  if (reason) {
    failures.push({ id, reason })
    return
  }

  plugins.push({ id, packageName: packageJson.name ?? id, root, manifest, packageJson })
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

export type LoadResult = {
  mounted: Map<string, MountedPlugin>
  failures: PluginFailure[]
  /** 前端清单 */
  client: ClientManifest
  /** 服务端导出的初始状态，用于清单的 data 字段 */
  data: Map<string, unknown>
}

export async function loadPlugins(options: {
  kernel: Kernel
  nodeModulesDir: string
  version: string
  configFor(id: string): unknown
}): Promise<LoadResult> {
  const { plugins, failures } = discoverPlugins(options.nodeModulesDir)
  const mounted = new Map<string, MountedPlugin>()
  const data = new Map<string, unknown>()
  const entries: Record<string, ClientPluginEntry> = {}

  for (const plugin of plugins) {
    const id = plugin.id
    try {
      if (plugin.manifest.server) {
        const entry = resolveEntry(plugin, plugin.manifest.server)
        if (!entry) throw new Error(`服务端入口不存在: ${plugin.manifest.server}`)
        const mod = await import(pathToFileURL(entry).href)
        const definition = toDefinition(mod, id)
        const handle = options.kernel.plugin(definition, options.configFor(id))

        // 服务端可导出初始状态，随清单一起送达前端，省掉一次「我是谁」的请求
        if (mod.default?.data !== undefined) data.set(id, mod.default.data)
        if (mod.data !== undefined) data.set(id, mod.data)

        mounted.set(id, handle)
      }

      if (plugin.manifest.client) {
        const clientFile = resolveEntry(plugin, plugin.manifest.client)
        if (!clientFile) throw new Error(`前端入口不存在: ${plugin.manifest.client}`)
        entries[id] = {
          id,
          displayName: plugin.manifest.displayName ?? id,
          // files 是「入口 + 预加载清单」：入口先发，其余交给浏览器预取
          files: [toUrl(plugin.root, clientFile)],
          ...(data.has(id) ? { data: data.get(id) } : {}),
        }
      }
    } catch (error) {
      failures.push({ id, reason: (error as Error).message })
    }
  }

  return { mounted, failures, client: { version: options.version, plugins: entries }, data }
}

/** 把插件模块转成 cordis 认识的插件定义。 */
export function toDefinition(mod: any, fallbackName: string) {
  const candidate = mod.default ?? mod
  if (typeof candidate === 'function') {
    // `export function apply` 的写法：模块本身带 name/inject/Config
    return { ...(mod as object), name: (mod as any).name ?? fallbackName, apply: mod.apply ?? candidate } as any
  }
  if (candidate && typeof candidate.apply === 'function') {
    return { ...candidate, name: candidate.name ?? fallbackName }
  }
  if (typeof mod.apply === 'function') {
    return { ...mod, name: mod.name ?? fallbackName }
  }
  throw new Error('插件没有导出 apply 函数')
}

function resolveEntry(plugin: DiscoveredPlugin, relative: string): string | undefined {
  const path = resolve(plugin.root, relative)
  return existsSync(path) ? path : undefined
}

/** 包内文件 → 浏览器可访问的 URL。 */
export function toUrl(pluginRoot: string, filePath: string): string {
  const relative = filePath
    .slice(resolve(pluginRoot).length + 1)
    .split(/[\\/]/)
    .map(encodeURIComponent)
    .join('/')
  return `${PLUGINS_PREFIX}/${encodeURIComponent(basename(pluginRoot))}/${relative}`
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
