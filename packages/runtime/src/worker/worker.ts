/**
 * worker —— 承载一切的那一层。
 *
 * 启动顺序是有讲究的：
 *   1. 建内核，注册日志与配置（它们无法由插件提供——插件自己就依赖它们）
 *   2. 挂内置插件：server → auth → router → static → ws → storage
 *   3. 调用项目后端入口 `server/index.js` 的 apply(ctx)
 *   4. 挂应用插件（按 app.json.plugins 的启用顺序）
 *   5. 全部就绪后标记 healthy，再通过 IPC 报告就绪
 *
 * 项目入口排在第 3 步而不是当成插件：它不是可安装/卸载的包，没有 plugin.json，
 * 但它的路由必须先于应用插件注册，才能让插件复用或覆盖项目自己的约定。
 * 第 5 步的顺序保证握手回传的是「完整就绪」而不是「HTTP 起来了」。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { KeyObject } from 'node:crypto'
import { createKernel, createLoggerFactory, ConfigStore, type KernelContext } from '@cordis-app/kernel'
import {
  ENV_APP_JSON,
  ENV_BUNDLE_PUBLIC_KEY,
  ENV_DEV,
  ENV_LOCAL_PLUGINS,
  ENV_MODE,
  ENV_NATIVE_TOKEN,
  ENV_NATIVE_URL,
  ENV_PORT,
  ENV_PROJECT,
  ENV_RESOURCES,
  ENV_SERVER_ENTRY,
  ENV_TOKEN,
  ENV_USER_PLUGINS,
  ENV_VERSION,
  EXIT_RESTART,
  FRAMEWORK_VERSION,
  HEALTH_PATH,
  MANIFEST_PATH,
  RECONNECT_EVENT,
  UI_CONTRACT_VERSION,
  parseRuntimeMode,
  resolveProjectLayout,
  type AppManifest,
  type ClientManifest,
  type PluginFailure,
  type RuntimeMode,
  type WorkerMessage,
} from '@cordis-app/protocol'
import * as builtin from '../builtin/index.js'
import { PluginInstaller } from '../plugin/installer.js'
import { BundleInstallSource } from '../plugin/bundle-source.js'
import { loadProjectPluginSource, resolvePluginSourcePath } from '../plugin/project-source.js'
import { loadPlugins } from '../plugin/loader.js'
import { scanPluginRoots, type PluginRoot } from '../plugin/catalog.js'
import { PluginStateStore, planPluginViews } from '../plugin/plugin-state.js'
import { checkProjectFrameworkFile } from '../plugin/doctor.js'
import { sendJson } from '../builtin/http-utils.js'
import { installRoutes } from './api.js'
import { readOptionalObjectJson } from '../json.js'
import { createNativeServices } from '../native/service.js'
import type { NativeClientOptions } from '../native/client.js'

/** 打包形态的 bundle 安装配置；只由进程配置注入，不接受 HTTP 请求覆盖。 */
export interface WorkerBundleOptions {
  /** 可信 Ed25519 公钥；缺省读 `CORDIS_APP_BUNDLE_PUBLIC_KEY` */
  publicKey?: string | Buffer | KeyObject
  /** 读取插件包归档；缺省只接受本地文件路径 */
  readArchive?: (spec: string) => Promise<Uint8Array>
}

/**
 * 原生能力的传输端点。
 *
 * 正常路径由 supervisor 通过环境变量注入；测试与嵌入方可以直接传入。
 * 缺省表示没有外壳（浏览器模式、`cordis-app run`），`ctx.native` 降级为不可用。
 */
export type WorkerNativeOptions = NativeClientOptions

