/** 内置插件在插件作者侧可见的服务类型。 */

import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { LoggerFactory } from './logger.js'
import type { ConfigStore } from './config.js'

/** 路由处理器：极薄的 req/res，避免把框架锁死在某一个 HTTP 框架上。 */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>

/** 请求视图。HTTP 中间件与路由共用，避免各插件自己再拆一遍 URL。 */
export interface RequestView {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  pathname: string
  method: string
}

export type Middleware = (view: RequestView, next: () => Promise<void>) => void | Promise<void>

/** server 内置插件注册的服务。 */
export interface ServerService {
  readonly server: Server
  readonly port: number
  readonly listening: boolean
  /** 健康检查：HTTP 已监听且插件已加载完成 */
  readonly healthy: boolean
  /** 标记插件加载完成（由 runtime 在 ready 后调用） */
  markReady(): void
  /** 关闭监听（仍保持现有连接），用于重启流程 */
  close(): Promise<void>
  /** 注册中间件。顺序即调用顺序。返回撤销函数。 */
  use(middleware: Middleware): () => void
}

/** router 内置插件注册的服务。 */
export interface RouterService {
  get(path: string, handler: RouteHandler): () => void
  post(path: string, handler: RouteHandler): () => void
  put(path: string, handler: RouteHandler): () => void
  patch(path: string, handler: RouteHandler): () => void
  delete(path: string, handler: RouteHandler): () => void
  all(path: string, handler: RouteHandler): () => void
}

/** static 内置插件注册的服务。用于挂载额外的静态资源。 */
export interface StaticService {
  /** 把一个 URL 前缀映射到一个本地目录。返回撤销函数。 */
  mount(prefix: string, directory: string): () => void
  /** 直接把一个文件暴露到某个 URL 路径。 */
  file(path: string, filePath: string): () => void
}

export interface BroadcastMessage {
  type: string
  data?: unknown
}

/** ws 内置插件注册的服务。 */
export interface WebSocketService {
  broadcast(channel: string, message: BroadcastMessage): void
  broadcastAll(message: BroadcastMessage): void
  on(channel: string, handler: (message: BroadcastMessage) => void): () => void
  readonly size: number
}

/** auth 内置插件注册的服务。 */
export interface AuthService {
  verify(token: string | undefined): boolean
  readonly token: string
  isAllowedOrigin(origin: string | undefined): boolean
}

/** storage 内置插件注册的服务：插件数据目录的受管读写。 */
export interface StorageService {
  dir(pluginId: string): string
  read(pluginId: string, file: string): Promise<Buffer | undefined>
  write(pluginId: string, file: string, data: string | Uint8Array): Promise<void>
  remove(pluginId: string, file: string): Promise<void>
  list(pluginId: string): Promise<string[]>
}

/** 框架暴露给插件的最小面：日志、配置、生命周期、事件。 */
export interface CoreServices {
  logger: LoggerFactory
  config: ConfigStore
}

declare module './kernel.js' {
  interface KernelContext {
    server: ServerService
    router: RouterService
    static: StaticService
    ws: WebSocketService
    auth: AuthService
    storage: StorageService
    logger: LoggerFactory
    config: ConfigStore
    effect<T>(callback: (ctx: this) => T | (() => void)): T
  }
}
