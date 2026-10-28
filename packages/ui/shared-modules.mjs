/**
 * 前端共享模块的唯一真源。
 *
 * 三处需要同一份定义：
 *   1. scripts/build-shared.mjs —— 产出 /__shared/*.js
 *   2. vite.config.ts          —— 把宿主 bundle 里的这些 import 标为 external
 *   3. index.html 的 import map —— 浏览器解析裸模块名
 *
 * 任何一处单独改都会导致「宿主与插件拿到两份 React」，也就是 hooks 崩溃。
 * 所以三者都从这里读。
 */

/** 浏览器里的共享路径前缀，与 protocol 的 SHARED_PREFIX 一致。 */
export const SHARED_PREFIX = '/__shared'

/**
 * 共享模块：裸模块名 → { 产物文件名, 入口, 需要 external 的模块 }。
 *
 * `entry` 是真实模块名或 `src/` 下的文件路径。裸模块名由 build-shared.mjs
 * 在构建时枚举其导出名、生成显式的再导出入口（详见该脚本的注释）。
 *
 * `externals` 里只能出现本表自己的键——共享模块之间互相引用时也必须走同一份实例，
 * 否则 react-dom 会带进第二份 react。
 */
export const SHARED_MODULES = [
  {
    specifier: 'react',
    file: 'react.js',
    entry: 'react',
    externals: [],
  },
  {
    specifier: 'react-dom',
    file: 'react-dom.js',
    entry: 'react-dom',
    externals: ['react'],
  },
  {
    specifier: 'react-dom/client',
    file: 'react-dom-client.js',
    entry: 'react-dom/client',
    externals: ['react', 'react-dom'],
  },
  {
    specifier: 'react/jsx-runtime',
    file: 'jsx-runtime.js',
    entry: 'react/jsx-runtime',
    externals: ['react'],
  },
  {
    specifier: 'cordis-app/client',
    file: 'client.js',
    entry: 'src/client/index.ts',
    externals: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  },
]

export const SHARED_SPECIFIERS = SHARED_MODULES.map((m) => m.specifier)

/** 浏览器 import map 的 `imports` 字段。 */
export function importMap() {
  return {
    imports: Object.fromEntries(
      SHARED_MODULES.map((m) => [m.specifier, `${SHARED_PREFIX}/${m.file}`]),
    ),
  }
}
