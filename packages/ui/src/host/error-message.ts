/**
 * 把 hook 捕获到的错误变成一行可展示的文案。
 *
 * `HttpError` 的 message 来自服务端，已经是给人看的；其余错误保留原始消息，
 * 不吞成「操作失败」——项目界面需要知道到底哪里坏了。
 */

import { HttpError } from 'cordis-app/client'

export function describeError(error: unknown): string {
  return error instanceof HttpError ? error.message : String(error)
}
