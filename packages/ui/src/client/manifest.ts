/**
 * 插件清单拉取。
 *
 * 前端启动时拉一次，之后只在重连后重拉——清单是「启动时的事实」，
 * 运行中不会变（安装/卸载都会触发 worker 重启，页面随之重连）。
 */

import { MANIFEST_PATH, type ClientManifest } from '@cordis-app/protocol/client'
import type { HttpClient } from './types.js'

export interface ManifestError {
  id: string
  message: string
}

export async function fetchManifest(http: HttpClient): Promise<ClientManifest> {
  // 清单本身是数据（含插件的 data 字段），必须带 token，所以走封装而不是裸 fetch
  return http.get<ClientManifest>(MANIFEST_PATH, { retries: 3 })
}
