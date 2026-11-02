/**
 * 插件 UI 兼容性告警。
 *
 * 匹配本身在 `@cordis-app/protocol`；这里只负责把缺失项变成用户能看懂的一行
 * 日志。能力缺失永远不阻断服务端加载，也不阻止插件前端入口执行。
 */

import {
  UI_CONTRACT_VERSION,
  matchUiCapabilities,
  type PluginUiRequirements,
  type UiCapabilities,
  type UiCapabilityMatch,
} from '@cordis-app/protocol/client'

/** 比对并告警；返回匹配结果，调用方可继续用于安装/展示。 */
export function warnUiCompatibility(
  pluginId: string,
  requirements: PluginUiRequirements | undefined,
  capabilities: UiCapabilities | undefined,
): UiCapabilityMatch {
  const match = matchUiCapabilities(requirements, capabilities)
  if (match.compatibility !== 'full') {
    console.warn(
      `[cordis-app] 插件 ${pluginId} 的 UI 需求未被当前 body 满足：缺少 ${match.missing.join('、')}；服务端插件仍会加载。`,
    )
  }
  return match
}

/** uiContractVersion 不一致时告警；返回是否兼容。 */
export function warnUiContractVersion(version: number | undefined): boolean {
  if (version === UI_CONTRACT_VERSION) return true
  console.warn(
    `[cordis-app] UI 契约版本不匹配：插件清单为 ${version ?? '未声明'}，当前宿主支持 ${UI_CONTRACT_VERSION}。`,
  )
  return false
}
