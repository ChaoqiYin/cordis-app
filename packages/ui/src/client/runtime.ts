/**
 * 前端运行时的核心状态。
 *
 * 这一层刻意不依赖 React：
 *   - 它可以在 Node 里被直接测试（插件加载、卸载、作用域级联销毁都是纯逻辑）
 *   - 它只有一份实例，宿主与所有插件共享（见 shared-modules.mjs 的说明）
 */

import type { ClientManifest, ClientPluginEntry } from '@cordis-app/protocol/client'
import { Registry } from './registry.js'
import { createHttp } from './http.js'
import { applyAccent, applyTheme } from './appearance.js'
import type { ClientContext, HttpClient, ScopedClientContext } from './types.js'

/**
 * 一个作用域：插件入口、以及它通过 `ctx.isolate()` 打开的每个子作用域。
 *
 * 级联规则与 cordis 一致：销毁父作用域会先销毁全部子作用域，再逆序释放
 * 自己的副作用。插件作者因此不需要知道「这个监听是哪个子作用域注册的」。
 */
export class Scope {
  private readonly effects: Array<() => void> = []
  private readonly children = new Set<Scope>()
  private disposed = false
  /** 调试用标识，例如 `theme-picker/header` */
  label?: string

  /** 登记清理函数；作用域销毁时逆序执行。返回的函数可提前单独撤销。 */
  add(dispose: () => void): () => void {
    if (this.disposed) {
      // 作用域已销毁：立刻执行，避免注册泄漏到下一个生命周期
      dispose()
      return () => {}
    }
    let done = false
    const wrapped = () => {
      if (done) return
      done = true
      const index = this.effects.indexOf(wrapped)
      if (index >= 0) this.effects.splice(index, 1)
      dispose()
    }
    this.effects.push(wrapped)
    return wrapped
  }

  child(): Scope {
    const scope = new Scope()
    if (this.disposed) {
      scope.dispose()
    } else {
      this.children.add(scope)
    }
    return scope
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const child of [...this.children].reverse()) child.dispose()
    this.children.clear()
    for (const dispose of [...this.effects].reverse()) dispose()
    this.effects.length = 0
  }
}

/** 菜单打开状态。由 `useMenu()` 写入，由宿主渲染。 */
export interface MenuState {
  menuId: string
  x: number
  y: number
}

export interface ClientRuntimeOptions {
  token: string
  /** 依赖注入点，测试时替换 */
  http?: HttpClient
}

export interface LoadedPlugin {
  id: string
  displayName?: string
  scope: Scope
  /** 插件默认导出可能返回额外清理函数 */
  error?: string
}

const emptyHttp = createHttp('')

export class ClientRuntime {
  readonly registry = new Registry()
  readonly events = new EventTarget()
  readonly token: string
  readonly http: HttpClient

  /** 插件 id → 已加载记录 */
  readonly plugins = new Map<string, LoadedPlugin>()
  /** 插件 id → 作用域，供 ctx 查找 */
  readonly scopes = new Map<string, Scope>()
  /** 插件 id → 服务端随清单送来的初始状态 */
  private readonly pluginData = new Map<string, unknown>()

  private menuListeners = new Set<() => void>()
  private menu: MenuState | null = null

  constructor(options: ClientRuntimeOptions) {
    this.token = options.token
    this.http = options.http ?? (options.token ? createHttp(options.token) : emptyHttp)
  }

  // ---- 菜单状态：命令式 API 与 Hooks 的唯一交汇点 ----

  openMenu(menuId: string, x: number, y: number): void {
    this.menu = { menuId, x, y }
    this.emitMenu()
  }

  closeMenu(): void {
    if (!this.menu) return
    this.menu = null
    this.emitMenu()
  }

  getMenu(): MenuState | null {
    return this.menu
  }

  subscribeMenu(listener: () => void): () => void {
    this.menuListeners.add(listener)
    return () => {
      this.menuListeners.delete(listener)
    }
  }

  private emitMenu(): void {
    for (const listener of this.menuListeners) listener()
  }

  // ---- 插件生命周期 ----

