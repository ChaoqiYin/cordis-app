/**
 * worker —— 承载一切的那一层。
 *
 * 启动顺序是有讲究的：
 *   1. 建内核，注册日志与配置（它们无法由插件提供——插件自己就依赖它们）
 *   2. 挂内置插件：server → auth → router → static → ws → storage
 *   3. 挂应用插件
 *   4. 全部就绪后标记 healthy，再通过 IPC 报告就绪
 *
 * 第 4 步的顺序保证握手回传的是「完整就绪」而不是「HTTP 起来了」。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createKernel, createLoggerFactory, ConfigStore, type KernelContext } from '@cordis-app/kernel'
import {
  ENV_PORT,
  ENV_RESOURCES,
  ENV_TOKEN,
  EXIT_RESTART,
  HEALTH_PATH,
  MANIFEST_PATH,
  RECONNECT_EVENT,
  type ClientManifest,
  type PluginFailure,
  type WorkerMessage,
} from '@cordis-app/protocol'
import * as builtin from '../builtin/index.js'
import { loadPlugins } from '../plugin/loader.js'
import { sendJson } from '../builtin/http-utils.js'
import { installRoutes } from './api.js'

export interface WorkerOptions {
  port: number
  token: string
  dataDir: string
  resourcesDir?: string
  instanceDir: string
}

export interface WorkerHandle {
  /** 当前前端清单 */
  manifest: ClientManifest
  failures: PluginFailure[]
  port: number
  /** 优雅重启：关监听 → 通知客户端 → dispose → exit(75) */
  restart(): Promise<never>
  /** 测试用：直接关闭 */
  close(): Promise<void>
}

/** 从环境变量读取 worker 配置。缺一不可，缺失说明不是由 supervisor 拉起的。 */
export function readWorkerOptions(env: NodeJS.ProcessEnv = process.env): WorkerOptions {
  const port = Number(env[ENV_PORT])
  const token = env[ENV_TOKEN] ?? ''
  const dataDir = env.CORDIS_APP_DATA ?? ''
  if (!port || !token || !dataDir) {
    throw new Error('worker 必须由 supervisor 拉起（缺少端口 / token / 数据目录环境变量）')
  }
  return {
    port,
    token,
    dataDir,
    resourcesDir: env[ENV_RESOURCES],
    instanceDir: join(dataDir, 'instances', 'default'),
  }
}

export async function startWorker(options: WorkerOptions): Promise<WorkerHandle> {
  const logger = createLoggerFactory({ level: 'info' })
  const config = new ConfigStore({ filePath: join(options.instanceDir, 'config.json') })
  const kernel = createKernel({ logger: logger('kernel') })
  const ctx = kernel.context as KernelContext

  // 内核只提供日志、配置、生命周期、事件；其余全部是可替换的内置插件。
  ctx.set('logger', logger)
  ctx.set('config', config)

  const failures: PluginFailure[] = []
  let manifest: ClientManifest = { version: '1.0.0', plugins: {} }

  // 内置插件顺序即中间件顺序：auth 必须排在 router / static 之前。
  kernel.plugin(builtin.server, { port: options.port })
  kernel.plugin(builtin.auth, { token: options.token, port: options.port })
  kernel.plugin(builtin.router, {})
  kernel.plugin(builtin.static, {
    uiDir: options.resourcesDir ? join(options.resourcesDir, 'ui') : undefined,
    sharedDir: options.resourcesDir ? join(options.resourcesDir, 'shared') : undefined,
    pluginsDir: join(options.instanceDir, 'node_modules'),
  })
  kernel.plugin(builtin.ws, {})
  kernel.plugin(builtin.storage, { root: join(options.instanceDir, 'data') })

  await kernel.ready()

  // 应用插件：先扫 node_modules，再逐个挂载。失败不阻断其他插件。
  const loaded = await loadPlugins({
    kernel,
    nodeModulesDir: join(options.instanceDir, 'node_modules'),
    version: manifest.version,
    configFor: (id) => config.get(id) ?? {},
  })
  failures.push(...loaded.failures)
  manifest = loaded.client

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
    instanceDir: options.instanceDir,
    dataDir: options.dataDir,
    config,
    getManifest: () => manifest,
    setManifest: (next) => (manifest = next),
    failures,
    requestRestart: () => setTimeout(() => void restart(), 50),
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
    restart,
    async close() {
      process.off('SIGTERM', sigterm)
      await ctx.server.close().catch(() => {})
      kernel.dispose()
    },
  }
}

/** 供重启请求使用：发给自己一个 SIGTERM，走统一的优雅重启路径。 */
export function requestRestart(): void {
  process.kill(process.pid, 'SIGTERM')
}
