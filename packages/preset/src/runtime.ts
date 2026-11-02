/**
 * 服务端产物在 Node 上运行所需的公共构建片段。
 *
 * 服务端预设与桌面运行时打包器（packages/shell/scripts/package-desktop.mjs）
 * 共用这里的 banner 与可选原生依赖规则：两边都要让 CJS 依赖里的动态
 * `require` 可用，并把 `ws` 的可选原生依赖置空。这里共享的是这些片段，
 * 不是整个 esbuild 配置；复制两份规则迟早会漂移，所以只保留这一份。
 */

import type { Plugin } from 'esbuild'

/**
 * 服务端产物的 Node 构建目标。
 *
 * 服务端预设与桌面运行时打包器共用这一个值：两边若各写一份，构建目标就会
 * 再次漂移。运行环境下限由仓库根的 `engines.node` 表达。
 */
export const NODE_TARGET = 'node24'

/** 需要解析成内联空模块的可选原生依赖。 */
const OPTIONAL_NATIVE_MODULE_PATTERN = /^(bufferutil|utf-8-validate)$/

/**
 * banner 的唯一标识。
 *
 * 构建器重新打包已由本预设产出的入口时，靠它判断是否已经注入过 banner；
 * 再次注入会重复声明这个导入，产物加载时直接抛语法错误。
 */
export const RUNTIME_BANNER_MARKER = '__cordisAppCreateRequire'

/**
 * 用 createRequire 补齐 ESM 下的 require。
 *
 * CJS 依赖里的 `require('events')` 之类动态调用会被 esbuild 保留成
 * `__require`；没有这个 banner 就会在加载时抛
 * 「Dynamic require of "events" is not supported」。
 */
export const RUNTIME_BANNER = [
  `import { createRequire as ${RUNTIME_BANNER_MARKER} } from 'node:module';`,
  `const require = ${RUNTIME_BANNER_MARKER}(import.meta.url);`,
].join('\n')

/**
 * 关闭 ws 的可选原生加速分支。
 *
 * 空模块能让 esbuild 完成解析，但 ws 会在 `require` 成功后改用
 * `bufferUtil.mask/unmask`；空对象没有这些函数，大消息就会在运行期崩溃。
 * 显式定义这两个开关，让 ws 走自带的纯 JS 回退。
 */
export const RUNTIME_DEFINE = {
  'process.env.WS_NO_BUFFER_UTIL': '"true"',
  'process.env.WS_NO_UTF_8_VALIDATE': '"true"',
} as const

/** 把可选原生依赖解析成内联空模块。 */
export function optionalNativeModulesPlugin(): Plugin {
  return {
    name: 'cordis-app-optional-native-modules',
    setup(build) {
      build.onResolve(
        { filter: OPTIONAL_NATIVE_MODULE_PATTERN },
        (args) => ({ path: args.path, namespace: 'cordis-app-empty' }),
      )
      build.onLoad({ filter: /.*/, namespace: 'cordis-app-empty' }, () => ({
        contents: 'export {}',
        loader: 'js',
      }))
    },
  }
}

/**
 * `@cordis-app/*` 是框架内部包，不是公开契约。
 *
 * 类型导入在转译前就会被擦除，不会经过解析；只有值导入会命中这里。
 */
export function internalPackageGuardPlugin(): Plugin {
  return {
    name: 'cordis-app-internal-packages',
    setup(build) {
      build.onResolve({ filter: /^@cordis-app\// }, (args) => ({
        errors: [
          {
            text:
              `“${args.path}” 是 @cordis-app 内部包，不能在插件入口值导入` +
              `（导入方：${args.importer}）。` +
              '服务端运行时能力请从 ctx 获取；只需要类型时改用 `import type`。',
          },
        ],
      }))
    },
  }
}
