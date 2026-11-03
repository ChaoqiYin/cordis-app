/**
 * 原生能力契约：worker 与 Go 外壳之间的命令、错误码与传输 envelope。
 *
 * 这里是两侧唯一的字符串与类型真源。命令名是「系统资源.动作」，一个命令对应
 * 一个系统原语；命令表与权限模型见 ADR 0003。本文件是纯类型与常量层，不引入
 * 任何运行时依赖。
 *
 * 有意不进入 `client.ts`：页面不直连外壳，原生契约只属于 worker 与外壳。
 */

/** 原生能力契约版本。worker 启动时与 `/info` 比对，不匹配则关闭原生能力。 */
export const NATIVE_CONTRACT_VERSION = 1

/** 外壳注入 supervisor、再由 supervisor 转发给 worker 的原生端点。 */
export const ENV_NATIVE_URL = 'CORDIS_APP_NATIVE_URL'

/** 外壳生成的回环原生服务凭据；worker 创建 client 后立即从环境删除。 */
export const ENV_NATIVE_TOKEN = 'CORDIS_APP_NATIVE_TOKEN'

/**
 * v1 命令表。
 *
 * 顺序与 ADR 0003 一致。新增或修改命令需要提升 `NATIVE_CONTRACT_VERSION`，
 * 因为外壳的 `/info.commands` 与 worker 的类型面都以此为准。
 */
export const NATIVE_COMMANDS = [
  'path.chooseOpen',
  'path.chooseDirectory',
  'path.chooseSave',
  'window.setTitle',
  'window.setSize',
  'window.minimize',
  'window.maximize',
  'window.restore',
  'window.focus',
  'window.close',
  'window.state',
  'notification.show',
  'shell.openExternal',
  'shell.openPath',
  'shell.showItemInFolder',
  'system.info',
] as const

/** 原生命令名。按 command 索引即可得到对应的输入/输出类型。 */
export type NativeCommand = (typeof NATIVE_COMMANDS)[number]

/**
 * 固定的业务错误码。
 *
 * HTTP 4xx/5xx 只表示 transport 或鉴权失败；业务结果（包括用户取消）一律走
 * 这些错误码，调用方不需要解析 HTTP 状态。
 */
export const NATIVE_ERROR_CODES = [
  'cancelled',
  'unsupported',
  'denied',
  'busy',
  'invalid',
  'timeout',
  'internal',
] as const

export type NativeErrorCode = (typeof NATIVE_ERROR_CODES)[number]

/** 无输入/无返回的命令使用空对象，与 ADR 命令表的 `{}` 一致。 */
export type NativeEmptyInput = Record<string, never>
export type NativeEmptyResult = Record<string, never>

/**
 * 路径选择过滤项。
 *
 * `extensions` 不含点（`csv` 而不是 `.csv`）；`*` 表示所有文件。
 */
export interface NativePathFilter {
  name: string
  extensions: string[]
}

export interface NativePathChooseOpenInput {
  multiple?: boolean
  filters?: NativePathFilter[]
  title?: string
  defaultPath?: string
}

export interface NativePathChooseOpenOutput {
  paths: string[]
}

export interface NativePathChooseDirectoryInput {
  multiple?: boolean
  title?: string
  defaultPath?: string
}

export interface NativePathChooseDirectoryOutput {
  paths: string[]
}

export interface NativePathChooseSaveInput {
  filters?: NativePathFilter[]
  defaultName?: string
  title?: string
  defaultPath?: string
}

export interface NativePathChooseSaveOutput {
  path: string
}

export interface NativeWindowSetTitleInput {
  title: string
}

export interface NativeWindowSetSizeInput {
  width: number
  height: number
}

export interface NativeWindowSize {
  width: number
  height: number
}

export interface NativeWindowState {
  maximized: boolean
  minimized: boolean
  focused: boolean
  size: NativeWindowSize
}

export interface NativeNotificationShowInput {
  title: string
  body: string
}

export interface NativeShellOpenExternalInput {
  url: string
}

/** 用系统默认应用打开本地路径；path 必须是绝对路径且存在。 */
export interface NativeShellOpenPathInput {
  path: string
}

export interface NativeShellShowItemInFolderInput {
  path: string
}

