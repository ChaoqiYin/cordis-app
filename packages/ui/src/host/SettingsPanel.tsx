/**
 * 设置面板。
 *
 * 两个来源合并渲染：
 *   1. 插件通过 `ctx.settings({ schema })` 注册的 schema —— 由框架自动生成表单
 *   2. 插件通过 `ctx.settings({ component })` 注册的自定义组件
 *
 * 自动生成的存在理由：schemastery 的 `role()` 提供 UI 元数据，
 * 声明的类型决定控件类型。这要求我们直接读 schema 的结构而不是实例化表单库。
 *
 * 插件管理也在这里——它是框架自己的设置分组，不是插件贡献的。插件生命周期
 * 只有「已启用 / 已卸载」两个状态与「卸载 / 启用」两个动作，不提供「停用」。
 * 数据与回调由 `SettingsPanel` 注入，`PluginManager` 本身不发请求，便于 SSR 测试。
 */

import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  PLUGIN_ORIGIN_LABEL,
  type PluginEntry,
  type PluginFailure,
  type PluginOrigin,
  type UninstalledPluginEntry,
} from '@cordis-app/protocol/plugins'
import type { SchemaNode } from './schema-form.js'
import { SchemaForm } from './schema-form.js'
import { Icon } from './icons.js'
import { HttpError, useRuntime, useSettings } from 'cordis-app/client'

/** `GET /api/plugins` 完整扫描视图里的一个插件。 */
export type PluginInfo = PluginEntry

/** `GET /api/plugins` 里扫描不到、但有卸载记录的插件。 */
export type UninstalledPluginInfo = UninstalledPluginEntry

export type { PluginFailure, PluginOrigin }

export interface PluginManagerProps {
  plugins: PluginInfo[]
  uninstalled: UninstalledPluginInfo[]
  failures: PluginFailure[]
  busy?: string | null
  onInstall(spec: string): Promise<void>
  onUninstall(id: string): Promise<void>
  onEnable(id: string): Promise<void>
}

type ConfigMap = Record<string, unknown>

