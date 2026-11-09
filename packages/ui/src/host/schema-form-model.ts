/**
 * SchemaForm 的纯数据逻辑。
 *
 * 单独成模块（不含 JSX）是为了让测试可以直接 import 源码，用纯函数覆盖
 * 初始值合成与草稿同步判定，不需要 DOM 环境。
 */

type UnknownRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 合成初始值：对象递归合并，数组与标量由配置值直接替换。
 *
 * 部分配置只提供部分嵌套字段时，缺失的嵌套字段仍保留 schema 默认值。
 */
export function mergeInitial(
  defaults: UnknownRecord,
  configured: UnknownRecord,
): UnknownRecord {
  const merged: UnknownRecord = { ...defaults }
  for (const [key, value] of Object.entries(configured)) {
    const previous = merged[key]
    merged[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? mergeInitial(previous, value)
        : value
  }
  return merged
}

/** 初始值的内容键：只比较内容，不比较对象身份。 */
export function contentKey(value: unknown): string {
  return JSON.stringify(value) ?? ''
}

/**
 * 草稿重置判定：只有初始值内容变化时才重置草稿。
 *
 * 父组件重渲染但配置内容不变时返回 false，保留用户正在输入的内容。
 */
export function shouldResetDraft(previousKey: string, nextKey: string): boolean {
  return previousKey !== nextKey
}

/** 显式支持的控件角色；未知 role 回退单行文本。 */
export type ControlRole = 'textarea' | 'color' | 'path' | 'text'

export function resolveRole(role: string | undefined): ControlRole {
  if (role === 'textarea' || role === 'color' || role === 'path') return role
  return 'text'
}
