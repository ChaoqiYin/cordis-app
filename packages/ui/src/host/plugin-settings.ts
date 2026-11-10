/**
 * 插件设置分组的数据绑定。
 *
 * 分组由插件在 `ctx.settings()` 里注册，配置值来自 `/api/config`。框架不再
 * 决定这些分组画在哪里：项目可以放进设置页、独立页面，或者只取数据自己
 * 渲染。`SchemaForm` 只是可选的 schema 渲染器。
 *
 * SSR 安全：分组在首渲染即可从注册表读到；配置请求只在 effect 里发生。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from 'react'
import { useRuntime, useSettings } from 'cordis-app/client'
import type { SchemaNode } from './schema-form.js'
import { describeError } from './error-message.js'

export interface PluginSettingsEntry {
  /** 插件内唯一的分组 id。 */
  id: string
  pluginId: string
  title: string
  schema?: SchemaNode
  component?: ComponentType
  /**
   * 该插件的完整配置。
   *
   * 同一插件的多个分组共享同一份配置；保存时按整份值写回。schema 表单只会
   * 覆盖它声明过的字段。
   */
  value: Record<string, unknown>
}

export interface PluginSettingsState {
  groups: PluginSettingsEntry[]
  /** 首次配置尚未返回。后续 `reload()` 不会重新置为 true。 */
  loading: boolean
  error: string | null
  /** 正在保存配置的插件 id。 */
  saving: string | null
  /** 保存该插件的完整配置；失败原因见 `error`。 */
  save(pluginId: string, value: unknown): Promise<boolean>
  reload(): Promise<void>
  clearError(): void
}

type ConfigMap = Record<string, unknown>

/** 配置按插件 id 存；非对象值在表单里没有意义，回退为空对象。 */
function configOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function usePluginSettings(): PluginSettingsState {
  const runtime = useRuntime()
  const settings = useSettings()
  const [config, setConfig] = useState<ConfigMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  // 只让最新一次配置请求写状态
  const seq = useRef(0)

  const reload = useCallback(async () => {
    const current = ++seq.current
    try {
      const next = await runtime.http.get<ConfigMap>('/api/config')
      if (current !== seq.current) return
      setConfig(next)
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

  // 插件增删或 worker 重启后，配置页也要重新拉取服务端状态
  useEffect(() => runtime.onReconnected(() => reload()), [runtime, reload])

  const save = useCallback(
    async (pluginId: string, value: unknown): Promise<boolean> => {
      setSaving(pluginId)
      setError(null)
      try {
        await runtime.http.put(`/api/config/${encodeURIComponent(pluginId)}`, { value })
        setConfig((prev) => ({ ...prev, [pluginId]: value }))
        return true
      } catch (cause) {
        setError(describeError(cause))
        return false
      } finally {
        setSaving(null)
      }
    },
    [runtime],
  )

  const groups = useMemo<PluginSettingsEntry[]>(
    () =>
      settings.map((group) => ({
        id: group.id,
        pluginId: group.pluginId,
        title: group.title,
        schema: group.schema as SchemaNode | undefined,
        component: group.component as ComponentType | undefined,
        value: configOf(config[group.pluginId]),
      })),
    [settings, config],
  )

  const clearError = useCallback(() => setError(null), [])

  return { groups, loading, error, saving, save, reload, clearError }
}
