/**
 * 应用内 API：设置页调用的插件管理接口。
 *
 * 两个入口（CLI 与 HTTP）走同一条实现——这里只是把它挂到路由上。
 */

import { join } from 'node:path'
import type { ConfigStore, Kernel, KernelContext } from '@cordis-app/kernel'
import type { ClientManifest, PluginFailure } from '@cordis-app/protocol'
import { parseJson, readBody, sendError, sendJson } from '../builtin/http-utils.js'
import { DEFAULT_SHARED_VERSIONS, PluginInstaller } from '../plugin/installer.js'

export interface ApiOptions {
  kernel: Kernel
  instanceDir: string
  dataDir: string
  config: ConfigStore
  getManifest(): ClientManifest
  setManifest(next: ClientManifest): void
  failures: PluginFailure[]
  /** 由 worker 注入：请求优雅重启 */
  requestRestart?: () => void
  frameworkVersion?: string
}

export function installRoutes(ctx: KernelContext, options: ApiOptions): void {
  const installer = new PluginInstaller({
    instanceDir: options.instanceDir,
    frameworkVersion: options.frameworkVersion ?? '1.0.0',
    // 版本范围与 CLI 共用同一份常量，避免「命令行装得上、设置页装不上」
    sharedVersions: DEFAULT_SHARED_VERSIONS,
  })

  /** 插件列表：已加载的 + 加载失败的，设置页据此渲染。 */
  ctx.router.get('/api/plugins', (_req, res) => {
    const manifest = options.getManifest()
    sendJson(res, 200, {
      plugins: Object.values(manifest.plugins).map((entry) => ({
        id: entry.id,
        displayName: entry.displayName,
        files: entry.files,
      })),
      failures: options.failures,
    })
  })

  /** 安装：粘贴包名或 tarball URL。不提供搜索、评分、版本选择。 */
  ctx.router.post('/api/plugins', async (req, res) => {
    const body = parseJson<{ spec?: string }>(await readBody(req))
    if (!body?.spec) {
      sendError(res, 400, 'bad_request', '请求体需要 { spec: string }')
      return
    }
    try {
      const result = await installer.install(body.spec)
      // 安装动作本身已经写盘，进程内无法可靠卸载 require.cache，
      // 所以一律走重启；result.restarted 用于向调用方说明原因。
      sendJson(res, 200, result)
      options.requestRestart?.()
    } catch (error) {
      sendError(res, 400, 'install_failed', (error as Error).message)
    }
  })

  ctx.router.delete('/api/plugins/:id', async (req, res, params) => {
    const id = params.id!
    try {
      const result = await installer.remove(id)
      options.config.delete(id)
      sendJson(res, 200, result)
      options.requestRestart?.()
    } catch (error) {
      sendError(res, 400, 'remove_failed', (error as Error).message)
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
      instanceDir: options.instanceDir,
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
