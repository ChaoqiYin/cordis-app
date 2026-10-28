/**
 * auth 内置插件：token 与 Origin 校验。
 *
 * Origin 与 token 是互补关系：前者覆盖浏览器场景，后者覆盖脚本场景，缺一不可
 * （架构文档 9.2）。
 *
 * 免 token 的路径分两类：
 *   - `/__health`：文档明确要求的唯一免 token 的「端点」
 *   - 页面引导所需的静态资源：index.html、框架 UI 产物、插件前端资源
 *
 * 第二类是必要的补充：token 放在 URL fragment 中，浏览器导航时不会发给服务端，
 * 前端拿到页面、读出 token 之后才能第一次发出携带 token 的请求。若把静态资源
 * 也纳入 token 校验，浏览器模式将完全无法启动。
 */

import { timingSafeEqual } from 'node:crypto'
import { HEALTH_PATH, PLUGINS_PREFIX, SHARED_PREFIX } from '@cordis-app/protocol'
import type { AuthService, KernelContext } from '@cordis-app/kernel'
import type { RequestView } from './server.js'
import { sendError } from './http-utils.js'

export interface AuthOptions {
  token: string
  port: number
}

const BOOTSTRAP_PREFIXES = [SHARED_PREFIX, PLUGINS_PREFIX]

/**
 * 判断是否是「页面引导」请求，即前端拿到 token 之前必须成功的那一类。
 *
 * 规则分三种：
 *   1. `/api/*` —— 永远是数据请求，必须带 token
 *   2. `/__shared/*`、`/__plugins/*` —— 只有带扩展名的具体文件免 token；
 *      `/__plugins`（清单本身）含插件数据，仍需 token
 *   3. 其余 GET —— 视为页面导航。token 在 fragment 中不会发送给服务端，
 *      所以深链接（例如 `/theme#token=…`）必须在没有 token 时也能拿到 index.html，
 *      由前端读出 token 后再去请求数据。
 */
function isBootstrapAsset(view: RequestView): boolean {
  if (view.method !== 'GET' && view.method !== 'HEAD') return false
  if (view.pathname.startsWith('/api/')) return false
  if (view.pathname === '/') return true

  const hasExtension = /\.[a-z0-9]+$/i.test(view.pathname)
  if (BOOTSTRAP_PREFIXES.some((prefix) => view.pathname.startsWith(prefix))) {
    return hasExtension
  }
  return true
}

// 依赖声明：cordis 在服务就绪前不会执行 apply，避免读到 undefined。
apply.inject = ['server', 'logger']

export function apply(ctx: KernelContext, config: AuthOptions) {
  const token = config.token
  const allowedOrigins = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
  ])

  const expected = Buffer.from(token)

  const service: AuthService = {
    token,
    verify(candidate) {
      if (!candidate) return false
      const given = Buffer.from(candidate)
      // 长度不等时 timingSafeEqual 会抛错，先比长度
      if (given.length !== expected.length) return false
      return timingSafeEqual(given, expected)
    },
    isAllowedOrigin(origin) {
      if (!origin) return true
      return allowedOrigins.has(origin)
    },
  }
  ctx.set('auth', service)

  ctx.server.use(async (view, next) => {
    if (view.pathname === HEALTH_PATH) return next()
    if (isBootstrapAsset(view)) return next()

    const origin = view.req.headers.origin
    if (!service.isAllowedOrigin(origin)) {
      sendError(view.res, 403, 'bad_origin', '请求来源不在白名单内')
      return
    }

    const header = view.req.headers.authorization
    const fromHeader = header?.startsWith('Bearer ') ? header.slice(7) : undefined
    const fromQuery = view.url.searchParams.get('token') ?? undefined
    if (!service.verify(fromHeader ?? fromQuery)) {
      sendError(view.res, 401, 'unauthorized', '缺少或无效的会话 token')
      return
    }

    await next()
  })
}