export interface WorkerOptions {
  port: number
  token: string
  /** 项目根。所有路径都从它推导。 */
  projectRoot: string
  resourcesDir?: string
  /** 覆盖项目 server 入口；缺省为 `<project>/server/index.js` */
  serverEntry?: string
  /**
   * 覆盖应用清单路径。
   *
   * `cordis-app start` 指向 `dist/app.json`：启用顺序、UI 能力与安装期兼容性
   * 都读同一份清单，不能混用源码根里的旧文件。
   */
  appJson?: string
  /** 覆盖项目本地插件根；`dev` 指向现场构建的 `.cordis/dev/plugins` */
  localPluginsDir?: string
  /** 开发模式：插件前端 URL 使用时间戳而不是内容 hash */
  dev?: boolean
  /** 打包形态的只读内置插件根；缺省时从 `resourcesDir/plugins` 推导 */
  builtinPluginsDir?: string
  /** 打包形态的可写用户插件根；项目模式通常没有 */
  userPluginsDir?: string
  /**
   * 运行形态。项目模式（缺省）用 npm 安装；打包模式只接受签名插件包。
   * 这是进程配置，不接受 HTTP 请求切换。
   */
  mode?: RuntimeMode
  /** bundle 安装配置 */
  bundle?: WorkerBundleOptions
  /**
   * 覆盖项目模式下的包管理器执行器。只由进程配置注入，供测试与嵌入方使用；
   * HTTP 请求不能设置它，否则调用方就能指定任意命令。
   */
  packageManager?: (command: string, args: string[], cwd: string) => Promise<void>
  /**
   * 覆盖重启请求。只由进程配置注入，供测试使用，避免测试进程被 `exit(75)`
   * 终止；HTTP 请求不能设置它。
   */
  requestRestart?: () => void
  /**
   * 原生传输端点。supervisor 从环境变量读取后注入；直接调用 `startWorker`
   * 时可由测试或嵌入方提供。缺省时 `ctx.native.available` 为 false。
   */
  native?: WorkerNativeOptions
  /**
   * 框架版本。supervisor 通过环境注入；直接调用 startWorker 时缺省取
   * `FRAMEWORK_VERSION`（同样来自聚合包 package.json 的构建期生成）。
   */
  version?: string
}

export interface WorkerHandle {
  /** 当前前端清单 */
  manifest: ClientManifest
  failures: PluginFailure[]
  port: number
  /** 本轮运行实际使用的安装来源；项目模式为 npm，打包模式为 bundle */
  sourceKind: 'npm' | 'bundle'
  /** 优雅重启：关监听 → 通知客户端 → dispose → exit(75) */
  restart(): Promise<never>
  /** 测试用：直接关闭 */
  close(): Promise<void>
}

/** 从环境变量读取 worker 配置。缺一不可，缺失说明不是由 supervisor 拉起的。 */
export function readWorkerOptions(env: NodeJS.ProcessEnv = process.env): WorkerOptions {
  const port = Number(env[ENV_PORT])
  const token = env[ENV_TOKEN] ?? ''
  const projectRoot = env[ENV_PROJECT] ?? ''
  if (!port || !token || !projectRoot) {
    throw new Error('worker 必须由 supervisor 拉起（缺少端口 / token / 项目根环境变量）')
  }
  const rawMode = env[ENV_MODE]
  const mode = parseRuntimeMode(rawMode)
  // 原生 token 只属于 worker：读进 options 后立刻从环境删除，插件无法再抢读。
  // 缺失任一项都视为没有外壳，交给 ctx.native 统一降级。
  const nativeUrl = env[ENV_NATIVE_URL]
  const nativeToken = env[ENV_NATIVE_TOKEN]
  delete env[ENV_NATIVE_URL]
  delete env[ENV_NATIVE_TOKEN]
  return {
    port,
    token,
    projectRoot,
    ...(nativeUrl && nativeToken ? { native: { url: nativeUrl, token: nativeToken } } : {}),
    resourcesDir: env[ENV_RESOURCES],
    ...(env[ENV_SERVER_ENTRY] ? { serverEntry: env[ENV_SERVER_ENTRY] } : {}),
    ...(env[ENV_APP_JSON] ? { appJson: env[ENV_APP_JSON] } : {}),
    ...(env[ENV_LOCAL_PLUGINS] ? { localPluginsDir: env[ENV_LOCAL_PLUGINS] } : {}),
    ...(env[ENV_USER_PLUGINS] ? { userPluginsDir: env[ENV_USER_PLUGINS] } : {}),
    ...(mode ? { mode } : {}),
    ...(env[ENV_DEV] === '1' ? { dev: true } : {}),
    version: env[ENV_VERSION] ?? FRAMEWORK_VERSION,
  }
}

