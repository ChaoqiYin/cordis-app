/**
 * `@cordis-app/ui/host` —— 项目 body 的宿主出口。
 *
 * 框架只固定宿主职责（快捷键、全局菜单、顶层错误边界）和四个 UI 出口；
 * 布局、导航、项目页面与样式由项目 body 自己决定。默认 body 是参考实现。
 *
 * 这个入口必须能在 Node 里被 `react-dom/server` 渲染，因此不 import 任何 CSS。
 */

export { BodyHost } from './BodyHost.js'
export { DefaultBody, SETTINGS_PATH } from './DefaultBody.js'
export { ErrorBoundary } from './ErrorBoundary.js'
export { PluginMenuTrigger } from './PluginMenuTrigger.js'
export { PluginPageOutlet } from './PluginPageOutlet.js'
export { PluginSlot } from './PluginSlot.js'
export { SettingsPanel } from './SettingsPanel.js'
export {
  currentPath,
  installHistoryListener,
  navigate,
  subscribePath,
  useNavigate,
  usePath,
} from './router.js'
export { warnUiCompatibility, warnUiContractVersion } from './capabilities.js'

// 菜单触发器与插件侧共用同一个 hook，避免 body 自己再实现一套
export { useMenu } from 'cordis-app/client'
