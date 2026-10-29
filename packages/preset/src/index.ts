/**
 * 插件打包预设。
 *
 * 两条独立的构建路径，产物形态不同：
 *   - 服务端入口（Node）→ ESM，外部化 peers 与 node 内置模块
 *   - 前端入口（浏览器）→ ESM，外部化共享白名单，由 import map 提供
 *
 * 之所以不提供「一条命令打完两者」的封装，是因为它们的目标平台与 external
 * 规则都不同，合并只会让配置里出现大量 `mode === 'client' ? … : …`。
 * 插件作者在 package.json 里挂两个 script 即可。
 */

import type { BuildOptions } from 'esbuild'
import { SHARED_MODULES, CORE_PACKAGE } from './shared.js'

export interface PresetOptions {
  /** 入口文件，相对插件根目录 */
  entry: string
  /** 产物路径，相对插件根目录 */
  outfile?: string
  /** 插件根目录，默认 process.cwd() */
  root?: string
  /** 是否生成 sourcemap，默认 true */
  sourcemap?: boolean
  /** 生产构建（压缩、去调试代码），默认按 NODE_ENV 判断 */
  minify?: boolean
}

function common(options: PresetOptions, browser: boolean): BuildOptions {
  return {
    entryPoints: [options.entry],
    outfile: options.outfile,
    absWorkingDir: options.root,
    bundle: true,
    // 框架与插件都要求 Node 24 / 现代浏览器，不需要降级语法
    target: browser ? 'es2022' : 'node24',
    platform: browser ? 'browser' : 'node',
    format: 'esm',
    sourcemap: options.sourcemap ?? true,
    minify: options.minify ?? process.env.NODE_ENV === 'production',
    // 保留函数名，日志与错误栈里能看出是哪个插件函数
    keepNames: true,
    logLevel: 'info',
    // 插件不应该假设自己打包时一定有这个全局
    define: browser ? { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') } : {},
  }
}

/**
 * 服务端入口的构建配置。
 *
 * `packages: 'external'` 让所有 npm 依赖留在 node_modules 里由 Node 解析——
 * 包括多版本共存的情况。插件作者不需要关心哪些该 external，
 * 也不会因为打包进 lodash 而在另一个插件需要不同版本时冲突。
 *
 * 例外是 `cordis-app`：它是 peerDependency，由框架提供，必须 external 且
 * 由安装阶段的校验保证只有一份。
 */
export function serverPreset(options: PresetOptions): BuildOptions {
  const build = common(options, false)
  return {
    ...build,
    // 不 bundle 任何包：服务端的模块解析交给 Node，这正是多版本共存的落点
    packages: 'external',
    external: [CORE_PACKAGE],
  }
}

/**
 * 前端入口的构建配置。
 *
 * 只外部化共享白名单，其余依赖（UI 库、工具函数）全部打进 bundle。这样插件
 * 前端是「一个文件就能跑」的形态，不需要在数据目录里再装一份前端依赖。
 */
export function clientPreset(options: PresetOptions): BuildOptions {
  const build = common(options, true)
  return {
    ...build,
    external: [...SHARED_MODULES],
    // 前端产物要能独立分发：CSS 之类的资源内联进去，避免额外的相对路径
    loader: {
      '.woff2': 'dataurl',
      '.woff': 'dataurl',
      '.ttf': 'dataurl',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.svg': 'dataurl',
    },
  }
}

export { SHARED_MODULES, CORE_PACKAGE, isShared } from './shared.js'
export type { SharedModule } from './shared.js'