export async function startWorker(options: WorkerOptions): Promise<WorkerHandle> {
  const layout = resolveProjectLayout(options.projectRoot, {
    ...(options.builtinPluginsDir ? { builtinPluginsDir: options.builtinPluginsDir } : {}),
    ...(options.userPluginsDir ? { userPluginsDir: options.userPluginsDir } : {}),
    ...(options.localPluginsDir ? { localPluginsDir: options.localPluginsDir } : {}),
  })
  const logger = createLoggerFactory({ level: 'info' })
  const frameworkVersion = options.version ?? FRAMEWORK_VERSION

  // 运行形态决定安装来源：项目模式跑 npm，打包应用只接受签名插件包。
  // 来源是进程配置，HTTP 请求不能切换它，也不能指定任意下载地址。
  const packaged = options.mode === 'packaged'

  const builtinPluginsDir =
    options.builtinPluginsDir ??
    (options.resourcesDir ? join(options.resourcesDir, 'plugins') : undefined)
  const userPluginsDir = options.userPluginsDir ?? layout.userPluginsDir
  const userDataDir = userPluginsDir ? dirname(userPluginsDir) : undefined
  // 应用清单只有一份：显式覆盖时（`cordis-app start`）就是 dist/app.json，
  // 启用顺序、UI 能力与安装期兼容性全部从它读取。
  const appJsonPath = options.appJson ?? layout.appJson
  // 插件来源也在同一份清单里，提前读一次供安装器与插件加载共用。
  const app = readAppManifest(appJsonPath)
  // 打包形态的 local 根是「项目源码插件」，产物已经进了 resources/plugins；
  // 再扫项目根只会让同一批插件以「内置 + 本地」重复出现。只有显式传入时
  // 才启用 local 根（例如测试或特殊部署），项目模式保持原有默认。
  const localPluginsDir = options.localPluginsDir ?? (packaged ? undefined : layout.localPluginsDir)

  if (packaged && !userDataDir) {
    throw new Error('打包模式必须提供 userPluginsDir（可写用户插件根）')
  }

  // 项目可以在 app.json.pluginSource 里声明自己的获取逻辑。显式传入的
  // `bundle.readArchive`（嵌入方或测试）优先；都没有时才回退到默认实现。
  // 来源模块在 worker 启动时加载，构建漏产物或导出写错要在这里失败，
  // 而不是等到用户点安装时才发现。
  let projectReadArchive: ((spec: string) => Promise<Uint8Array>) | undefined
  if (packaged && userDataDir && !options.bundle?.readArchive && app?.pluginSource !== undefined) {
    if (typeof app.pluginSource !== 'string') {
      throw new Error('app.json.pluginSource 必须是字符串')
    }
    const sourcePath = resolvePluginSourcePath(appJsonPath, app.pluginSource)
    const readArchive = await loadProjectPluginSource(sourcePath)
    projectReadArchive = (spec) =>
      readArchive(spec, {
        projectRoot: layout.projectRoot,
        appJsonPath,
        userDataDir,
        frameworkVersion,
      })
  }

  const bundleSource = packaged && userDataDir
    ? new BundleInstallSource({
        userDataDir,
        frameworkVersion,
        appJsonPath,
        ...(options.bundle?.publicKey ?? process.env[ENV_BUNDLE_PUBLIC_KEY]
          ? { publicKey: options.bundle?.publicKey ?? process.env[ENV_BUNDLE_PUBLIC_KEY]! }
          : {}),
        ...(options.bundle?.readArchive
          ? { readArchive: options.bundle.readArchive }
          : projectReadArchive
            ? { readArchive: projectReadArchive }
            : {}),
      })
    : undefined

  const installer = new PluginInstaller({
    projectRoot: layout.projectRoot,
    frameworkVersion,
    ...(bundleSource ? { source: bundleSource } : {}),
    ...(options.packageManager ? { run: options.packageManager } : {}),
    // 项目模式的事务日志属于项目 `.cordis/`；打包模式的项目根可能只读，
    // 日志必须和 bundle 的事实文件一起放在用户数据目录。
    ...(packaged && userDataDir
      ? { journalPath: join(userDataDir, '.cordis', 'install-journal.json') }
      : {}),
  })

  // 项目可能刚被 `new` 出来，运行时目录还没建齐。
  for (const dir of [layout.cordisDir, layout.tmpDir, layout.logsDir, layout.dataDir]) {
    mkdirSync(dir, { recursive: true })
  }

  // 上次安装/卸载若被中途打断，先还原磁盘再加载插件：否则会按「装了一半」
  // 的 node_modules 启动，用户看到的是插件莫名消失或版本倒退。
  try {
    const recovered = await installer.recover()
    if (recovered) {
      logger.warn(`检测到中断的${recovered.action === 'install' ? '安装' : '卸载'}（${recovered.spec}），已回滚`)
    }
  } catch (error) {
    logger.error('恢复中断的安装事务失败，node_modules 可能不一致:', error)
  }

  // 启动 doctor（项目侧）：依赖存在但不兼容是硬错误；只是没声明则警告。
  // 必须在监听端口之前完成，避免失败后留下一个半启动的 worker。
  //
  // 打包形态没有 npm 安装：产物来自 `dist/` 或桌面释放目录，依赖已在构建期
  // 自包含（ADR 0001），项目根往往只是桌面数据目录，根本不存在可供校验的
  // `package.json`。对它做项目侧检查只会把「部署目录不是 npm 项目」误报成问题。
  if (!packaged) {
    const projectCheck = checkProjectFrameworkFile(layout.packageJson, frameworkVersion)
    if (projectCheck.missing) {
      logger.warn(projectCheck.reason ?? '项目没有声明 cordis-app 依赖')
    } else if (!projectCheck.ok) {
      throw new Error(projectCheck.reason ?? '项目 cordis-app 依赖与当前框架版本不兼容')
    }
  }

  // 插件根按优先级扫描一次。打包形态只认「内置 + 用户」：依赖根属于项目
  // 源码的安装方式，打包应用不应因为可执行目录旁边恰好有 node_modules 就
  // 加载未经签名校验的插件；显式传入的 localPluginsDir 仍然生效。
  const pluginRoots: PluginRoot[] = [
    ...(builtinPluginsDir ? [{ kind: 'builtin' as const, dir: builtinPluginsDir }] : []),
    ...(localPluginsDir ? [{ kind: 'local' as const, dir: localPluginsDir }] : []),
    ...(packaged ? [] : [{ kind: 'dependency' as const, dir: layout.nodeModulesDir }]),
    ...(userPluginsDir ? [{ kind: 'user' as const, dir: userPluginsDir }] : []),
  ]
  const scan = scanPluginRoots(pluginRoots, { frameworkVersion })

  // 两状态模型：完整扫描视图供 API 展示，启用视图供 loader、前端清单与静态
  // 资源使用。状态每次启动从磁盘读取；安装/卸载后由 supervisor 重启 worker，
  // 因此这里不需要在内存里维护第二份真相。
  const pluginState = new PluginStateStore({
    mode: packaged ? 'packaged' : 'project',
    projectRoot: layout.projectRoot,
    appJsonPath,
    ...(packaged && userDataDir ? { userDataDir } : {}),
  })
  const views = planPluginViews(scan, pluginState.read())

  const config = new ConfigStore({ filePath: layout.config })
  const kernel = createKernel({ logger: logger('kernel') })
  const ctx = kernel.context as KernelContext

  // 内核只提供日志、配置、生命周期、事件；其余全部是可替换的内置插件。
  ctx.set('logger', logger)
  ctx.set('config', config)

  // 原生服务必须在项目入口之前挂到根 ctx：项目 server 的 apply(ctx) 一执行
  // 就能用。`/info` 不可达或契约不匹配只让服务降级，不阻止 worker 启动。
  // 同一个 client 同时服务项目（全量）与插件（按 plugin.json 受限的视图）。
  const native = await createNativeServices({
    ...(options.native ? { client: options.native } : {}),
    logger: logger('native'),
  })
  kernel.service('native', () => native.project)

  const failures: PluginFailure[] = []
  let manifest: ClientManifest = {
    version: frameworkVersion,
    uiContractVersion: UI_CONTRACT_VERSION,
    plugins: {},
    failures: [],
  }

  // 内置插件顺序即中间件顺序：auth 必须排在 router / static 之前。
  kernel.plugin(builtin.server, { port: options.port })
  kernel.plugin(builtin.auth, { token: options.token, port: options.port })
  kernel.plugin(builtin.router, {})
  kernel.plugin(builtin.static, {
    uiDir: options.resourcesDir ? join(options.resourcesDir, 'ui') : undefined,
    sharedDir: options.resourcesDir ? join(options.resourcesDir, 'shared') : undefined,
    // 静态资源只认启用视图：已卸载插件的 id 不在映射里，自然 404。
    pluginRoots: views.enabledRoots,
  })
  kernel.plugin(builtin.ws, {})
  kernel.plugin(builtin.storage, { root: layout.dataDir })

  await kernel.ready()

  // 项目后端入口固定为 server/index.js（`start` 可覆盖为构建产物）：
  // 内置插件之后、应用插件之前。
  try {
    await applyProjectServer(ctx, options.serverEntry ?? layout.serverEntry)
  } catch (error) {
    // 内置插件已经启动监听。启动失败必须把 socket 关掉，否则调用方拿到
    // 拒绝后进程仍然活着，测试与 supervisor 都会被一个「失败的 worker」拖住。
    await ctx.server.close().catch(() => {})
    kernel.dispose()
    throw error
  }

  // 应用插件：使用启动时那一次扫描结果，再按 app.json 的启用顺序逐个挂载。
  // 失败不阻断其他插件。
  const enabledOrder = Array.isArray(app?.plugins)
    ? app.plugins.filter((id): id is string => typeof id === 'string')
    : undefined
  const loaded = await loadPlugins({
    kernel,
    // loader 只接收启用视图：已卸载插件既不挂载服务端路由，也不进前端清单。
    scan: views.enabledScan,
    version: manifest.version,
    ...(options.dev ? { dev: true } : {}),
    ...(app?.ui ? { ui: app.ui } : {}),
    ...(enabledOrder ? { order: enabledOrder } : {}),
    nativeForPlugin: (id, capabilities) => native.forPlugin(id, capabilities),
    configFor: (id) => config.get(id) ?? {},
  })
  failures.push(...loaded.failures)
  manifest = { ...loaded.client, failures }

  // 配置变更 → 按新配置重载该插件。
  //
  // 只重启一个插件，不重启 worker：其他插件的状态、页面的 WebSocket 都不受影响。
  // 这也是为什么设置面板逐个插件保存，而不是整份配置一起提交。
  config.onChange((id, value) => {
    const handle = loaded.mounted.get(id)
    if (!handle) return
    logger.info(`配置已变更，重载插件 ${id}`)
    try {
      handle.restart(value)
    } catch (error) {
      logger.error(`插件 ${id} 按新配置重载失败:`, error)
    }
  })

  await kernel.ready()

  // 健康检查与清单端点：/__health 免 token，只回 200 与版本，不泄露任何状态。
  ctx.router.get(HEALTH_PATH, (_req, res) => {
    sendJson(res, 200, { ok: true, version: manifest.version })
  })
  ctx.router.get(MANIFEST_PATH, (_req, res) => {
    sendJson(res, 200, manifest)
  })

  installRoutes(ctx, {
    kernel,
    projectRoot: layout.projectRoot,
    dataDir: layout.dataDir,
    installer,
    config,
    getManifest: () => manifest,
    setManifest: (next) => (manifest = next),
    scan: () => scanPluginRoots(pluginRoots, { frameworkVersion }),
    state: pluginState,
    failures,
    requestRestart: options.requestRestart ?? (() => setTimeout(() => void restart(), 50)),
  })

  // 完整就绪：HTTP 已监听且全部插件加载完成，才标记 healthy。
  ctx.server.markReady()
  // 分成两个数：只贡献服务端能力的插件不在前端清单里，合并成一个数会让人
  // 以为「装了插件但没挂上」
  logger.info(
    `就绪：${loaded.mounted.size} 个插件已挂载（其中 ${Object.keys(manifest.plugins).length} 个有前端入口），${failures.length} 个失败`,
  )

  const report = (message: WorkerMessage) => {
    process.send?.(message)
  }
  report({ type: 'ready', port: ctx.server.port, failures })

  const restart = async (): Promise<never> => {
    logger.info('开始重启：关闭监听并通知客户端')
    // 1. 先通知客户端即将重连——它需要收到「请等待」才能进入等待态而不是当成掉线
    ctx.ws.broadcastAll({ type: RECONNECT_EVENT })
    // 2. 释放全部内置插件。ws 在释放时断开已升级的 socket，否则 server.close()
    //    会一直等那些连接——重启就卡死在这里。
    const server = ctx.server
    kernel.dispose()
    // 3. 确认监听已关闭，再交给 supervisor
    await server.close().catch(() => {})
    process.exit(EXIT_RESTART)
  }

  const sigterm = () => {
    void restart()
  }
  process.on('SIGTERM', sigterm)

  return {
    manifest,
    failures,
    get port() {
      return ctx.server.port
    },
    sourceKind: installer.sourceKind,
    restart,
    async close() {
      process.off('SIGTERM', sigterm)
      await ctx.server.close().catch(() => {})
      kernel.dispose()
    },
  }
}

/**
 * 调用项目后端入口。
 *
 * 入口缺失不是错误：新建项目可能只做前端，或用户暂时删掉了后端。
 * 入口存在但格式不对则必须硬失败——静默跳过会让用户在「路由 404」上
 * 排查半天，而真正的原因是入口根本没被执行。
 */
async function applyProjectServer(ctx: KernelContext, entry: string): Promise<void> {
  if (!existsSync(entry)) return
  const mod = await import(pathToFileURL(entry).href)
  const apply = mod.default
  if (typeof apply !== 'function') {
    throw new Error(`项目后端入口 ${entry} 必须默认导出 apply(ctx) 函数`)
  }
  await apply(ctx)
}

/** 读 app.json；缺失或格式不对时返回 undefined（等价于发现即启用、无 body 能力声明）。 */
function readAppManifest(path: string): AppManifest | undefined {
  return readOptionalObjectJson<AppManifest>(path)
}