/** 系统外观；无法探测时外壳返回 `unknown`，不猜一个错误主题。 */
export type NativeTheme = 'light' | 'dark' | 'unknown'

export interface NativeSystemInfo {
  platform: string
  arch: string
  release: string
  theme: NativeTheme
  hasWindow: boolean
}

/**
 * 命令名 → 输入/输出形状的映射。
 *
 * 调用方写 `NativeInput<'window.setSize'>` 就能得到该命令的参数类型；新增命令
 * 必须同时补进 `NATIVE_COMMANDS` 与这里，两者由类型测试保证一致。
 */
export interface NativeCommandMap {
  'path.chooseOpen': {
    input: NativePathChooseOpenInput
    output: NativePathChooseOpenOutput
  }
  'path.chooseDirectory': {
    input: NativePathChooseDirectoryInput
    output: NativePathChooseDirectoryOutput
  }
  'path.chooseSave': {
    input: NativePathChooseSaveInput
    output: NativePathChooseSaveOutput
  }
  'window.setTitle': {
    input: NativeWindowSetTitleInput
    output: NativeEmptyResult
  }
  'window.setSize': {
    input: NativeWindowSetSizeInput
    output: NativeEmptyResult
  }
  'window.minimize': {
    input: NativeEmptyInput
    output: NativeEmptyResult
  }
  'window.maximize': {
    input: NativeEmptyInput
    output: NativeEmptyResult
  }
  'window.restore': {
    input: NativeEmptyInput
    output: NativeEmptyResult
  }
  'window.focus': {
    input: NativeEmptyInput
    output: NativeEmptyResult
  }
  'window.close': {
    input: NativeEmptyInput
    output: NativeEmptyResult
  }
  'window.state': {
    input: NativeEmptyInput
    output: NativeWindowState
  }
  'notification.show': {
    input: NativeNotificationShowInput
    output: NativeEmptyResult
  }
  'shell.openExternal': {
    input: NativeShellOpenExternalInput
    output: NativeEmptyResult
  }
  'shell.openPath': {
    input: NativeShellOpenPathInput
    output: NativeEmptyResult
  }
  'shell.showItemInFolder': {
    input: NativeShellShowItemInFolderInput
    output: NativeEmptyResult
  }
  'system.info': {
    input: NativeEmptyInput
    output: NativeSystemInfo
  }
}

export type NativeInput<C extends NativeCommand> = NativeCommandMap[C]['input']
export type NativeOutput<C extends NativeCommand> = NativeCommandMap[C]['output']

/** `POST /invoke` 的请求体：command 是判别键，input 随命令变化。 */
export type NativeInvokeRequest = {
  [C in NativeCommand]: {
    command: C
    input: NativeInput<C>
  }
}[NativeCommand]

/** 成功 envelope。`value` 的形状由调用方按命令名收窄。 */
export interface NativeSuccess<T = unknown> {
  ok: true
  value: T
}

/**
 * 失败 envelope。
 *
 * `message` 是给人看的补充说明；程序判断一律用 `code`。`platform` 只在
 * `unsupported` 时用于说明是哪个平台缺少能力。
 */
export interface NativeFailure {
  ok: false
  code: NativeErrorCode
  message?: string
  platform?: string
}

/** `POST /invoke` 的响应体。业务结果（含用户取消）一律是 HTTP 200 + envelope。 */
export type NativeInvokeResponse = NativeSuccess | NativeFailure

/** 按命令名收窄的成功结果，便于调用方直接拿到输出类型。 */
export type NativeResult<C extends NativeCommand> = NativeSuccess<NativeOutput<C>> | NativeFailure

/** `GET /info` 的响应：worker 启动时读取一次并缓存。 */
export interface NativeInfo {
  /** 外壳报告的契约版本；worker 与 `NATIVE_CONTRACT_VERSION` 比对，不匹配就降级。 */
  contractVersion: number
  /** 平台标识，由外壳报告（Go 的 `runtime.GOOS`，如 `darwin`、`windows`）。 */
  platform: string
  /** CPU 架构，由外壳报告（Go 的 `runtime.GOARCH`，如 `arm64`、`amd64`）。 */
  arch: string
  hasWindow: boolean
  /** 当前平台真正可用的命令；Linux 缺失外部工具时对应命令不会出现。 */
  commands: NativeCommand[]
}
