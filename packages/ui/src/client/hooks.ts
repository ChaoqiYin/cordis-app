/**
 * 面向插件作者的 React 绑定。
 *
 * 命令式 API 负责注册，Hooks 负责在组件内读取状态。两者的分界线是：命令式只在插件入口调用一次，组件里一律用 Hooks 或 `<Slot>`。
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { ClientRuntime, MenuState } from './runtime.js'
import { shortcutFromEvent } from './registry.js'
import type { RegisteredMenuItem, RegisteredPage, RegisteredSettings, RegisteredSlot } from './types.js'

/** 运行时由宿主注入；插件拿不到这个 Context，只能通过下面的 Hooks。 */
export const RuntimeContext = createContext<ClientRuntime | null>(null)

export function useRuntime(): ClientRuntime {
  const runtime = useContext(RuntimeContext)
  if (!runtime) throw new Error('useRuntime 必须在框架 UI 内使用')
  return runtime
}

/**
 * 订阅注册表变更。
 *
 * 注册表是外部可变状态，用 useSyncExternalStore 订阅；快照函数必须是稳定引用，
 * 否则每次渲染都会重新订阅。
 */
function useRegistry<T>(read: (runtime: ClientRuntime) => T): T {
  const runtime = useRuntime()
  const subscribe = useCallback((listener: () => void) => runtime.registry.subscribe(listener), [runtime])
  return useSyncExternalStore(
    subscribe,
    useCallback(() => read(runtime), [runtime, read]),
    useCallback(() => read(runtime), [runtime, read]),
  )
}

const readPages = (runtime: ClientRuntime) => runtime.registry.listPages()
const readSettings = (runtime: ClientRuntime) => runtime.registry.listSettings()

export function usePages(): RegisteredPage[] {
  return useRegistry(readPages)
}

export function useSettings(): RegisteredSettings[] {
  return useRegistry(readSettings)
}

export function useSlots(type: string): RegisteredSlot[] {
  const runtime = useRuntime()
  const subscribe = useCallback((listener: () => void) => runtime.registry.subscribe(listener), [runtime])
  const read = useCallback(() => runtime.registry.listSlots(type), [runtime, type])
  return useSyncExternalStore(subscribe, read, read)
}

/** 绑定一个菜单 id，返回在 `contextmenu` 事件上直接调用的触发器。 */
export function useMenu(menuId: string): (event: {
  preventDefault(): void
  clientX: number
  clientY: number
}) => void {
  const runtime = useRuntime()
  return useCallback(
    (event) => {
      event.preventDefault()
      runtime.openMenu(menuId, event.clientX, event.clientY)
    },
    [runtime, menuId],
  )
}

export function useMenuState(): MenuState | null {
  const runtime = useRuntime()
  const subscribe = useCallback((listener: () => void) => runtime.subscribeMenu(listener), [runtime])
  const read = useCallback(() => runtime.getMenu(), [runtime])
  return useSyncExternalStore(subscribe, read, read)
}

const EMPTY_ITEMS: RegisteredMenuItem[] = []

export function useMenuItems(menuId: string | null): RegisteredMenuItem[] {
  const runtime = useRuntime()
  const subscribe = useCallback((listener: () => void) => runtime.registry.subscribe(listener), [runtime])
  const read = useCallback(
    () => (menuId ? runtime.registry.listMenu(menuId) : EMPTY_ITEMS),
    [runtime, menuId],
  )
  return useSyncExternalStore(subscribe, read, read)
}

/** 执行菜单项对应的行为。行为按完整 id 配对。 */
export function useMenuAction(): (id: string) => void {
  const runtime = useRuntime()
  return useCallback(
    (id: string) => {
      const action = runtime.registry.findAction(id)
      if (!action || action.disabled) return
      void Promise.resolve()
        .then(() => action.action())
        .catch((error) => console.error(`[cordis-app] 菜单项 ${id} 执行失败:`, error))
    },
    [runtime],
  )
}

/** 读取插件的初始状态（服务端导出的 data，随清单送达）。 */
export function usePluginData<T = unknown>(pluginId: string): T | undefined {
  const runtime = useRuntime()
  return runtime.getPluginData<T>(pluginId)
}

export function useAppearance(): {
  theme: 'dark' | 'light' | 'auto'
  setTheme(theme: 'dark' | 'light' | 'auto'): void
  setAccent(color: string): void
} {
  const [theme, setThemeState] = useState<'dark' | 'light' | 'auto'>(
    () => (document.documentElement.getAttribute('data-theme') as 'dark' | 'light' | null) ?? 'auto',
  )
  const setTheme = useCallback((next: 'dark' | 'light' | 'auto') => {
    const root = document.documentElement
    if (next === 'auto') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', next)
    try {
      localStorage.setItem('cordis-app/theme', next)
    } catch {
      // 隐私模式下忽略
    }
    setThemeState(next)
  }, [])
  const setAccent = useCallback((color: string) => {
    document.documentElement.style.setProperty('--accent', color)
    try {
      localStorage.setItem('cordis-app/accent', color)
    } catch {
      // 忽略
    }
  }, [])
  return { theme, setTheme, setAccent }
}

/**
 * 具名插槽的消费端。
 *
 *   <Slot name="header.right" />
 *
 * 顺序由 `order` 决定，同序号按注册顺序稳定排序——由注册表保证，这里只渲染。
 */
export function Slot(props: { name: string; className?: string }): ReactNode {
  const slots = useSlots(props.name)
  if (slots.length === 0) return null
  return createElement(
    'div',
    { className: props.className, 'data-slot': props.name },
    slots.map((slot, index) =>
      createElement(slot.component as never, { key: `${slot.pluginId}-${slot.seq}-${index}` }),
    ),
  )
}

/**
 * 全局快捷键绑定。
 *
 * 只在「非输入态」触发，否则在文本框里按 Cmd+S 会同时保存和输入。
 */
export function useShortcuts(): void {
  const runtime = useRuntime()
  const handler = useRef<(event: KeyboardEvent) => void>(() => {})

  handler.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null
    if (target) {
      const tag = target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return
    }
    const action = runtime.registry.findActionByShortcut(shortcutFromEvent(event))
    if (!action || action.disabled) return
    event.preventDefault()
    void Promise.resolve(action.action()).catch((error) =>
      console.error(`[cordis-app] 快捷键 ${action.shortcut} 执行失败:`, error),
    )
  }

  useEffect(() => {
    const listener = (event: KeyboardEvent) => handler.current(event)
    window.addEventListener('keydown', listener)
    return () => window.removeEventListener('keydown', listener)
  }, [])
}

/** 插件是否已加载（用于依赖其他插件的组件做降级渲染）。 */
export function usePluginLoaded(pluginId: string): boolean {
  const runtime = useRuntime()
  const subscribe = useCallback((listener: () => void) => runtime.registry.subscribe(listener), [runtime])
  const read = useCallback(() => runtime.plugins.has(pluginId), [runtime, pluginId])
  return useSyncExternalStore(subscribe, read, read)
}
