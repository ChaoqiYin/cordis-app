/**
 * 插件清单的跨进程契约。
 *
 * `GET /api/plugins` 的响应同时被 worker、CLI 与设置页消费。视图字段、来源
 * 分类与用户可见标签只有这一份定义，避免三处各写一份字面量后漂移。
 */

import type { PluginFailure } from './types.js'

export type { PluginFailure }

/** 插件来自哪个扫描根。优先级见 runtime 的 catalog。 */
export type PluginRootKind = 'builtin' | 'local' | 'dependency' | 'user'

/** 插件来源对用户展示的三分类。 */
export type PluginOrigin = 'builtin' | 'local' | 'external'

/** 来源徽标文案。CLI 表格与设置页共用。 */
export const PLUGIN_ORIGIN_LABEL: Readonly<Record<PluginOrigin, string>> = {
  builtin: '随包',
  local: '项目本地',
  external: '外部',
}

/** 插件安装来源；卸载记录用它说明「能否按原来源重装」。 */
export type PluginSourceKind = 'npm' | 'bundle'

/**
 * 扫描视图里的一个插件。
 *
 * `reinstallable` 表示已卸载时能否通过「启用」恢复：物理存在且生命周期留下
 * 了卸载记录时为 true。
 */
export interface PluginEntryBase {
  id: string
  /** npm 包名；展示与卸载各自需要不同的身份，两个都交给前端。 */
  packageName?: string
  displayName: string
  version?: string
  rootKind: PluginRootKind
  origin: PluginOrigin
  enabled: boolean
  reinstallable: boolean
}

/** `GET /api/plugins` 的 `plugins` 条目：扫描视图加上前端文件清单。 */
export interface PluginEntry extends PluginEntryBase {
  files: string[]
}

/** `GET /api/plugins` 的 `uninstalled` 条目：扫描不到、但有卸载记录。 */
export interface UninstalledPluginEntry {
  id: string
  displayName?: string
  version?: string
  rootKind: PluginRootKind
  origin: PluginOrigin
  sourceKind?: PluginSourceKind
  packageName?: string
  spec?: string
  reinstallable: boolean
  uninstalledAt?: string
}

/** `GET /api/plugins` 的完整响应。 */
export interface PluginInventory {
  plugins: PluginEntry[]
  uninstalled: UninstalledPluginEntry[]
  failures: PluginFailure[]
}
