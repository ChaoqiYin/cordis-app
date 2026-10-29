/**
 * 协议层里浏览器可用的部分。
 *
 * 与 `index.ts` 的区别只有一个：不含 `paths.ts`——它依赖 `node:os` / `node:path`，
 * 而前端 bundle 会把整个 barrel 一并打进来，于是 `node:os` 就成了打包错误。
 * 这也是设置这个分入口的全部理由：调用方按运行环境选择，而不是靠 tree-shaking
 * 祈祷它能把副作用式的 Node 导入摇掉。
 */

export * from './constants.js'
export * from './types.js'
export * from './handshake.js'
export * from './readiness.js'
