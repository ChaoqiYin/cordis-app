/**
 * `cordis-app/client` —— 插件前端的公开面。
 *
 * 这里不复制任何实现，只转出 UI 包现有的客户端入口。真正的共享模块仍然是
 * `@cordis-app/protocol` 的 `SHARED_MODULE_TABLE` 里那条 `cordis-app/client`，
 * 由 UI 包的 `src/client/index.ts` 构建成 `/__shared/client.js`。
 *
 * 也就是说：插件 typecheck 时从这里拿类型，运行时经 import map 拿到同一份
 * 由框架构建的实例；聚合包只负责「说明符能解析」，不负责「再实现一遍」。
 */

export * from '@cordis-app/ui'
