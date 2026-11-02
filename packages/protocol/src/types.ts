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

/** body 声明自己实际提供的 UI 能力。 */
export interface UiCapabilities {
  pages: boolean
  slots: string[]
  menus: string[]
  settings: boolean
}

/**
 * 插件在 `plugin.json` 里声明的 UI 需求。
 *
 * 是 `UiCapabilities` 的 partial：插件只写自己依赖的出口，未写的表示不关心。
 * #4 只负责把这份声明带到前端清单，#5 才做 body 能力匹配。
 */
export type PluginUiRequirements = Partial<UiCapabilities>

/**
 * 插件 UI 需求与 body 能力的匹配分级。
 *
 * - `full`：插件声明的每个出口都能被 body 提供。
 * - `backend-only`：body 已声明能力，但缺少部分出口；插件服务端仍可加载。
 * - `incompatible`：body 完全没有声明能力，有 UI 需求的插件没有一个出口可用。
 */
export type UiCompatibility = 'full' | 'backend-only' | 'incompatible'

/**
 * app.json —— 用户编辑的唯一应用清单。
 *
 * 不保存框架版本与插件版本范围：依赖的唯一真源是项目 `package.json`。
 */
export interface AppManifest {
  name: string
  version: string
  icon?: string
  /**
   * 启用顺序，按插件 id 记录。
   * 缺省或为空表示「发现即启用」；未列出的已发现插件默认仍然启用。
   */
  plugins?: string[]
  /** 项目 body 提供的 UI 能力；由 #5 的宿主契约消费 */
  ui?: UiCapabilities
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
  /** UI 出口需求；只做声明，v1 不因此阻断服务端加载 */
  ui?: PluginUiRequirements
  /** 能力声明，仅用于安装 UI 展示，运行时不拦截 */
  capabilities?: PluginCapability[]
}

export type PluginCapability = 'fs:read' | 'fs:write' | 'net' | 'process' | 'storage'

/** 前端启动时拉取的插件清单。 */
export interface ClientManifest {
  version: string
  /** body 宿主契约版本，插件/市场据此判断 UI 兼容性 */
  uiContractVersion: number
  /** body 声明的能力，来自 app.json.ui */
  ui?: UiCapabilities
  plugins: Record<string, ClientPluginEntry>
  /** 扫描、doctor 与加载阶段的失败记录；前端无需再额外请求 */
  failures?: PluginFailure[]
}

export interface ClientPluginEntry {
  id: string
  displayName?: string
  /** 入口 + 预加载清单，全部为同源绝对路径 */
  files: string[]
  /** 插件声明的 UI 出口需求 */
  ui?: PluginUiRequirements
  /** 服务端在加载时导出的初始状态 */
  data?: unknown
}

/** 安装动作的结果，供 CLI 与 HTTP 共用。 */
export interface InstallResult {
  id: string
  /** 已安装的插件版本；来源能确定时填写 */
  version?: string
  /** 是否触发 worker 重启 */
  restarted: boolean
  reason: string
  /**
   * 插件 UI 需求与当前 body 能力的匹配结果。
   *
   * 由安装器用 `matchUiCapabilities` 计算；缺失能力只影响 UI 可用性，
   * 不代表安装失败。字段暂时可选，安装器（#6）开始填充后即可视为必填。
   */
  uiCompatibility?: UiCompatibility
}

/** 统一错误载荷。 */
export interface ErrorPayload {
  code: string
  message: string
  detail?: string
}
