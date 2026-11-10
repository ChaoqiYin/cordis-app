/**
 * 默认 body 的设置页。
 *
 * 只是参考实现：分组来自 `usePluginSettings()`，schema 由 `SchemaForm`
 * 渲染。项目 body 可以完全不用这个文件，自己决定设置页的位置、布局与样式；
 * 插件管理界面同样由项目自己实现，默认 body 不提供。
 *
 * 这里不打开 `PluginAdmin` 的任何 UI——安装、卸载、启用交给 CLI 或项目页面。
 */

import { createElement, type ReactNode } from 'react'
import { SchemaForm } from './schema-form.js'
import { usePluginSettings } from './plugin-settings.js'

export function SettingsView(): ReactNode {
  const { groups, loading, error, saving, save } = usePluginSettings()

  return (
    <div className="settings">
      {error && <div className="notice notice-error">{error}</div>}

      {groups.map((group) => (
        <section className="settings-group" key={`${group.pluginId}:${group.id}`}>
          <h2>
            {group.title}
            <span className="settings-origin">{group.pluginId}</span>
          </h2>
          {group.component ? (
            createElement(group.component as never, {})
          ) : group.schema ? (
            <SchemaForm
              schema={group.schema}
              value={group.value}
              disabled={saving === group.pluginId}
              onSave={(next) => void save(group.pluginId, next)}
            />
          ) : (
            <p className="settings-empty">这个分组既没有 schema 也没有组件。</p>
          )}
        </section>
      ))}

      {!loading && groups.length === 0 && (
        <p className="settings-empty">还没有插件注册设置分组。</p>
      )}
    </div>
  )
}
