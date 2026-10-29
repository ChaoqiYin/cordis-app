/**
 * 注册表的纯逻辑部分。
 *
 * 刻意与 React 解耦：注册、排序、id 展开、卸载都是同步的纯操作，
 * 这样它们可以被直接测试，也让「命令式 API 只在插件入口调用一次」这条边界
 * 在实现层面自然成立。
 */

import type {
  ActionOptions,
  MenuItem,
  PageOptions,
  RegisteredAction,
  RegisteredMenuItem,
  RegisteredPage,
  RegisteredSettings,
  RegisteredSlot,
  SettingsOptions,
  SlotOptions,
} from './types.js'

/**
 * 菜单项 id 的展开规则：
 *   `.reset`     → `<plugin-id>/reset`   相对 id
 *   `@separator` → 原样保留，框架所有
 *   `my-item`    → 原样保留，跨插件引用
 */
export function expandId(pluginId: string, id: string): string {
  if (id.startsWith('.')) return `${pluginId}/${id.slice(1)}`
  return id
}

/** `@` 命名空间完全归框架所有，插件不能注册、覆盖或删除其中的项。 */
export function isFrameworkItem(id: string): boolean {
  return id.startsWith('@')
}

/**
 * 框架内置菜单项。
 *
 * 插件可以在自己的菜单里**放置**这些项（决定位置与是否出现），但它们的
 * 外观由这张表决定——这就是「不能注册、覆盖或删除」的落点：`ctx.menu()`
 * 里写的 label 对 `@` 项一律无效。典型的用法正是这样：
 *
 *   ctx.menu('activity', [{ id: '.reset' }, { id: '@separator' }, { id: '.about' }])
 */
export const FRAMEWORK_MENU_ITEMS: Record<string, { kind: 'separator' | 'label'; label?: string }> = {
  '@separator': { kind: 'separator' },
}

export type RegistrationWarning = { pluginId: string; kind: string; message: string }

interface Entry<T> {
  value: T
  seq: number
  dispose: () => void
}

/** 按 order 升序，同序号按注册顺序稳定排序。 */
function compare<T extends { order?: number }>(a: Entry<T>, b: Entry<T>): number {
  const ao = a.value.order ?? 0
  const bo = b.value.order ?? 0
  if (ao !== bo) return ao - bo
  return a.seq - b.seq
}

export class Registry {
  private seq = 0
  private pages = new Map<string, Entry<RegisteredPage>>()
  private slots = new Map<string, Entry<RegisteredSlot>>()
  private menus = new Map<string, Entry<RegisteredMenuItem>>()
  private actions = new Map<string, Entry<RegisteredAction>>()
  private settings = new Map<string, Entry<RegisteredSettings>>()
  private listeners = new Set<() => void>()
  private warningListeners = new Set<(warning: RegistrationWarning) => void>()

  /**
   * 注册表版本号。每次增删都 +1。
   *
   * `useSyncExternalStore` 在每次渲染后都会重新调用 getSnapshot，并逐项比较
   * 返回值的引用。若 `listPages()` 之类每次都新建数组，比较永远不相等，React 会
   * 判定「快照一直在变」并陷入无限重渲染（运行时表现为 Minified React error #185）。
   * 所以列表结果按版本号缓存：同一个版本内返回同一个数组实例。
   */
  private version = 0
  private readonly snapshotCache = new Map<string, { version: number; value: unknown[] }>()

  private nextSeq(): number {
    return this.seq++
  }

  /** 标记数据已变：递增版本号，让所有缓存快照失效。 */
  private touch(): void {
    this.version++
  }

  /** 取缓存快照；版本相同则复用上一次的数组实例。 */
  private memo<T>(key: string, build: () => T[]): T[] {
    const hit = this.snapshotCache.get(key)
    if (hit && hit.version === this.version) return hit.value as T[]
    const value = build()
    this.snapshotCache.set(key, { version: this.version, value })
    return value
  }

  /**
   * 从表里移除自己，但只在「表里现在装的就是自己」时动手。
   *
   * 少了这层校验，两个插件注册同一个页面路径时，先注册者卸载会把后注册者的
   * 条目一起删掉——页面在毫无征兆的情况下消失，且无法通过日志定位。
   */
  private remove<T>(table: Map<string, Entry<T>>, key: string, entry: Entry<T>): void {
    if (table.get(key) === entry) {
      table.delete(key)
      this.touch()
    }
  }

