/**
 * 设置面板。
 *
 * 两个来源合并渲染：
 *   1. 插件通过 `ctx.settings({ schema })` 注册的 schema —— 由框架自动生成表单
 *   2. 插件通过 `ctx.settings({ component })` 注册的自定义组件
 *
 * 自动生成的存在理由见架构文档 8.1：schemastery 的 `role()` 提供 UI 元数据，
 * 声明的类型决定控件类型。这要求我们直接读 schema 的结构而不是实例化表单库。
 *
 * 插件管理（安装 / 卸载）也在这里——它是框架自己的设置分组，不是插件贡献的。
 */

import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SchemaNode } from './schema-form.js'
import { SchemaForm } from './schema-form.js'
import { Icon } from './icons.js'
import { HttpError, useRuntime, useSettings } from 'cordis-app/client'

interface PluginInfo {
  id: string
  displayName?: string
  files: string[]
}

interface PluginFailure {
  id: string
  reason: string
}

type ConfigMap = Record<string, unknown>

export function SettingsPanel(): ReactNode {
  const runtime = useRuntime()
  const settings = useSettings()
  const [config, setConfig] = useState<ConfigMap>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [installed, setInstalled] = useState<PluginInfo[]>([])
  const [failures, setFailures] = useState<PluginFailure[]>([])

  const reload = useCallback(async () => {
    try {
      const [next, plugins] = await Promise.all([
        runtime.http.get<ConfigMap>('/api/config'),
        runtime.http.get<{ plugins: PluginInfo[]; failures: PluginFailure[] }>('/api/plugins'),
      ])
      setConfig(next)
      setInstalled(plugins.plugins)
      setFailures(plugins.failures)
      setError(null)
    } catch (e) {
      setError(e instanceof HttpError ? e.message : String(e))
    }
  }, [runtime])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 保存单个插件配置：写入 config.json 后由服务端重启该插件（架构文档 8.3）。 */
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
          installed={installed}
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
          onRemove={async (id) => {
            setBusy(id)
            try {
              await runtime.http.delete(`/api/plugins/${encodeURIComponent(id)}`)
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

function PluginManager(props: {
  installed: PluginInfo[]
  failures: PluginFailure[]
  busy: string | null
  onInstall(spec: string): Promise<void>
  onRemove(id: string): Promise<void>
}): ReactNode {
  const [spec, setSpec] = useState('')

  return (
    <div className="plugin-manager">
      <form
        className="plugin-install"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = spec.trim()
          if (!trimmed) return
          void props.onInstall(trimmed).then(() => setSpec(''))
        }}
      >
        <input
          type="text"
          value={spec}
          placeholder="包名或 tarball URL，例如 @scope/plugin-foo@1.2.3"
          onChange={(event) => setSpec(event.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="button" disabled={!spec.trim() || props.busy === 'install'}>
          {props.busy === 'install' ? '安装中…' : '安装'}
        </button>
      </form>

      {props.installed.length === 0 && <p className="settings-empty">还没有安装插件。</p>}

      <ul className="plugin-list">
        {props.installed.map((plugin) => (
          <li key={plugin.id} className="plugin-row">
            <Icon name="puzzle" className="plugin-icon" />
            <div className="plugin-meta">
              <span className="plugin-name">{plugin.displayName ?? plugin.id}</span>
              <span className="plugin-id">{plugin.id}</span>
            </div>
            <button
              type="button"
              className="button button-ghost"
              disabled={props.busy === plugin.id}
              onClick={() => void props.onRemove(plugin.id)}
            >
              卸载
            </button>
          </li>
        ))}
      </ul>

      {props.failures.length > 0 && (
        <div className="notice notice-warn">
          <strong>以下插件加载失败</strong>
          <ul>
            {props.failures.map((failure) => (
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
