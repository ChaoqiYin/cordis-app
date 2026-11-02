/**
 * body UI 能力与插件 UI 需求的匹配。
 *
 * 这是协议层的纯函数：安装器判断 `uiCompatibility`、前端加载插件时打告警，
 * 都从这里取同一个结论。它不读 DOM，也不依赖运行环境。
 */

import type {
  PluginUiRequirements,
  UiCapabilities,
  UiCompatibility,
} from './types.js'

/** 匹配结果。`missing` 是缺失出口的稳定标识，可直接用于日志与安装结果。 */
export interface UiCapabilityMatch {
  compatibility: UiCompatibility
  /**
   * 缺失项，形如 `pages`、`settings`、`slot:header.right`、`menu:activity`。
   * 顺序固定为 pages → slots → menus → settings。
   */
  missing: string[]
}

/**
 * 比对插件需求与 body 能力。
 *
 * 插件需求是 partial：没写的出口表示不关心，不会产生缺失项。
 */
export function matchUiCapabilities(
  requirements: PluginUiRequirements | undefined,
  capabilities: UiCapabilities | undefined,
): UiCapabilityMatch {
  const wanted: string[] = []
  if (requirements?.pages === true) wanted.push('pages')
  for (const name of unique(requirements?.slots)) wanted.push(`slot:${name}`)
  for (const name of unique(requirements?.menus)) wanted.push(`menu:${name}`)
  if (requirements?.settings === true) wanted.push('settings')

  if (wanted.length === 0) return { compatibility: 'full', missing: [] }

  // body 没有声明能力：无法证明任何一个出口存在。服务端仍可加载，
  // 但 UI 侧没有任何可用出口，交给调用方按 incompatible 处理。
  if (!capabilities) return { compatibility: 'incompatible', missing: wanted }

  const available = new Set<string>()
  if (capabilities.pages === true) available.add('pages')
  for (const name of unique(capabilities.slots)) available.add(`slot:${name}`)
  for (const name of unique(capabilities.menus)) available.add(`menu:${name}`)
  if (capabilities.settings === true) available.add('settings')

  const missing = wanted.filter((item) => !available.has(item))
  return {
    compatibility: missing.length === 0 ? 'full' : 'backend-only',
    missing,
  }
}

function unique(values: string[] | undefined): string[] {
  return values ? [...new Set(values)] : []
}
