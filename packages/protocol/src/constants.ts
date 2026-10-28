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
export const ENV_DATA = 'CORDIS_APP_DATA'
export const ENV_RESOURCES = 'CORDIS_APP_RESOURCES'
export const ENV_HANDSHAKE_PIPE = 'CORDIS_APP_HANDSHAKE'

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

/** 前端运行时与插件共同依赖的共享白名单。 */
export const SHARED_MODULES = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'cordis-app/client',
] as const

export type SharedModule = (typeof SHARED_MODULES)[number]

/** 共享模块在浏览器里的实际路径。 */
export const SHARED_MODULE_URLS: Record<SharedModule, string> = {
  'react': `${SHARED_PREFIX}/react.js`,
  'react-dom': `${SHARED_PREFIX}/react-dom.js`,
  'react-dom/client': `${SHARED_PREFIX}/react-dom-client.js`,
  'react/jsx-runtime': `${SHARED_PREFIX}/jsx-runtime.js`,
  'cordis-app/client': `${SHARED_PREFIX}/client.js`,
}

/** 安装阶段必须强制校验的核心包 peer 版本范围。 */
export const CORE_PACKAGE = 'cordis-app'

/** 会话 token 在 URL 中承载的 fragment 键。 */
export const TOKEN_FRAGMENT_KEY = 'token'
