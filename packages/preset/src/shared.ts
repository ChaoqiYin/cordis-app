/**
 * 前端共享模块白名单（架构文档 5.4）。
 *
 * 这张表必须与 UI 侧 shared-modules.mjs、index.html 的 import map 完全一致：
 * 插件 bundle 把这里列的模块标为 external，浏览器经 import map 解析到框架提供
 * 的同一份实例。三者只要有一处不一致，就会出现「插件正常、宿主正常、但 hooks
 * 互相不认账」——React 通常会直接抛 invalid hook call。
 *
 * 白名单之外的依赖一律打进插件自己的 bundle。这是刻意的保守选择：多打一份
 * lodash 只是体积问题，少打一份 React 是正确性问题。
 */
export const SHARED_MODULES = [
  'react',
  'react-dom',
  'react-dom/client',
  'react/jsx-runtime',
  'cordis-app/client',
] as const

export type SharedModule = (typeof SHARED_MODULES)[number]

/**
 * 服务端核心包。插件必须声明为 peerDependency（架构文档 5.4 ②）。
 *
 * 框架核心包持有服务注册表与事件总线，第二份会让插件各自正常但彼此失联。
 */
export const CORE_PACKAGE = 'cordis-app'

/** 判断一个导入是否应由框架提供（不打进插件 bundle）。 */
export function isShared(specifier: string): boolean {
  return (SHARED_MODULES as readonly string[]).includes(specifier)
}

/**
 * 前端共享模块的版本约束。
 *
 * 框架前端的 React 只有一份，第二个实例必然导致 hooks 崩溃（架构文档 5.6）。
 * 安装阶段比对这些范围，不兼容就硬失败——把问题推迟到运行时会表现为玄学故障。
 */
export const SHARED_PEER_RANGES: Record<string, string> = {
  react: '^19.0.0',
  'react-dom': '^19.0.0',
  [CORE_PACKAGE]: '^1.0.0',
}
