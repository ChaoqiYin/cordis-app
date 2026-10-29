/**
 * 聚合包根入口。
 *
 * v1 不在这里提供任何运行时值：服务端类型走 `cordis-app/server`，前端走
 * `cordis-app/client`，构建预设走 `cordis-app/preset`，CLI 走 bin。
 * 根入口留空是有意的——插件若 `import 'cordis-app'` 拿不到能力，
 * 就不会在产物里留下一条只能在框架进程内解析的运行时依赖。
 */

export {}
