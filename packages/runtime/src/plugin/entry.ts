/**
 * 插件入口扩展名校验。
 *
 * 运行时只加载 JavaScript：`dev` / `build` 负责把 TS/TSX 源入口编译成 `.js`
 * 并改写产物清单，`start` 只读构建产物；`run` 不编译，因此源码根里的 TS
 * 入口必须在这里明确失败。扫描、加载与两种安装来源共用同一段说明。
 */

import { PLUGIN_ENTRY_EXTENSIONS, hasPluginEntryExtension } from '@cordis-app/protocol'

export type PluginEntryKind = 'server' | 'client'

/** 返回入口不合法的可读原因；合法时返回 undefined。 */
export function pluginEntryProblem(kind: PluginEntryKind, entry: string): string | undefined {
  if (hasPluginEntryExtension(entry)) return undefined

  const label = kind === 'server' ? '服务端' : '前端'
  return (
    `${label}入口不是 JavaScript：${entry}。` +
    'dev / build 会编译 TS/TSX 并改写产物清单；' +
    `run 不编译，请使用 dev / build，或提供已构建的 ${PLUGIN_ENTRY_EXTENSIONS.join(' / ')} 入口。`
  )
}

/** 入口不合法时抛出带下一步说明的错误。 */
export function assertPluginEntry(kind: PluginEntryKind, entry: string): void {
  const problem = pluginEntryProblem(kind, entry)
  if (problem) throw new Error(problem)
}
