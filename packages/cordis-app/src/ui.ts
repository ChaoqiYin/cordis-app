/**
 * `cordis-app/ui` —— 项目 body 的宿主出口。
 *
 * 实现全部来自 `@cordis-app/ui/host`；聚合包只提供稳定的说明符。这个入口
 * 不 import 样式，可以被项目构建打进 body，也可以在 Node 里 SSR 渲染。
 */

export * from '@cordis-app/ui/host'
