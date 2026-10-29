/**
 * 顶层必须是对象的 JSON 读取。
 *
 * app.json、plugin.json、package.json 这类「配置对象」的读取语义应该只有
 * 一份：缺失/损坏时是「没有配置」还是「硬失败」由调用方决定，但解析与
 * 「顶层必须是对象」的判断不该各写一遍。
 */

import { existsSync, readFileSync } from 'node:fs'

/**
 * 读取并解析 JSON 对象。
 *
 * - 文件不存在、内容不是合法 JSON、顶层不是对象，都返回 undefined。
 *   调用方据此采用缺省行为（例如没有 app.json 时「发现即启用」）。
 */
export function readOptionalObjectJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as T
  } catch {
    return undefined
  }
}

/**
 * 读取并解析 JSON 对象；任何问题都抛出带标签的错误。
 *
 * 用在「缺少这份文件就说明插件包无效」的场景（例如 bundle 解压后的
 * plugin.json / package.json）：静默返回 undefined 会把安装失败伪装成
 * 一个没有入口的空插件。
 */
export function readObjectJson<T>(path: string, label: string): T {
  if (!existsSync(path)) throw new Error(`缺少 ${label}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 的顶层必须是对象`)
  }
  return parsed as T
}
