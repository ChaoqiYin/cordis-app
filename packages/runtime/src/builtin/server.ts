/**
 * server 内置插件：HTTP 服务、端口监听、就绪标志、中间件链。
 *
 * 「就绪」的定义是完整就绪：HTTP 已监听 **且** 插件已加载完。
 * 页面重连后立刻请求接口就不会打到未初始化的服务。
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { EXIT_PORT_IN_USE } from '@cordis-app/protocol'
import type { KernelContext, Middleware, RequestView, ServerService } from '@cordis-app/kernel'
import { sendError } from './http-utils.js'

export type { Middleware, RequestView }

export interface ServerOptions {
  port: number
  host?: string
}

// server 自己就是 server 服务的提供者，不能声明依赖它（会自锁）；只依赖日志。
apply.inject = ['logger']

export function apply(ctx: KernelContext, config: ServerOptions) {
  const middleware: Middleware[] = []
  let listening = false
  let healthy = false

  const server: Server = createServer((req, res) => {
    void handle(req, res)
  })

  async function handle(req: IncomingMessage, res: ServerResponse) {
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      sendError(res, 400, 'bad_request', '无法解析的请求 URL')
      return
    }
    const view: RequestView = {
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? 'GET',
    }

    let index = 0
    const next = async (): Promise<void> => {
      const fn = middleware[index++]
      if (!fn) {
        if (!res.headersSent) sendError(res, 404, 'not_found', `没有处理器匹配 ${view.pathname}`)
        return
      }
      await fn(view, next)
    }

    try {
      await next()
    } catch (error) {
      ctx.logger?.error('[server] 请求处理失败', error)
      if (!res.headersSent) sendError(res, 500, 'internal_error', '请求处理失败')
      else res.end()
    }
  }

  const service: ServerService & { use(fn: Middleware): () => void } = {
    server,
    get port() {
      return (server.address() as { port: number } | null)?.port ?? config.port
    },
    get listening() {
      return listening
    },
    get healthy() {
      return healthy
    },
    markReady() {
      healthy = true
    },
    use(fn) {
      middleware.push(fn)
      return () => {
        const i = middleware.indexOf(fn)
        if (i >= 0) middleware.splice(i, 1)
      }
    },
    close() {
      return new Promise((resolve) => {
        listening = false
        healthy = false
        // 不能靠 `server.listening` 短路：listen() 的回调是异步的，在它之前
        // 这个标志仍是 false，此时提前返回会把监听一直留在那儿，进程不退出。
        // 交给 close 的回调判断是否重复关闭即可。
        server.closeAllConnections?.()
        server.close((error) => {
          // ERR_SERVER_NOT_RUNNING 是重复关闭，不算失败
          if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
            ctx.logger?.warn('[server] 关闭监听时出错', error)
          }
          resolve()
        })
      })
    },
  }

  ctx.set('server', service)
  // 中间件从内置插件开始注册，因此必须在 set 之前把 this 上的注册顺序固定下来
  ctx.effect(() => () => {
    void service.close().catch(() => {})
  })

  const host = config.host ?? '127.0.0.1'
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      // 只允许首次启动时换端口；重启阶段 supervisor 会把 76 当致命错误。
      process.exit(EXIT_PORT_IN_USE)
    }
    ctx.logger?.error('[server] 监听失败', error)
    process.exit(1)
  })

  server.listen(config.port, host, () => {
    listening = true
    ctx.logger?.info(`[server] 监听 http://${host}:${service.port}`)
  })

  ctx.effect(() => () => {
    if (listening) {
      listening = false
      server.closeAllConnections?.()
    }
  })
}
