/**
 * 菜单项行为的唯一调用入口。
 *
 * Hook 与测试共用这一小段逻辑：它只接收调用方显式传入的上下文，不隐式读取
 * 全局菜单状态。菜单渲染器负责在关闭菜单前取出上下文；快捷键调用时上下文为空。
 */

import type { ClientRuntime } from './runtime.js'

export function invokeAction(runtime: ClientRuntime, id: string, context?: unknown): void {
  const action = runtime.registry.findAction(id)
  if (!action || action.disabled) return
  void Promise.resolve()
    .then(() => action.action(context))
    .catch((error) => console.error(`[cordis-app] 菜单项 ${id} 执行失败:`, error))
}
