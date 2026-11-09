/**
 * 应用内 API：设置页调用的插件管理接口。
 *
 * 两个入口（CLI 与 HTTP）走同一条实现——这里只是把它挂到路由上。
 */

import type { ConfigStore, Kernel, KernelContext } from '@cordis-app/kernel'
import type {
  ClientManifest,
  PluginFailure,
  PluginInventory,
  RuntimeMode,
} from '@cordis-app/protocol'
import { parseJson, readBody, sendError, sendJson } from '../builtin/http-utils.js'
import type { PluginScan } from '../plugin/catalog.js'
import {
  buildInstalledPluginRecord,
  planPluginViews,
  type PluginStateStore,
} from '../plugin/plugin-state.js'
import type { PluginInstaller } from '../plugin/installer.js'
import { PluginLifecycle, PluginLifecycleError } from '../plugin/plugin-lifecycle.js'

export interface ApiOptions {
  kernel: Kernel
  /** 运行形态；决定打包模式的用户插件是否物理移除。 */
  mode: RuntimeMode
  /** 项目根；插件、配置、数据都从这里推导 */
  projectRoot: string
  dataDir: string
  /** 安装器由 worker 持有：启动恢复与设置页安装必须走同一个实例 */
  installer: PluginInstaller
  config: ConfigStore
  getManifest(): ClientManifest
  setManifest(next: ClientManifest): void
  /**
   * 与启动扫描完全相同的发现逻辑。每次请求重新扫描，安装/卸载后列表立即反映
   * 新状态，且不需要 API 自己知道四个根在哪里。
   */
  scan(): PluginScan
  /**
   * 插件状态存储。列表每次请求重新读盘：即使状态文件被外部修改，API 也
   * 立即反映磁盘事实，不依赖 worker 启动时的快照。
   */
  state: PluginStateStore
  failures: PluginFailure[]
  /** 由 worker 注入：请求优雅重启 */
  requestRestart?: () => void
  /** 时钟注入，测试用。 */
  now?: () => Date
}

