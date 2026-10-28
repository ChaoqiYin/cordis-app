/** 各进程之间流转的数据结构定义。 */

/** 单个插件加载失败的记录。 */
export interface PluginFailure {
  id: string
  reason: string
}

/**
 * supervisor 写到自己 stdout 的握手行载荷。
 *
 * 注意 `ready` 的定义：HTTP 已监听 **且** 插件已加载完毕。
 */
export interface HandshakeLine {
  ready: true
  /** 实际监听端口，外壳据此导航 */
  port: number
  /** 会话 token，API 与 WebSocket 均需携带 */
  token: string
  /** 框架版本，外壳据此判断兼容性 */
  version: string
  /** 加载失败的插件 */
  failures: PluginFailure[]
}

/** worker → supervisor 的 IPC 就绪消息。worker 的 stdout 被 supervisor 吞掉。 */
export interface WorkerReadyMessage {
  type: 'ready'
  port: number
  failures: PluginFailure[]
}

/** worker → supervisor 的 IPC 日志/状态消息（可选，仅用于日志转发标记）。 */
export interface WorkerLogMessage {
  type: 'log'
  level: 'debug' | 'info' | 'warn' | 'error'
  line: string
}

export type WorkerMessage = WorkerReadyMessage | WorkerLogMessage

/** supervisor 写入 `runtime.json` 的内容，供后来者「拉取」当前实例状态。 */
export interface RuntimeFile {
  port: number
  token: string
  pid: number
  version: string
  startedAt: string
}

/** app.json —— 用户编辑的唯一应用清单。 */
export interface AppManifest {
  name: string
  version: string
  icon?: string
  /** 框架版本范围，安装时校验兼容性 */
  framework: string
  /** 直接依赖：插件名 → 版本范围 */
  plugins: Record<string, string>
}

/** app.lock —— 解析结果，记录事实。 */
export interface AppLock {
  lockfileVersion: 1
  plugins: Record<string, LockedPlugin>
}

export interface LockedPlugin {
  version: string
  resolved: string
  integrity?: string
  dependencies?: Record<string, string>
}

/** plugin.json —— 插件通过它声明身份与能力。 */
export interface PluginManifest {
  /** 唯一标识，与 npm 包名分离 */
  id: string
  displayName?: string
  description?: string
  version?: string
  /** 服务端入口，可选 */
  server?: string
  /** 前端入口，可选 */
  client?: string
  /** 能力声明，仅用于安装 UI 展示，运行时不拦截 */
  capabilities?: PluginCapability[]
}

export type PluginCapability = 'fs:read' | 'fs:write' | 'net' | 'process' | 'storage'

/** 前端启动时拉取的插件清单。 */
export interface ClientManifest {
  version: string
  plugins: Record<string, ClientPluginEntry>
}

export interface ClientPluginEntry {
  id: string
  displayName?: string
  /** 入口 + 预加载清单，全部为同源绝对路径 */
  files: string[]
  /** 服务端在加载时导出的初始状态 */
  data?: unknown
}

/** 安装动作的结果，供 CLI 与 HTTP 共用。 */
export interface InstallResult {
  id: string
  /** 是否触发 worker 重启 */
  restarted: boolean
  reason: string
}

/** 统一错误载荷。 */
export interface ErrorPayload {
  code: string
  message: string
  detail?: string
}