  /**
   * 加载一个插件的前端入口。
   *
   * `files` 的第一项是入口，其余是预加载清单：入口先 import，剩余的交给
   * `modulepreload` 让浏览器提前拉取，避免打开页面时再等一次网络。
   */
  async loadPlugin(entry: ClientPluginEntry): Promise<LoadedPlugin> {
    const id = entry.id
    this.unloadPlugin(id)

    const scope = new Scope()
    const record: LoadedPlugin = { id, displayName: entry.displayName, scope }
    this.scopes.set(id, scope)
    this.plugins.set(id, record)
    if (entry.data !== undefined) this.pluginData.set(id, entry.data)

    const [entryUrl, ...preloads] = entry.files
    if (!entryUrl) {
      record.error = '清单缺少前端入口'
      return record
    }

    for (const href of preloads) this.preload(href)

    try {
      const mod = await import(/* @vite-ignore */ entryUrl)
      // 入口在异步 import 期间被卸载：丢弃结果，不执行插件代码
      if (scope.isDisposed) return record

      const activate = mod.default ?? mod.activate
      if (typeof activate !== 'function') {
        throw new TypeError('插件前端入口的默认导出不是函数')
      }

      const ctx = this.createContext(id, scope, entry.data)
      await activate(ctx, entry.data)

      // 默认导出可以返回清理函数，作为 `ctx.effect` 之外的便捷写法
      const extra = mod.dispose
      if (typeof extra === 'function') scope.add(() => extra())

      // 注册发生在本方法内，订阅者（React）看不到中间状态。
      // 少了这一次通知，重连后重放加载会「注册成功但界面仍是空的」。
      this.registry.notify()
    } catch (error) {
      record.error = (error as Error).message
      // 加载失败同样要清干净，否则半注册的页面会留在注册表里
      scope.dispose()
      this.plugins.delete(id)
      console.error(`[cordis-app] 插件 ${id} 前端加载失败:`, error)
    }
    return record
  }

  unloadPlugin(id: string): void {
    const record = this.plugins.get(id)
    if (!record) return
    record.scope.dispose()
    this.scopes.delete(id)
    this.plugins.delete(id)
    this.pluginData.delete(id)
    this.registry.notify()
  }

  /** 浏览器预取：失败不影响加载，只是少一次优化。 */
  private preload(href: string): void {
    if (typeof document === 'undefined') return
    const link = document.createElement('link')
    link.rel = 'modulepreload'
    link.href = href
    document.head.appendChild(link)
  }

  /** 服务端随清单送来的初始状态。 */
  getPluginData<T = unknown>(pluginId: string): T | undefined {
    return this.pluginData.get(pluginId) as T | undefined
  }

  createContext(pluginId: string, scope: Scope, data?: unknown): ClientContext {
    return createContextFor(this, pluginId, scope, data)
  }

  dispose(): void {
    for (const id of [...this.plugins.keys()]) this.unloadPlugin(id)
    this.registry.reset()
  }
}

/**
 * 上下文工厂。
 *
 * 所有注册调用都返回 `() => void` 并绑定在作用域上：插件卸载时页面、菜单、
 * 设置项全部自动消失，作者不需要写清理代码。
 */
function createContextFor(
  runtime: ClientRuntime,
  pluginId: string,
  scope: Scope,
  data: unknown,
): ClientContext {
  const { registry } = runtime

  const track = (dispose: () => void): (() => void) =>
    scope.add(() => {
      dispose()
      registry.notify()
    })

  const context: ClientContext = {
    id: pluginId,

    page(options) {
      return track(registry.addPage(pluginId, options).dispose)
    },

    slot(options) {
      return track(registry.addSlot(pluginId, options).dispose)
    },

    menu(menuId, items) {
      const entries = registry.addMenu(pluginId, menuId, items)
      return track(() => {
        for (const entry of entries) entry.dispose()
      })
    },

    action(id, options) {
      return track(registry.addAction(pluginId, id, options).dispose)
    },

    settings(options) {
      return track(registry.addSettings(pluginId, options).dispose)
    },

    http: runtime.http,

    appearance: {
      setTheme: (theme) => {
        applyTheme(theme)
      },
      setAccent: (color) => {
        applyAccent(color)
      },
    },

    emit(event, ...args) {
      runtime.events.dispatchEvent(new CustomEvent(event, { detail: args }))
    },

    on(event, handler) {
      const listener = (e: Event) => handler(...((e as CustomEvent).detail as unknown[]))
      runtime.events.addEventListener(event, listener)
      return track(() => runtime.events.removeEventListener(event, listener))
    },

    get data() {
      return data
    },

    /**
     * 打开一个子作用域。
     *
     * 名字只用于调试标识（日志里能看出是哪个子树），销毁仍然级联到插件根作用域——
     * 否则插件作者必须自己记住并手动释放每一个 isolate，与「零清理」的承诺相悖。
     */
    isolate(name) {
      const child = scope.child()
      child.label = `${pluginId}/${name}`
      const scoped = createContextFor(runtime, pluginId, child, data) as ScopedClientContext
      // 与 ClientContext 的唯一差别：多一个可单独撤销子树的入口
      scoped.dispose = () => {
        child.dispose()
        registry.notify()
      }
      return scoped
    },

    effect(fn) {
      const dispose = fn()
      return track(typeof dispose === 'function' ? dispose : () => {})
    },
  }

  return context
}
