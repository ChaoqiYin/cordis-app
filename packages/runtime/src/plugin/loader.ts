/**
 * 插件加载。
 *
 * 身份与清单校验交给 catalog（loader 不再自己判断「谁是插件」），
 * 这里只负责：
 *   1. 逐个把服务端入口挂到 kernel 上，失败的记录但不影响其他插件
 *   2. 收集前端清单（files + 服务端导出的初始状态）
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Kernel, MountedPlugin } from '@cordis-app/kernel'
import {
  UI_CONTRACT_VERSION,
  type ClientManifest,
  type ClientPluginEntry,
  type PluginFailure,
  type UiCapabilities,
} from '@cordis-app/protocol'
import { pluginFileUrl, type InstalledPlugin, type PluginScan } from './catalog.js'

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
  /** worker 启动时扫描一次的结果；loader 不再自己扫描 */
  scan: PluginScan
  version: string
  /** app.json.ui：body 声明的 UI 能力 */
  ui?: UiCapabilities
  /** app.json.plugins：启用顺序。未列出的插件保持扫描顺序，仍然启用。 */
  order?: string[]
  configFor(id: string): unknown
}): Promise<LoadResult> {
  const failures: PluginFailure[] = [...options.scan.failures]
  const mounted = new Map<string, MountedPlugin>()
  const data = new Map<string, unknown>()
  const entries: Record<string, ClientPluginEntry> = {}

  for (const plugin of orderPlugins(options.scan.plugins, options.order)) {
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
          files: [pluginFileUrl(plugin, clientFile)],
          ...(plugin.manifest.ui ? { ui: plugin.manifest.ui } : {}),
          ...(data.has(id) ? { data: data.get(id) } : {}),
        }
      }
    } catch (error) {
      failures.push({ id, reason: (error as Error).message })
    }
  }

  return {
    mounted,
    failures,
    client: {
      version: options.version,
      uiContractVersion: UI_CONTRACT_VERSION,
      ...(options.ui ? { ui: options.ui } : {}),
      plugins: entries,
      failures,
    },
    data,
  }
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

/** 按 app.json.plugins 的启用顺序排列；未列出的插件排在后面。 */
function orderPlugins(plugins: InstalledPlugin[], order?: string[]): InstalledPlugin[] {
  if (!order || order.length === 0) return plugins
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...plugins].sort(
    (a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
  )
}

function resolveEntry(plugin: InstalledPlugin, relative: string): string | undefined {
  const path = resolve(plugin.root, relative)
  return existsSync(path) ? path : undefined
}
