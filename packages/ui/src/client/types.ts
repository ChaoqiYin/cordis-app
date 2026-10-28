/**
 * 前端扩展点的类型契约。
 *
 * 这份文件同时是 `cordis-app/client` 这个共享模块的公开面——插件前端只依赖它，
 * 不依赖 UI 内部的任何实现。因此这里刻意不引用 React 组件之外的东西。
 */

import type { ComponentType } from 'react'

/** 一个可挂载到扩展点的组件。 */
export type ExtensionComponent<P = {}> = ComponentType<P>

export interface PageOptions {
  path: string
  name: string
  /** 图标名，由框架内置图标集解析 */
  icon?: string
  component: ExtensionComponent
  /** 活动栏排序，小的在前 */
  order?: number
  /** 访问所需权限，v1 只做展示 */
  authority?: string
}

export interface SlotOptions {
  /** 具名插槽，例如 header.right、sidebar.bottom */
  type: string
  component: ExtensionComponent
  order?: number
}

export interface MenuItem {
  /**
   * `.reset`  → `<plugin-id>/reset`（相对 id，框架展开）
   * `@separator` → 框架内置项，只读
   * `my-item`  → 绝对 id，用于跨插件引用
   */
  id: string
  label?: string
  order?: number
  disabled?: boolean
  icon?: string
}

export interface ActionOptions {
  action: () => void | Promise<void>
  shortcut?: string
  disabled?: boolean
}

export interface SettingsOptions {
  id: string
  title: string
  /** 由服务端 schema 推导，或直接给一个组件 */
  schema?: unknown
  component?: ExtensionComponent
  order?: number
}

/** 菜单触发器。绑定菜单 id，返回在 DOM 事件上调用即可的函数。 */
export type MenuTrigger = (event: {
  preventDefault(): void
  clientX: number
  clientY: number
}) => void

/** 命令式 API：只在插件入口处调用一次，用于注册。 */
export interface ClientContext {
  /** 当前插件 id，注册时用于展开相对 id */
  readonly id: string

  page(options: PageOptions): () => void
  slot(options: SlotOptions): () => void
  menu(menuId: string, items: MenuItem[]): () => void
  action(id: string, options: ActionOptions): () => void
  settings(options: SettingsOptions): () => void

  /** 极薄的 HTTP 封装：自动附加 token、统一错误处理。 */
  readonly http: HttpClient
  /** 外观接口。浏览器模式下安全忽略。 */
  readonly appearance: AppearanceApi
  /** 订阅/发布，仅限前端 */
  emit(event: string, ...args: unknown[]): void
  on(event: string, handler: (...args: unknown[]) => void): () => void
  /** 插件的初始状态，来自服务端导出的 data */
  readonly data: unknown
  /**
   * 打开一个子作用域。
   *
   * 子作用域的注册与副作用仍随插件一起销毁（级联），名字只用于区分与调试。
   * 单独撤销某个子树时，保留返回值的 `dispose` 即可。
   */
  isolate(name: string): ScopedClientContext
  /** 注册一个可被插件卸载的清理函数 */
  effect(fn: () => void | (() => void)): () => void
}

/** `isolate()` 的返回值：行为与 ClientContext 相同，额外带一个单独撤销入口。 */
export interface ScopedClientContext extends ClientContext {
  /** 只销毁这个子作用域；插件其余部分不受影响。 */
  dispose(): void
}

export interface HttpClient {
  get<T = unknown>(url: string, config?: RequestConfig): Promise<T>
  post<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<T>
  put<T = unknown>(url: string, data?: unknown, config?: RequestConfig): Promise<T>
  delete<T = unknown>(url: string, config?: RequestConfig): Promise<T>
}

export interface RequestConfig {
  timeout?: number
  retries?: number
  signal?: AbortSignal
}

export interface AppearanceApi {
  setTheme(theme: 'dark' | 'light' | 'auto'): void
  setAccent(color: string): void
}

/** 插件前端模块的默认导出签名。 */
export type PluginClientEntry = (ctx: ClientContext, data?: unknown) => void

/** 已注册页面的内部形态（框架自己用，插件不应读取）。 */
export interface RegisteredPage extends PageOptions {
  pluginId: string
  /** 稳定排序键 */
  seq: number
}

export interface RegisteredSlot extends SlotOptions {
  pluginId: string
  seq: number
}

export interface RegisteredSettings extends SettingsOptions {
  pluginId: string
  seq: number
}

/**
 * 已注册的菜单项。
 *
 * `kind` 让渲染层无需猜测：`item` 是插件贡献的可点项，`separator` 是框架
 * 提供的分隔线。`@` 项的外观由框架决定，插件只能决定它出现在哪。
 */
export interface RegisteredMenuItem extends MenuItem {
  pluginId: string
  seq: number
  kind: 'item' | 'separator' | 'label'
}

export interface RegisteredAction extends ActionOptions {
  pluginId: string
  id: string
}
