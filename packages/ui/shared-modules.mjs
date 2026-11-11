/**
 * 前端共享模块的宿主侧视图。
 *
 * 唯一真源是 `@cordis-app/protocol` 的 `SHARED_MODULE_TABLE`。这个文件只把它
 * 整理成构建脚本需要的形状，服务三处消费者：
 *   1. scripts/build-shared.mjs —— 产出 /__shared/*.js
 *   2. vite.config.ts          —— 把宿主 bundle 里的这些 import 标为 external
 *   3. index.html 的 import map —— 浏览器解析裸模块名
 *
 * 三者只要有一处单独改，就会出现「宿主与插件各持一份 React」，hooks 立刻崩溃。
 * 因此这里不再保存任何清单，只做视图。
 */

import { SHARED_MODULE_TABLE, SHARED_PREFIX } from '@cordis-app/protocol'

export { SHARED_PREFIX }

/** 共享模块：说明符 + 产物文件名 + 构建入口 + 需要 external 的其它共享模块。 */
export const SHARED_MODULES = Object.entries(SHARED_MODULE_TABLE).map(([specifier, definition]) => ({
  specifier,
  ...definition,
}))

export const SHARED_SPECIFIERS = SHARED_MODULES.map((m) => m.specifier)

/**
 * 各构建态的产物目录名（相对 packages/ui）。
 *
 * 目录名属于 ui 包内部实现，不进入协议层或浏览器 URL；构建脚本、开发服务器
 * 与 ui 包内测试统一从这里读取，避免各写一份字面量。
 */
export const SHARED_PROFILE_DIRS = {
  development: 'shared-dev',
  production: 'shared',
}

/** 产物首部的构建态标记；消费端据此拒绝跨构建态复用。 */
export function sharedProfileMarker(profile) {
  return `/* cordis-app:shared-profile:${profile} */`
}

/** 共享模块产物缺失或不匹配时给出的修复命令。 */
export const SHARED_BUILD_COMMAND = 'pnpm --filter @cordis-app/ui build'

/** 浏览器 import map 的 `imports` 字段。 */
export function importMap() {
  return {
    imports: Object.fromEntries(
      SHARED_MODULES.map((m) => [m.specifier, `${SHARED_PREFIX}/${m.file}`]),
    ),
  }
}
