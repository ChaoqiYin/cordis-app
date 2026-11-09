/**
 * 插件生命周期动作：卸载与启用。
 *
 * 用户可见状态只有「已启用」与「已卸载」，动作只有「卸载」与「启用」。
 * 本模块把一次动作翻译成两件事：
 *   1. 按 `rootKind` 决定物理动作——随包/项目本地只写状态，项目依赖跑项目
 *      包管理器，打包模式的用户插件由 bundle 来源移除目录。
 *   2. 把状态写入放进安装器事务：状态文件与 `app.json` 在快照里，物理动作
 *      失败或状态写入失败都会一起回滚。
 *
 * HTTP 层只负责把结果映射成响应；动作的幂等、404 与 409 规则都在这里。
 */

import type { RuntimeMode } from '@cordis-app/protocol'
import {
  findPlugin,
  type InstalledPlugin,
  type PluginRootKind,
  type PluginScan,
} from './catalog.js'
import type { PluginInstaller } from './installer.js'
import type {
  PluginState,
  PluginStateStore,
  UninstalledPluginRecord,
} from './plugin-state.js'
import type { SourceInstallResult } from './install-source.js'

export interface PluginLifecycleOptions {
  mode: RuntimeMode
  installer: PluginInstaller
  state: PluginStateStore
  /** 与启动扫描相同的发现逻辑；每次动作重新扫描。 */
  scan(): PluginScan
  /** 由 worker 注入：请求优雅重启。 */
  requestRestart?: () => void
  /** 时钟注入，测试用。 */
  now?: () => Date
}

export interface UninstallResult {
  id: string
  enabled: false
  restarted: boolean
  reason: string
}

export interface EnableResult {
  id: string
  enabled: true
  version?: string
  restarted: boolean
  reason: string
}

/** 生命周期动作的可预期失败；HTTP 层据此映射 404 / 409。 */
export class PluginLifecycleError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: 'not_found' | 'not_reinstallable',
    message: string,
  ) {
    super(message)
    this.name = 'PluginLifecycleError'
  }
}

export class PluginLifecycle {
  constructor(private readonly options: PluginLifecycleOptions) {}

  /** 卸载：未知 id 404；已卸载幂等 200；成功后请求重启。 */
  async uninstall(idOrPackageName: string): Promise<UninstallResult> {
    const plugin = findPlugin(this.options.scan(), idOrPackageName)
    const state = this.options.state.read()
    const id = plugin?.id ?? idOrPackageName

    if (!plugin && !state.uninstalledIds.includes(id)) {
      throw new PluginLifecycleError(404, 'not_found', `未安装插件 ${idOrPackageName}`)
    }
    if (state.uninstalledIds.includes(id)) {
      return { id, enabled: false, restarted: false, reason: '插件已处于卸载状态' }
    }

    const record = this.buildRecord(plugin!, state)
    const physical = this.removesPhysically(plugin!.rootKind)
    const outcome: SourceInstallResult = {
      id,
      restarted: true,
      reason: physical ? '卸载插件需重启 worker' : '逻辑卸载需重启 worker',
    }
    const hooks = {
      snapshotPaths: [this.options.state.statePath],
      commit: () => {
        this.options.state.markUninstalled(record)
      },
    }

    // 逻辑卸载与物理卸载走同一条事务路径：差别只在于是否调用安装来源。
    if (physical) await this.options.installer.remove(id, hooks)
    else await this.options.installer.logical('remove', id, outcome, hooks)

    this.options.requestRestart?.()
    return { id, enabled: false, restarted: true, reason: outcome.reason }
  }

