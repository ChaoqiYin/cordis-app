/**
 * `cordis-app/client` —— 插件前端依赖的唯一模块。
 *
 * 它随框架 UI 一起构建成 `/__shared/client.js`，插件 bundle 把裸模块名标为
 * external，浏览器经 import map 解析到同一份实例。因此这里的运行时状态
 * （注册表、作用域、事件总线）在全页面只有一份——这是插件与宿主能共用 React
 * 的同一套机制的另一半（shared-modules.mjs）。
 *
 * 宿主 UI 也从这里取 Hooks 与组件，不另写一套，避免「插件侧和宿主侧行为不同」。
 */

export { ClientRuntime, Scope } from './runtime.js'
export type { ClientRuntimeOptions, LoadedPlugin, MenuState } from './runtime.js'

export { Registry, expandId, isFrameworkItem, normalizeShortcut, FRAMEWORK_MENU_ITEMS } from './registry.js'
export type { RegistrationWarning } from './registry.js'

export { bootstrapToken, createHttp, HttpError, waitForHealthy } from './http.js'
export { fetchManifest } from './manifest.js'
export { restoreAppearance, applyAccent, applyTheme } from './appearance.js'
export type { Theme } from './appearance.js'

export {
  RuntimeContext,
  Slot,
  useAppearance,
  useMenu,
  useMenuAction,
  useMenuItems,
  useMenuState,
  usePages,
  usePluginData,
  usePluginLoaded,
  useRuntime,
  useSettings,
  useShortcuts,
  useSlots,
} from './hooks.js'

export type {
  ActionOptions,
  AppearanceApi,
  ClientContext,
  ExtensionComponent,
  HttpClient,
  MenuItem,
  MenuTrigger,
  PageOptions,
  PluginClientEntry,
  RegisteredAction,
  RegisteredMenuItem,
  RegisteredPage,
  RegisteredSettings,
  RegisteredSlot,
  RequestConfig,
  ScopedClientContext,
  SettingsOptions,
  SlotOptions,
} from './types.js'
