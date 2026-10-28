/**
 * static 内置插件：静态资源与插件前端资源分发。
 *
 * 路径前缀 `/__plugins/<plugin-id>/` 同时服务两件事：据此定位 node_modules 中的
 * 实际文件，以及让浏览器做缓存分区。卸载插件后该前缀返回 404，旧页面残留的
 * 请求不会打到别的插件上（架构文档 7.4）。
 */

import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, StaticService } from '@cordis-app/kernel'
import { PLUGINS_PREFIX } from '@cordis-app/protocol'
import { mimeType, safeJoin, sendError } from './http-utils.js'

export interface StaticOptions {
  /** 框架 UI 产物目录（resources/ui） */
  uiDir?: string
  /** 插件前端资源的根目录（通常为实例的 node_modules） */
  pluginsDir?: string
  /** 框架共享模块的产物目录 */
  sharedDir?: string
}

interface Mount {
  prefix: string
  directory: string
}

function serveFile(view: import('./server.js').RequestView, filePath: string): boolean {
  let stat
  try {
    stat = statSync(filePath)
  } catch {
    return false
  }
  if (!stat.isFile()) return false
  view.res.writeHead(200, {
    'content-type': mimeType(filePath),
    'content-length': stat.size,
    // 本地资源随版本变化，用 no-cache + ETag 之外的简法：不发强缓存
    'cache-control': 'no-cache',
  })
  if (view.method === 'HEAD') {
    view.res.end()
    return true
  }
  createReadStream(filePath).pipe(view.res)
  return true
}

// 依赖声明：cordis 在服务就绪前不会执行 apply，避免读到 undefined。
apply.inject = ['server', 'logger']

export function apply(ctx: KernelContext, config: StaticOptions) {
  const mounts: Mount[] = []
  const files = new Map<string, string>()

  const service: StaticService = {
    mount(prefix, directory) {
      const entry: Mount = { prefix, directory }
      mounts.push(entry)
      return () => {
        const i = mounts.indexOf(entry)
        if (i >= 0) mounts.splice(i, 1)
      }
    },
    file(path, filePath) {
      files.set(path, filePath)
      return () => {
        files.delete(path)
      }
    },
  }
  ctx.set('static', service)

  ctx.server.use(async (view, next) => {
    if (view.method !== 'GET' && view.method !== 'HEAD') return next()

    const exact = files.get(view.pathname)
    if (exact && serveFile(view, exact)) return

    // /__plugins/<id>/... → <pluginsDir>/<id>/<plugin.json 的 client 目录>/...
    if (config.pluginsDir && view.pathname.startsWith(PLUGINS_PREFIX + '/')) {
      const rest = view.pathname.slice(PLUGINS_PREFIX.length + 1)
      const target = safeJoin(config.pluginsDir, rest)
      if (target && serveFile(view, target)) return
      sendError(view.res, 404, 'not_found', '插件资源不存在')
      return
    }

    if (config.sharedDir && view.pathname.startsWith('/__shared/')) {
      const target = safeJoin(config.sharedDir, view.pathname.slice('/__shared/'.length))
      if (target && serveFile(view, target)) return
    }

    for (const mount of mounts) {
      if (!view.pathname.startsWith(mount.prefix)) continue
      const rest = view.pathname.slice(mount.prefix.length)
      const target = safeJoin(mount.directory, rest)
      if (target && serveFile(view, target)) return
    }

    // 框架 UI 产物：所有未命中其他规则的 GET 都回落到 index.html（SPA 路由）
    if (config.uiDir) {
      const target = safeJoin(config.uiDir, view.pathname)
      if (target && serveFile(view, target)) return
      if (!view.pathname.startsWith('/api/')) {
        const index = join(config.uiDir, 'index.html')
        if (serveFile(view, index)) return
      }
    }

    await next()
  })
}