  /**
   * 启用：物理存在只清状态；物理不存在按卸载记录重装；没有 spec 时 409。
   * 已启用幂等 200；未知 id 404。
   */
  async enable(idOrPackageName: string): Promise<EnableResult> {
    const plugin = findPlugin(this.options.scan(), idOrPackageName)
    const state = this.options.state.read()
    const id = plugin?.id ?? idOrPackageName
    const isUninstalled = state.uninstalledIds.includes(id)

    if (!plugin && !isUninstalled) {
      throw new PluginLifecycleError(404, 'not_found', `未知插件 ${idOrPackageName}`)
    }
    if (!isUninstalled) {
      return {
        id,
        enabled: true,
        ...installedPluginVersion(plugin),
        restarted: false,
        reason: '插件已处于启用状态',
      }
    }

    if (plugin) {
      // 物理存在：启用只是清状态。文件、包管理器都不动。
      const outcome: SourceInstallResult = {
        id,
        restarted: true,
        reason: '启用插件需重启 worker',
      }
      await this.options.installer.logical('install', id, outcome, {
        snapshotPaths: [this.options.state.statePath],
        commit: () => {
          this.options.state.markEnabled(id)
        },
      })
      this.options.requestRestart?.()
      return {
        id,
        enabled: true,
        ...installedPluginVersion(plugin),
        restarted: true,
        reason: outcome.reason,
      }
    }

    // 物理不存在：必须有卸载记录里的 spec 才能一键装回。
    const spec = state.uninstalled[id]?.spec
    if (!spec) {
      throw new PluginLifecycleError(
        409,
        'not_reinstallable',
        `插件 ${id} 没有可用的重装 spec，无法一键装回；请通过安装表单重新安装`,
      )
    }

    const installed = await this.options.installer.install(spec, {
      snapshotPaths: [this.options.state.statePath],
      commit: (result) => {
        // 重装即启用：先让 id 回到启用顺序，再写入新的安装元数据。
        this.options.state.markEnabled(id)
        this.options.state.setInstalled(id, {
          spec,
          sourceKind: this.options.installer.sourceKind,
          ...(result.packageName ? { packageName: result.packageName } : {}),
          ...(result.version ? { version: result.version } : {}),
          installedAt: this.now().toISOString(),
        })
      },
    })
    this.options.requestRestart?.()
    return {
      id,
      enabled: true,
      ...versionField(installed),
      restarted: true,
      reason: installed.reason || '重新安装插件需重启 worker',
    }
  }

  private removesPhysically(rootKind: PluginRootKind): boolean {
    if (rootKind === 'dependency') return true
    // 打包模式的用户插件由 bundle 来源移除目录；项目模式的用户插件只写状态。
    return rootKind === 'user' && this.options.mode === 'packaged'
  }

  /**
   * 卸载记录。外部插件保存包名、版本与原始 spec，供一键重装；随包/本地
   * 插件没有可重装的物理来源，省略 `sourceKind` 与 `spec`。
   *
   * 手工安装、没有 `installed` 元数据的项目依赖，用 `包名@已安装版本`
   * 合成 spec。
   */
  private buildRecord(plugin: InstalledPlugin, state: PluginState): UninstalledPluginRecord {
    const installed = state.installed[plugin.id]
    const version = plugin.manifest.version ?? plugin.packageJson.version
    const base: UninstalledPluginRecord = {
      id: plugin.id,
      displayName: plugin.manifest.displayName ?? plugin.id,
      rootKind: plugin.rootKind,
      packageName: plugin.packageName,
      ...(version ? { version } : {}),
      uninstalledAt: this.now().toISOString(),
    }

    const external =
      plugin.rootKind === 'dependency' ||
      (plugin.rootKind === 'user' && this.options.mode === 'packaged')
    if (!external) return base

    const packageName = installed?.packageName ?? plugin.packageName
    const sourceKind =
      installed?.sourceKind ?? (plugin.rootKind === 'user' ? 'bundle' : 'npm')
    const spec =
      installed?.spec ??
      (plugin.rootKind === 'dependency' && version ? `${packageName}@${version}` : undefined)

    return {
      ...base,
      sourceKind,
      packageName,
      ...(spec ? { spec } : {}),
    }
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date()
  }
}

function versionField(source: { version?: string } | undefined): { version?: string } {
  return source?.version ? { version: source.version } : {}
}

/** 扫描结果里的插件版本优先取 plugin.json，其次取 package.json。 */
function installedPluginVersion(plugin: InstalledPlugin | undefined): { version?: string } {
  const version = plugin?.manifest.version ?? plugin?.packageJson.version
  return version ? { version } : {}
}
