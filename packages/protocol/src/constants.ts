/**
 * 协议常量。外壳、supervisor、worker、CLI、前端五方共享。
 *
 * 任何跨进程的字面量都必须来自这里，避免「三处各写一份字符串」的漂移。
 */

/** 握手行的行首标记。supervisor 写到自己的 stdout，外壳与 CLI 只认这一行。 */
export const HANDSHAKE_PREFIX = '@@CORDIS_APP@@'

/** worker 退出码：请求重启（token / 端口不变） */
export const EXIT_RESTART = 75

/** worker 退出码：端口被占用。只允许出现在首次启动。 */
export const EXIT_PORT_IN_USE = 76

/** supervisor 换端口重试的最大次数 */
export const MAX_PORT_RETRIES = 5

/** supervisor 注入 worker 的环境变量名 */
export const ENV_PORT = 'CORDIS_APP_PORT'
export const ENV_TOKEN = 'CORDIS_APP_TOKEN'
/** supervisor 注入 worker 的项目根 */
export const ENV_PROJECT = 'CORDIS_APP_PROJECT'
export const ENV_RESOURCES = 'CORDIS_APP_RESOURCES'
export const ENV_HANDSHAKE_PIPE = 'CORDIS_APP_HANDSHAKE'

/**
 * supervisor 注入 worker 的框架版本。
 *
 * 版本只有 `FRAMEWORK_VERSION` 一个真源；supervisor 把它随环境传下去，
 * worker 的 manifest、健康检查与安装期 peer 校验都用这同一个值。
 */
export const ENV_VERSION = 'CORDIS_APP_VERSION'

/** 免 token 的健康检查端点 */
export const HEALTH_PATH = '/__health'

/** 前端共享模块的挂载前缀 */
export const SHARED_PREFIX = '/__shared'

/** 插件前端资源的路径前缀 */
export const PLUGINS_PREFIX = '/__plugins'

/** 插件背板上报与前端拉取的清单端点 */
export const MANIFEST_PATH = '/__plugins'

/** worker 关闭监听前向所有 WebSocket 客户端广播的事件名。前端据此进入等待态。 */
export const RECONNECT_EVENT = 'server:reconnect'

/** 前端建立 WebSocket 连接的路径。upgrade 本身不校验路径，这里只用于语义清晰。 */
export const WS_PATH = '/__ws'

/**
 * 单个共享模块的完整定义。
 *
 * 这张表是「哪些模块由框架提供」的唯一真源：浏览器路径、构建入口、peer 版本
 * 范围都从它派生。宿主构建、import map、插件打包预设、安装期 peer 校验各自
 * 需要其中一部分，但没有第二份答案。
 */
export interface SharedModuleDefinition {
  /** 浏览器里的产物文件名。 */
  readonly file: string
  /** 构建入口：裸模块名，或 UI 包内的源文件路径。 */
  readonly entry: string
  /** 构建时需要标为 external 的其它共享模块。 */
  readonly externals: readonly string[]
  /** 框架提供的版本范围；省略表示框架共享该模块但不承诺具体版本。 */
  readonly peerRange?: string
}

/**
 * 前端运行时与插件共同依赖的共享白名单。
 *
 * 顺序即 import map 的生成顺序；新增模块只需在这张表里加一行。
 */
const SHARED_MODULE_DEFINITIONS = {
  'react': {
    file: 'react.js',
    entry: 'react',
    externals: [],
    peerRange: '^19.0.0',
  },
  'react-dom': {
    file: 'react-dom.js',
    entry: 'react-dom',
    externals: ['react'],
    peerRange: '^19.0.0',
  },
  'react-dom/client': {
    file: 'react-dom-client.js',
    entry: 'react-dom/client',
    externals: ['react', 'react-dom'],
  },
  'react/jsx-runtime': {
    file: 'jsx-runtime.js',
    entry: 'react/jsx-runtime',
    externals: ['react'],
  },
  'cordis-app/client': {
    file: 'client.js',
    entry: 'src/client/index.ts',
    externals: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  },
} as const satisfies Record<string, SharedModuleDefinition>

export type SharedModule = keyof typeof SHARED_MODULE_DEFINITIONS

/**
 * 对外暴露的表。
 *
 * 值统一成 `SharedModuleDefinition`：`as const` 的联合类型里，没写 `peerRange`
 * 的成员不存在该属性，直接下标访问会被拒绝。键保留字面量类型，值的形状放宽
 * 到接口——这正是调用方需要的视图。
 */
export const SHARED_MODULE_TABLE: Record<SharedModule, SharedModuleDefinition> =
  SHARED_MODULE_DEFINITIONS

/** 共享模块的说明符列表。 */
export const SHARED_MODULES = Object.keys(SHARED_MODULE_TABLE) as SharedModule[]

/** 共享模块在浏览器里的实际路径。 */
export const SHARED_MODULE_URLS = Object.fromEntries(
  SHARED_MODULES.map((name) => [name, `${SHARED_PREFIX}/${SHARED_MODULE_TABLE[name].file}`]),
) as Record<SharedModule, string>

/**
 * 框架实际提供的共享模块版本范围。
 *
 * 安装阶段用它与插件的 peerDependencies 求交集：没有交集就硬失败，而不是把
 * 问题留到运行时的 invalid hook call。与实际前端产物不一致时，这里就是唯一
 * 需要改的地方。
 */
export const SHARED_PEER_RANGES = Object.fromEntries(
  SHARED_MODULES.flatMap((name) => {
    const range = SHARED_MODULE_TABLE[name].peerRange
    return range ? [[name, range]] : []
  }),
) as Partial<Record<SharedModule, string>>

/** 安装阶段必须强制校验的核心包 peer 版本范围。 */
export const CORE_PACKAGE = 'cordis-app'

/** 会话 token 在 URL 中承载的 fragment 键。 */
export const TOKEN_FRAGMENT_KEY = 'token'
