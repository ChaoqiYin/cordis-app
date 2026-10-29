/**
 * 前端共享模块白名单（插件构建视角）。
 *
 * 唯一真源是 `@cordis-app/protocol` 的 `SHARED_MODULE_TABLE`：UI 构建、import map
 * 与安装期 peer 校验都从同一张表派生。这里只做转出，避免「插件构建预设」与
 * 「框架」对哪些模块共享产生第二个答案——一旦漂移，插件与宿主就会各持一份
 * React，表现为 invalid hook call。
 */

import { CORE_PACKAGE, SHARED_MODULES, type SharedModule } from '@cordis-app/protocol'

export { CORE_PACKAGE, SHARED_MODULES }
export type { SharedModule }

/** 判断一个导入是否应由框架提供（不打进插件 bundle）。 */
export function isShared(specifier: string): boolean {
  return (SHARED_MODULES as readonly string[]).includes(specifier)
}
