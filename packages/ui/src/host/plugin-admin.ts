/**
 * 插件清单与生命周期动作的 headless 绑定。
 *
 * 框架不提供插件管理界面：安装、卸载、启用的入口与按钮长什么样、放在哪个
 * 页面，由项目决定。这里只负责拉清单、执行动作，并把忙碌与错误状态交给
 * 调用方。
 *
 * SSR 安全：请求只在 effect 里发生；首帧是 loading + 空清单，因此项目 body
 * 可以在 Node 里被 `react-dom/server` 渲染。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  PluginEntry,
  PluginFailure,
  PluginInventory,
  UninstalledPluginEntry,
} from '@cordis-app/protocol/plugins'
import { useRuntime } from 'cordis-app/client'
import { describeError } from './error-message.js'

export interface PluginAdminState {
  /** 扫描到的插件，含 `enabled: false` 的条目。 */
  plugins: PluginEntry[]
  /** 扫描不到、但有卸载记录的插件。 */
  uninstalled: UninstalledPluginEntry[]
  failures: PluginFailure[]
  /** 首次清单尚未返回。后续 `reload()` 不会重新置为 true。 */
  loading: boolean
  error: string | null
  /** 正在执行的动作：`'install'` 或插件 id。 */
  busy: 'install' | string | null
  /** 安装并返回是否成功；失败原因见 `error`。 */
  install(spec: string): Promise<boolean>
  uninstall(id: string): Promise<boolean>
  enable(id: string): Promise<boolean>
  reload(): Promise<void>
  clearError(): void
}

/** 安装 / 卸载 / 启用响应里与本 hook 有关的字段。 */
interface PluginActionState {
  restarted?: boolean
}

export function usePluginAdmin(): PluginAdminState {
  const runtime = useRuntime()
  const [plugins, setPlugins] = useState<PluginEntry[]>([])
  const [uninstalled, setUninstalled] = useState<UninstalledPluginEntry[]>([])
  const [failures, setFailures] = useState<PluginFailure[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<'install' | string | null>(null)
  // 只让最新一次清单请求写状态；动作后的刷新可能与前一次重叠
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const current = ++seq.current
    try {
      const inventory = await runtime.http.get<PluginInventory>('/api/plugins')
      if (current !== seq.current) return
      setPlugins(inventory.plugins)
      setUninstalled(inventory.uninstalled ?? [])
      setFailures(inventory.failures)
      setError(null)
    } catch (cause) {
      if (current !== seq.current) return
      setError(describeError(cause))
    } finally {
      if (current === seq.current) setLoading(false)
    }
  }, [runtime])

  useEffect(() => {
    void reload()
  }, [reload])

  // 插件增删后 worker 会重启；组件不重新挂载，清单靠重连事件刷新
  useEffect(() => runtime.onReconnected(() => reload()), [runtime, reload])

  const run = useCallback(
    async (
      key: 'install' | string,
      action: () => Promise<PluginActionState>,
    ): Promise<boolean> => {
      setBusy(key)
      setError(null)
      try {
        const result = await action()
        // `restarted` 为真时进程正在关闭，此刻请求清单只会撞上它；
        // 清单交给重连后的刷新。
        if (!result.restarted) await reload()
        return true
      } catch (cause) {
        setError(describeError(cause))
        return false
      } finally {
        setBusy(null)
      }
    },
    [reload],
  )

  const install = useCallback(
    (spec: string): Promise<boolean> => {
      const target = spec.trim()
      if (!target) {
        setError('安装目标不能为空')
        return Promise.resolve(false)
      }
      return run('install', () =>
        runtime.http.post<PluginActionState>('/api/plugins', { spec: target }),
      )
    },
    [run, runtime],
  )

  const uninstall = useCallback(
    (id: string): Promise<boolean> =>
      run(id, () =>
        runtime.http.delete<PluginActionState>(`/api/plugins/${encodeURIComponent(id)}`),
      ),
    [run, runtime],
  )

  const enable = useCallback(
    (id: string): Promise<boolean> =>
      run(id, () =>
        runtime.http.post<PluginActionState>(`/api/plugins/${encodeURIComponent(id)}/enable`),
      ),
    [run, runtime],
  )

  const clearError = useCallback(() => setError(null), [])

  return {
    plugins,
    uninstalled,
    failures,
    loading,
    error,
    busy,
    install,
    uninstall,
    enable,
    reload,
    clearError,
  }
}
