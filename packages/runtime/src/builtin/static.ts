/**
 * static 内置插件：静态资源与插件前端资源分发。
 *
 * 插件资源前缀 `/__plugins/<插件 id>/...` 先查 worker 启动时生成的 id→根映射，
 * 再在命中的插件根内安全解析剩余路径。URL 不直接对应磁盘布局：插件包放在
 * node_modules 的扁平目录、作用域目录，还是项目 plugins/ 下，URL 都只认 id。
 * 卸载插件后映射里没有这个 id，旧页面残留的请求不会打到别的插件上。
 */

import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import type { KernelContext, StaticService } from '@cordis-app/kernel'
import { PLUGINS_PREFIX, SHARED_PREFIX } from '@cordis-app/protocol'
import { mimeType, safeJoin, sendError } from './http-utils.js'

export interface StaticOptions {
  /** 框架 UI 产物目录（resources/ui） */
  uiDir?: string
  /** worker 扫描得到的 id → 插件根目录映射；静态服务不再自己扫描 */
  pluginRoots?: ReadonlyMap<string, string>
  /** 框架共享模块的产物目录 */
  sharedDir?: string
}

/**
 * 把 `/__plugins/<id>/<file>` 解析成插件根内的实际文件。
 *
 * 返回 undefined 表示「这个 URL 不归插件静态资源管」或「路径越界」。id 只用于
 * 查表，不参与路径拼接；文件路径交给 safeJoin，保留它对 `..` 与 NUL 的拦截。
 */
export function resolvePluginFile(
  pathname: string,
  roots: ReadonlyMap<string, string>,
): string | undefined {
  if (!pathname.startsWith(PLUGINS_PREFIX + '/')) return undefined

  const rest = pathname.slice(PLUGINS_PREFIX.length + 1)
  const slash = rest.indexOf('/')
  const rawId = slash === -1 ? rest : rest.slice(0, slash)

  let id: string
  try {
    id = decodeURIComponent(rawId)
  } catch {
    return undefined
  }
  if (!id || id.includes('\0')) return undefined

  const root = roots.get(id)
  if (!root) return undefined

  const filePath = slash === -1 ? '' : rest.slice(slash + 1)
  return safeJoin(root, filePath)
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

    // /__plugins/<插件 id>/... → id→root 映射 → safeJoin(root, 剩余路径)
    if (config.pluginRoots && view.pathname.startsWith(PLUGINS_PREFIX + '/')) {
      const target = resolvePluginFile(view.pathname, config.pluginRoots)
      if (target && serveFile(view, target)) return
      sendError(view.res, 404, 'not_found', '插件资源不存在')
      return
    }

    if (config.sharedDir && view.pathname.startsWith(SHARED_PREFIX + '/')) {
      const target = safeJoin(config.sharedDir, view.pathname.slice(SHARED_PREFIX.length + 1))
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