export function SettingsPanel(): ReactNode {
  const runtime = useRuntime()
  const settings = useSettings()
  const [config, setConfig] = useState<ConfigMap>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [uninstalled, setUninstalled] = useState<UninstalledPluginInfo[]>([])
  const [failures, setFailures] = useState<PluginFailure[]>([])

  const reload = useCallback(async () => {
    try {
      const [next, inventory] = await Promise.all([
        runtime.http.get<ConfigMap>('/api/config'),
        runtime.http.get<{
          plugins: PluginInfo[]
          uninstalled: UninstalledPluginInfo[]
          failures: PluginFailure[]
        }>('/api/plugins'),
      ])
      setConfig(next)
      setPlugins(inventory.plugins)
      setUninstalled(inventory.uninstalled ?? [])
      setFailures(inventory.failures)
      setError(null)
    } catch (e) {
      setError(e instanceof HttpError ? e.message : String(e))
    }
  }, [runtime])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 保存单个插件配置：写入 config.json 后由服务端重启该插件。 */
  const save = async (pluginId: string, value: unknown) => {
    setBusy(pluginId)
    try {
      await runtime.http.put(`/api/config/${encodeURIComponent(pluginId)}`, { value })
      setConfig((prev) => ({ ...prev, [pluginId]: value }))
      setError(null)
    } catch (e) {
      setError(e instanceof HttpError ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="settings">
      <header className="settings-header">
        <h1>设置</h1>
      </header>

      {error && <div className="notice notice-error">{error}</div>}

      <section className="settings-group">
        <h2>插件</h2>
        <PluginManager
          plugins={plugins}
          uninstalled={uninstalled}
          failures={failures}
          busy={busy}
          onInstall={async (spec) => {
            setBusy('install')
            try {
              await runtime.http.post('/api/plugins', { spec })
              // 安装后服务端会重启 worker；页面的 WebSocket 会收到重连通知
            } catch (e) {
              setError(e instanceof HttpError ? e.message : String(e))
            } finally {
              setBusy(null)
            }
          }}
          onUninstall={async (id) => {
            setBusy(id)
            try {
              await runtime.http.delete(`/api/plugins/${encodeURIComponent(id)}`)
            } catch (e) {
              setError(e instanceof HttpError ? e.message : String(e))
            } finally {
              setBusy(null)
            }
          }}
          onEnable={async (id) => {
            setBusy(id)
            try {
              await runtime.http.post(`/api/plugins/${encodeURIComponent(id)}/enable`)
            } catch (e) {
              setError(e instanceof HttpError ? e.message : String(e))
            } finally {
              setBusy(null)
            }
          }}
        />
      </section>

      {settings.map((group) => {
        const value = (config[group.pluginId] ?? defaultOf(group.schema)) as Record<string, unknown>
        return (
          <section className="settings-group" key={`${group.pluginId}:${group.id}`}>
            <h2>
              {group.title}
              <span className="settings-origin">{group.pluginId}</span>
            </h2>
            {group.component ? (
              createElement(group.component as never, {})
            ) : group.schema ? (
              <SchemaForm
                schema={group.schema as SchemaNode}
                value={value ?? {}}
                disabled={busy === group.pluginId}
                onSave={(next) => void save(group.pluginId, next)}
              />
            ) : (
              <p className="settings-empty">这个分组既没有 schema 也没有组件。</p>
            )}
          </section>
        )
      })}

      {settings.length === 0 && (
        <p className="settings-empty">还没有插件注册设置分组。</p>
      )}
    </div>
  )
}

function defaultOf(schema: unknown): Record<string, unknown> {
  const node = schema as SchemaNode | undefined
  return (node?.meta?.default as Record<string, unknown> | undefined) ?? {}
}

interface UninstalledRow {
  id: string
  displayName: string
  version?: string
  origin: PluginOrigin
  reinstallable: boolean
}

/**
 * 已卸载分组 = `plugins` 中 `enabled: false` 的条目 + `uninstalled` 数组。
 *
 * 两边都出现同一个 id 时保留扫描结果（它有真实的展示信息与物理状态），
 * 保证一个插件只渲染一行。
 */
function mergeUninstalled(
  plugins: PluginInfo[],
  uninstalled: UninstalledPluginInfo[],
): UninstalledRow[] {
  const rows: UninstalledRow[] = []
  const seen = new Set<string>()

  for (const plugin of plugins) {
    if (plugin.enabled) continue
    seen.add(plugin.id)
    rows.push({
      id: plugin.id,
      displayName: plugin.displayName ?? plugin.id,
      ...(plugin.version ? { version: plugin.version } : {}),
      origin: plugin.origin,
      reinstallable: plugin.reinstallable,
    })
  }

  for (const entry of uninstalled) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    rows.push({
      id: entry.id,
      displayName: entry.displayName ?? entry.id,
      ...(entry.version ? { version: entry.version } : {}),
      origin: entry.origin,
      reinstallable: entry.reinstallable,
    })
  }

  return rows
}

/**
 * 纯插件管理组件：不发请求，数据与回调全部由 `SettingsPanel` 注入。
 *
 * 不持有 React 状态，安装表单使用非受控输入；这样 SSR 与元素树测试都能
 * 直接渲染并检查按钮行为。
 */
export function PluginManager(props: PluginManagerProps): ReactNode {
  const busy = props.busy ?? null
  const enabled = props.plugins.filter((plugin) => plugin.enabled)
  const uninstalled = mergeUninstalled(props.plugins, props.uninstalled)
  // API 返回的 failures 已经排除已卸载插件；这里直接渲染，避免二次过滤把
  // API 认为有效的失败藏起来。
  const failures = props.failures

  return (
    <div className="plugin-manager">
      <form
        className="plugin-install"
        onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const input = form.elements.namedItem('spec')
          const value = input instanceof HTMLInputElement ? input.value.trim() : ''
          if (!value) return
          void props.onInstall(value).then(() => form.reset())
        }}
      >
        <input
          type="text"
          name="spec"
          placeholder="包名或 tarball URL，例如 @scope/plugin-foo@1.2.3"
          spellCheck={false}
        />
        <button type="submit" className="button" disabled={busy === 'install'}>
          {busy === 'install' ? '安装中…' : '安装'}
        </button>
      </form>

      <section className="plugin-group">
        <h3>已启用</h3>
        {enabled.length === 0 ? (
          <p className="settings-empty">还没有已启用的插件。</p>
        ) : (
          <ul className="plugin-list">
            {enabled.map((plugin) => (
              <li key={plugin.id} className="plugin-row" data-plugin-id={plugin.id}>
                <Icon name="puzzle" className="plugin-icon" />
                <div className="plugin-meta">
                  <span className="plugin-name">{plugin.displayName ?? plugin.id}</span>
                  <span className="plugin-id">{plugin.id}</span>
                </div>
                {plugin.version && <span className="plugin-version">v{plugin.version}</span>}
                <OriginBadge origin={plugin.origin} />
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy === plugin.id}
                  onClick={() => void props.onUninstall(plugin.id)}
                >
                  卸载
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="plugin-group">
        <h3>已卸载</h3>
        {uninstalled.length === 0 ? (
          <p className="settings-empty">没有已卸载的插件。</p>
        ) : (
          <ul className="plugin-list">
            {uninstalled.map((plugin) => (
              <li key={plugin.id} className="plugin-row" data-plugin-id={plugin.id}>
                <Icon name="puzzle" className="plugin-icon" />
                <div className="plugin-meta">
                  <span className="plugin-name">{plugin.displayName}</span>
                  <span className="plugin-id">{plugin.id}</span>
                </div>
                {plugin.version && <span className="plugin-version">v{plugin.version}</span>}
                <OriginBadge origin={plugin.origin} />
                {!plugin.reinstallable && (
                  <span className="plugin-reason">
                    无法一键重装：没有可用的重装记录，请通过安装表单重新安装。
                  </span>
                )}
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={!plugin.reinstallable || busy === plugin.id}
                  onClick={() => void props.onEnable(plugin.id)}
                >
                  启用
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {failures.length > 0 && (
        <div className="notice notice-warn">
          <strong>以下插件加载失败</strong>
          <ul>
            {failures.map((failure) => (
              <li key={failure.id}>
                <code>{failure.id}</code> — {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function OriginBadge(props: { origin: PluginOrigin }): ReactNode {
  return (
    <span className={`plugin-origin plugin-origin-${props.origin}`}>
      {PLUGIN_ORIGIN_LABEL[props.origin]}
    </span>
  )
}
