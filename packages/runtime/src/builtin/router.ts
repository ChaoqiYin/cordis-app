/**
 * router 内置插件：极薄的 radix 风格路由。
 *
 * 刻意不引入 Express / Koa：框架要保证「替换 HTTP 框架」这件事不被锁死在核心里，
 * 而插件作者看到的是 `ctx.router.get(path, handler)` 这一个动作。
 * 路径参数用 `:name` 表示，够用且没有学习成本。
 */

import type { RouteHandler, RouterService, KernelContext } from '@cordis-app/kernel'
import type { RequestView } from './server.js'

interface Route {
  method: string
  segments: Segment[]
  handler: RouteHandler
}

type Segment = { type: 'static'; value: string } | { type: 'param'; name: string }

function compile(path: string): Segment[] {
  return path
    .split('/')
    .filter((part, index, all) => part !== '' || index === 0 || index === all.length - 1)
    .filter((part) => part !== '')
    .map((part) => (part.startsWith(':') ? { type: 'param' as const, name: part.slice(1) } : { type: 'static' as const, value: part }))
}

function matchSegments(route: Segment[], parts: string[]): Record<string, string> | undefined {
  if (route.length !== parts.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < route.length; i++) {
    const segment = route[i]!
    if (segment.type === 'static') {
      if (segment.value !== parts[i]) return undefined
    } else {
      // 参数匹配到空段没有意义，视为不匹配
      if (!parts[i]) return undefined
      params[segment.name] = decodeURIComponent(parts[i]!)
    }
  }
  return params
}

// 依赖声明：cordis 在服务就绪前不会执行 apply，避免读到 undefined。
apply.inject = ['server']

export function apply(ctx: KernelContext) {
  const routes: Route[] = []

  const add = (method: string, path: string, handler: RouteHandler) => {
    const route: Route = { method, segments: compile(path), handler }
    routes.push(route)
    return () => {
      const index = routes.indexOf(route)
      if (index >= 0) routes.splice(index, 1)
    }
  }

  const router: RouterService & { dispatch(request: RequestLike): Promise<boolean> } = {
    get: (path, handler) => add('GET', path, handler),
    post: (path, handler) => add('POST', path, handler),
    put: (path, handler) => add('PUT', path, handler),
    patch: (path, handler) => add('PATCH', path, handler),
    delete: (path, handler) => add('DELETE', path, handler),
    all: (path, handler) => add('*', path, handler),

    /** 由 server 插件在 HTTP 请求到达时调用。返回是否命中。 */
    async dispatch(request) {
      const parts = request.pathname.split('/').filter(Boolean)
      for (const route of routes) {
        if (route.method !== '*' && route.method !== request.method) continue
        const params = matchSegments(route.segments, parts)
        if (!params) continue
        await route.handler(request.req, request.res, params)
        return true
      }
      return false
    },
  }

  ctx.set('router', router)

  // 中间件按注册顺序执行，所以 router 必须在 set 之后立刻接入，
  // 保证它排在 auth 之后、static 之前：先鉴权，再匹配路由，最后才轮到静态回落。
  ctx.effect(() =>
    ctx.server.use(async (view, next) => {
      const handled = await router.dispatch(view)
      if (!handled) await next()
    }),
  )
}

/** server 插件交给 router 的请求视图。 */
export interface RequestLike {
  method: string
  pathname: string
  req: import('node:http').IncomingMessage
  res: import('node:http').ServerResponse
}
