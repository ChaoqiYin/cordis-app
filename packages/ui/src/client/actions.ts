/**
 * 行为执行的唯一入口。
 *
 * 菜单渲染器与快捷键共用这一小段逻辑：它只接收调用方显式传入的上下文，
 * 不隐式读取全局菜单状态。菜单渲染器负责在关闭菜单前取出上下文；
 * 快捷键调用时上下文为空。
 */

import type { ClientRuntime } from './runtime.js'
import type { RegisteredAction } from './types.js'

/**
 * 执行一个已注册行为。
 *
 * 返回行为是否可执行：`disabled` 时返回 false，调用方据此决定是否
 * `preventDefault()`。Promise 拒绝统一走 console.error，避免未处理的拒绝逃逸。
 */
export function runAction(action: RegisteredAction, context?: unknown): boolean {
  if (action.disabled) return false
  void Promise.resolve()
    .then(() => action.action(context))
    .catch((error) => console.error(`[cordis-app] 行为 ${action.id} 执行失败:`, error))
  return true
}

export function invokeAction(runtime: ClientRuntime, id: string, context?: unknown): void {
  const action = runtime.registry.findAction(id)
  if (!action) return
  runAction(action, context)
}