  private warn(warning: RegistrationWarning): void {
    for (const listener of this.warningListeners) listener(warning)
  }

  addPage(pluginId: string, options: PageOptions): Entry<RegisteredPage> {
    const existing = this.pages.get(options.path)
    if (existing && existing.value.pluginId !== pluginId) {
      // 后注册者被拒绝：路径是 URL 的一部分，谁先占住谁生效，比「后来者悄悄覆盖」
      // 更容易解释。插件仍然照常运行，只是这个页面不会出现。
      this.warn({
        pluginId,
        kind: 'page',
        message: `页面路径 ${options.path} 已被插件 ${existing.value.pluginId} 占用，本次注册被忽略`,
      })
      return { value: { ...options, pluginId, seq: -1 }, seq: -1, dispose: () => {} }
    }

    const seq = this.nextSeq()
    const entry: Entry<RegisteredPage> = {
      value: { ...options, pluginId, seq },
      seq,
      dispose: () => this.remove(this.pages, options.path, entry),
    }
    if (existing) entry.dispose() // 同插件重复注册同一路径：以最后一次为准
    this.pages.set(options.path, entry)
    this.touch()
    return entry
  }

  addSlot(pluginId: string, options: SlotOptions): Entry<RegisteredSlot> {
    const seq = this.nextSeq()
    const key = `${pluginId}:${options.type}:${seq}`
    const entry: Entry<RegisteredSlot> = {
      value: { ...options, pluginId, seq },
      seq,
      dispose: () => this.remove(this.slots, key, entry),
    }
    this.slots.set(key, entry)
    this.touch()
    return entry
  }

  addMenu(pluginId: string, menuId: string, items: MenuItem[]): Entry<RegisteredMenuItem>[] {
    const added: Entry<RegisteredMenuItem>[] = []
    for (const item of items) {
      // `@` 项不能由插件定义，但可以放置：位置由插件给，外观由框架给。
      if (isFrameworkItem(item.id)) {
        const builtin = FRAMEWORK_MENU_ITEMS[item.id]
        if (!builtin) {
          this.warn({
            pluginId,
            kind: 'menu',
            message: `框架菜单项 ${item.id} 不存在，已忽略`,
          })
          continue
        }
        const key = `${menuId}::${item.id}`
        // 同一个内置项在一个菜单里只出现一次；重复放置等价于调整位置
        const prev = this.menus.get(key)
        prev?.dispose()

        const seq = this.nextSeq()
        const entry: Entry<RegisteredMenuItem> = {
          value: {
            id: item.id,
            label: builtin.label,
            kind: builtin.kind,
            order: item.order,
            disabled: true,
            pluginId,
            seq,
          },
          seq,
          dispose: () => this.remove(this.menus, key, entry),
        }
        this.menus.set(key, entry)
        this.touch()
        added.push(entry)
        continue
      }

      const id = expandId(pluginId, item.id)
      const key = `${menuId}::${id}`
      const prev = this.menus.get(key)
      if (prev && prev.value.pluginId !== pluginId) {
        this.warn({
          pluginId,
          kind: 'menu',
          message: `菜单项 id ${id} 已被插件 ${prev.value.pluginId} 占用，本次注册被忽略`,
        })
        continue
      }
      prev?.dispose()

      const seq = this.nextSeq()
      const entry: Entry<RegisteredMenuItem> = {
        value: { ...item, id, kind: 'item', pluginId, seq } as RegisteredMenuItem,
        seq,
        dispose: () => this.remove(this.menus, key, entry),
      }
      this.menus.set(key, entry)
      this.touch()
      added.push(entry)
    }
    return added
  }

  addAction(pluginId: string, id: string, options: ActionOptions): Entry<RegisteredAction> {
    const fullId = expandId(pluginId, id)
    const entry: Entry<RegisteredAction> = {
      value: { ...options, id: fullId, pluginId },
      seq: this.nextSeq(),
      dispose: () => this.remove(this.actions, fullId, entry),
    }
    this.actions.set(fullId, entry)
    this.touch()
    return entry
  }

