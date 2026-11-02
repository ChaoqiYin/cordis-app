/**
 * `cordis-app/server` —— 服务端插件作者看到的类型面。
 *
 * v1 只做类型转出：编译后的模块没有任何运行时导出。插件继续写
 *
 *   export const name = '…'
 *   export const inject = ['router']
 *   export function apply(ctx) { … }
 *
 * 由 worker 提供 `ctx`；插件不需要、也不应该从聚合包导入运行时代码。
 * 一旦这里出现运行时值，插件产物就会留下一条 `import 'cordis-app'`，
 * 而框架并不会在插件目录里为它提供可解析的实现。
 */

export type * from '@cordis-app/kernel'