export function installRoutes(ctx: KernelContext, options: ApiOptions): void {
  const { installer } = options
  const lifecycle = new PluginLifecycle({
    mode: options.mode,
    installer,
    state: options.state,
    scan: options.scan,
    ...(options.requestRestart ? { requestRestart: options.requestRestart } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  const now = () => (options.now ? options.now() : new Date())

  /**
   * 插件列表：完整扫描视图 + 已卸载记录 + 启用中的失败。
   *
   * `plugins` 含物理存在但被卸载的插件（`enabled: false`），设置页据此展示
   * 两状态；`uninstalled` 只放扫描不到、但有卸载记录的插件，避免重复。
   * `files` 来自前端清单，已卸载插件自然为空。
   */
  ctx.router.get('/api/plugins', (_req, res) => {
    const manifest = options.getManifest()
    const views = planPluginViews(options.scan(), options.state.read())
    const inventory: PluginInventory = {
      plugins: views.plugins.map((view) => ({
        id: view.id,
        // 两套身份都交给前端：展示与卸载各自需要不同的那个
        packageName: view.packageName,
        displayName: view.displayName,
        ...(view.version ? { version: view.version } : {}),
        rootKind: view.rootKind,
        origin: view.origin,
        enabled: view.enabled,
        // 与 uninstalled 条目同源：物理存在时能否通过「启用」恢复，由视图规划判定。
        reinstallable: view.reinstallable,
        files: manifest.plugins[view.id]?.files ?? [],
      })),
      uninstalled: views.uninstalled,
      // 已卸载插件不参与加载，它的失败也不该出现在启用视图里。
      failures: mergeFailures(
        views.failures,
        options.failures.filter((failure) => !views.uninstalledIds.has(failure.id)),
      ),
    }
    sendJson(res, 200, inventory)
  })

  /** 安装：粘贴包名或 tarball URL。不提供搜索、评分、版本选择。 */
  ctx.router.post('/api/plugins', async (req, res) => {
    const body = parseJson<{ spec?: string }>(await readBody(req))
    if (!body?.spec) {
      sendError(res, 400, 'bad_request', '请求体需要 { spec: string }')
      return
    }
    try {
      const result = await installer.install(body.spec, {
        // 状态文件不属于安装来源，但必须与物理安装一起回滚。
        snapshotPaths: [options.state.statePath],
        commit: (installed) => {
          // 安装即启用：清除该 id 的已卸载状态并写入新的安装元数据。
          options.state.setInstalled(
            installed.id,
            buildInstalledPluginRecord(
              body.spec!,
              installer.sourceKind,
              installed,
              now().toISOString(),
            ),
          )
        },
      })
      // 安装动作本身已经写盘，进程内无法可靠卸载 require.cache，
      // 所以一律走重启；result.restarted 用于向调用方说明原因。
      sendJson(res, 200, result)
      options.requestRestart?.()
    } catch (error) {
      sendError(res, 400, 'install_failed', (error as Error).message)
    }
  })

  /**
   * 卸载：未知 id 404，已卸载幂等 200。
   *
   * 语义从「删除插件并删除配置」改为「卸载并保留配置」；按插件来源分流物理
   * 动作，由 PluginLifecycle 统一处理。重复动作幂等，只有真正改变状态时才
   * 请求重启。
   */
  ctx.router.delete('/api/plugins/:id', async (_req, res, params) => {
    try {
      sendJson(res, 200, await lifecycle.uninstall(params.id!))
    } catch (error) {
      sendLifecycleError(res, error, 'remove_failed')
    }
  })

  /** 启用：物理存在只清状态，物理不存在按卸载记录重装。 */
  ctx.router.post('/api/plugins/:id/enable', async (_req, res, params) => {
    try {
      sendJson(res, 200, await lifecycle.enable(params.id!))
    } catch (error) {
      sendLifecycleError(res, error, 'enable_failed')
    }
  })

  /** 配置读写：设置面板的唯一入口。 */
  ctx.router.get('/api/config', (_req, res) => {
    sendJson(res, 200, options.config.all())
  })

  ctx.router.put('/api/config/:id', async (req, res, params) => {
    const id = params.id!
    const body = parseJson<{ value?: unknown }>(await readBody(req))
    if (!body || body.value === undefined) {
      sendError(res, 400, 'bad_request', '请求体需要 { value: unknown }')
      return
    }
    options.config.set(id, body.value)
    sendJson(res, 200, { id, value: body.value })
  })

  /** 运行时信息，供设置页的「关于」与调试使用。 */
  ctx.router.get('/api/runtime', (_req, res) => {
    sendJson(res, 200, {
      version: options.getManifest().version,
      projectRoot: options.projectRoot,
      dataDir: options.dataDir,
    })
  })

  /**
   * 主动重启 worker。
   *
   * 必须先回包再重启：调用方（CLI / 设置页）需要拿到 200 才能确认请求已被接受，
   * 而重启会立刻切断连接。延迟由 requestRestart 的实现负责，这里只保证响应
   * 已经写出去。
   */
  ctx.router.post('/api/restart', (_req, res) => {
    sendJson(res, 202, { restarting: true })
    options.requestRestart?.()
  })
}

/**
 * 合并「当前扫描」与「启动加载」两批失败。
 *
 * 启动失败里已经包含扫描失败；重新扫描后同一条失败会再次出现。按 id + 原因
 * 去重，既保留加载期的新失败，也不会让设置页把同一条冲突显示两遍。
 */
function mergeFailures(current: PluginFailure[], startup: PluginFailure[]): PluginFailure[] {
  const merged = new Map<string, PluginFailure>()
  for (const failure of [...current, ...startup]) {
    merged.set(`${failure.id}\0${failure.reason}`, failure)
  }
  return [...merged.values()]
}

/** 生命周期错误映射：404 / 409 是预期结果，其余按操作失败处理。 */
function sendLifecycleError(
  res: Parameters<typeof sendError>[0],
  error: unknown,
  fallbackCode: string,
): void {
  if (error instanceof PluginLifecycleError) {
    sendError(res, error.status, error.code, error.message)
    return
  }
  sendError(res, 400, fallbackCode, (error as Error).message)
}