  addSettings(pluginId: string, options: SettingsOptions): Entry<RegisteredSettings> {
    const key = `${pluginId}:${options.id}`
    const seq = this.nextSeq()
    const entry: Entry<RegisteredSettings> = {
      value: { ...options, pluginId, seq } as RegisteredSettings,
      seq,
      dispose: () => this.remove(this.settings, key, entry),
    }
    this.settings.set(key, entry)
    this.touch()
    return entry
  }

  listPages(): RegisteredPage[] {
    return this.memo('pages', () => [...this.pages.values()].sort(compare).map((e) => e.value))
  }

  getPage(path: string): RegisteredPage | undefined {
    return this.pages.get(path)?.value
  }

  listSlots(type: string): RegisteredSlot[] {
    return this.memo(`slots:${type}`, () =>
      [...this.slots.values()]
        .filter((e) => e.value.type === type)
        .sort(compare)
        .map((e) => e.value),
    )
  }

  listMenu(menuId: string): RegisteredMenuItem[] {
    return this.memo(`menu:${menuId}`, () => {
      const prefix = `${menuId}::`
      return [...this.menus.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([, a], [, b]) => compare(a, b))
        .map(([, e]) => e.value)
    })
  }

  listSettings(): RegisteredSettings[] {
    return this.memo('settings', () =>
      [...this.settings.values()].sort(compare).map((e) => e.value),
    )
  }

  /** 按快捷键查行为：`CmdOrCtrl+Shift+P` 这类写法归一化后比较。 */
  findActionByShortcut(shortcut: string): RegisteredAction | undefined {
    const normalized = normalizeShortcut(shortcut)
    for (const entry of this.actions.values()) {
      if (!entry.value.shortcut) continue
      if (normalizeShortcut(entry.value.shortcut) === normalized) return entry.value
    }
    return undefined
  }

  listActions(): RegisteredAction[] {
    return [...this.actions.values()].map((e) => e.value)
  }

  findAction(id: string): RegisteredAction | undefined {
    return this.actions.get(id)?.value
  }

  /** 订阅变更，供 React 层触发重渲染。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onWarning(listener: (warning: RegistrationWarning) => void): () => void {
    this.warningListeners.add(listener)
    return () => {
      this.warningListeners.delete(listener)
    }
  }

  notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** 清空全部注册。仅用于测试与整页重载。 */
  reset(): void {
    this.pages.clear()
    this.slots.clear()
    this.menus.clear()
    this.actions.clear()
    this.settings.clear()
    this.touch()
    this.notify()
  }
}

/**
 * 快捷键归一化：`CmdOrCtrl+Shift+P`、`Ctrl+Shift+P`、`cmd+shift+p` 视为同一个。
 *
 * `CmdOrCtrl` 展开成平台的主修饰键——插件写一次，两个平台都对。
 */
export function normalizeShortcut(shortcut: string): string {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
  const parts = shortcut
    .split('+')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)

  const modifiers = new Set<string>()
  let key = ''
  for (const part of parts) {
    if (part === 'cmdorctrl' || part === 'mod') modifiers.add(isMac ? 'meta' : 'ctrl')
    else if (part === 'cmd' || part === 'meta' || part === 'command') modifiers.add('meta')
    else if (part === 'ctrl' || part === 'control') modifiers.add('ctrl')
    else if (part === 'alt' || part === 'option') modifiers.add('alt')
    else if (part === 'shift') modifiers.add('shift')
    else key = part
  }

  const order = ['ctrl', 'meta', 'alt', 'shift']
  return [...order.filter((m) => modifiers.has(m)), key].join('+')
}

/**
 * 把 DOM 事件归一化成与 normalizeShortcut 同一形状。
 *
 * 修饰键单独按下不算快捷键，返回空串——否则 Cmd 按下就会被当成一条绑定。
 */
export function shortcutFromEvent(event: KeyboardEvent): string {
  const modifiers: string[] = []
  if (event.ctrlKey) modifiers.push('ctrl')
  if (event.metaKey) modifiers.push('meta')
  if (event.altKey) modifiers.push('alt')
  if (event.shiftKey) modifiers.push('shift')
  const key = event.key.toLowerCase()
  if (key === 'control' || key === 'meta' || key === 'alt' || key === 'shift') return ''
  return normalizeShortcut([...modifiers, key].join('+'))
}
