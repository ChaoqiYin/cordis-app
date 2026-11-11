/**
 * 构建共享模块 → dist/shared/（生产）或 dist/shared-dev/（开发）。
 *
 * 构建态由第一个命令行参数给出：`development` 或 `production`。每个构建态
 * 必须用独立进程运行——shim 在构建期 `require()` 真实模块来枚举具名导出，
 * 而 React 的 `react-dom` 按进程里的 NODE_ENV 选择 development / production
 * 入口，两者的导出集合并不相同。进程内切换 NODE_ENV 会命中模块缓存。
 *
 * 构建态只影响三件事：`NODE_ENV` 的构建期替换、压缩、sourcemap。入口、
 * 产物文件名、共享模块之间的 external 关系在两个构建态下完全一致，浏览器
 * URL 因此不需要条件分支。产物首部写 profile 标记，消费端据此校验。
 *
 * 为什么不能直接 `export * from 'react'`：React 是 CJS 包，其 index.js 是
 * `module.exports = require('./cjs/react.production.js')`——不是静态可分析的
 * 属性赋值，Rollup 的 commonjs 插件合成不出具名导出，产物里只剩下 default。
 * 浏览器的 `import { useState } from 'react'` 就会抛
 * "does not provide an export named: useState"，整页白屏。
 *
 * 所以这里在构建时 require 一次真实模块，枚举 `Object.keys()`，生成显式的
 * `export const useState = __m.useState` 入口再交给 Rollup。具名导出因此是
 * 真正的 ESM 声明，不依赖任何 CJS 分析能力，也不怕 React 版本变化。
 *
 * external 关系必须精确：共享模块之间也走 import map。react-dom 若把 react
 * 打进来，就会出现两份 React，hooks 立刻错乱。
 */

import { build } from 'vite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  SHARED_MODULES,
  SHARED_PROFILE_DIRS,
  sharedProfileMarker,
} from '../shared-modules.mjs'

const profile = process.argv[2]
if (profile !== 'development' && profile !== 'production') {
  throw new Error(
    `共享模块构建态必须是 development 或 production（收到：${profile ?? '未提供'}）。`,
  )
}

// 必须在 require 任何共享模块之前设置：React 的入口在这个值上分支。
process.env.NODE_ENV = profile

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const isDevelopment = profile === 'development'
const outdir = join(root, 'dist', SHARED_PROFILE_DIRS[profile])
const profileMarker = sharedProfileMarker(profile)
const pkgRequire = createRequire(join(root, 'package.json'))

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

// 必须在包内：shim 要 `import 'react'`，从 /tmp 出发 Rollup 解析不到 node_modules。
const scratch = mkdtempSync(join(root, '.shared-shim-'))

/**
 * 生成再导出入口。`M` 是 CJS 的 module.exports 对象，下面每个具名绑定都是
 * 独立的 ESM 导出声明。
 */
function shimSource(specifier) {
  const exports = Object.keys(pkgRequire(specifier))
  const lines = [`import __m from ${JSON.stringify(specifier)}`, '']
  for (const name of exports) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue // 非标识符没法做具名绑定
    if (name === 'default') continue
    lines.push(`export const ${name} = __m.${name}`)
  }
  lines.push('export default __m', '')
  return lines.join('\n')
}

try {
  for (const shared of SHARED_MODULES) {
    const entry = shared.entry.startsWith('src/')
      ? resolve(root, shared.entry)
      : join(scratch, `${shared.file}.mjs`)

    if (!shared.entry.startsWith('src/')) {
      writeFileSync(entry, shimSource(shared.specifier))
    }

    await build({
      root,
      configFile: false,
      logLevel: 'warn',
      define: { 'process.env.NODE_ENV': JSON.stringify(profile) },
      build: {
        outDir: outdir,
        emptyOutDir: false,
        // 文件名由 import map 固定，不能带 hash
        minify: !isDevelopment,
        target: 'es2022',
        // 开发构建保留 sourcemap，便于在浏览器里定位问题。
        sourcemap: isDevelopment,
        lib: { entry, formats: ['es'], fileName: () => shared.file },
        rollupOptions: {
          external: shared.externals,
          // Rollup 的 output.banner 会被 Vite 的 esbuild 转换当普通注释剥掉，
          // 因此在 generateBundle 里（转换与压缩之后）写标记。插入一行会让
          // sourcemap 行号整体后移，mappings 前补一个分号正好抵消。
          plugins: [
            {
              name: 'cordis-app:shared-profile-marker',
              generateBundle(_options, bundle) {
                for (const output of Object.values(bundle)) {
                  if (output.type !== 'chunk') continue
                  output.code = `${profileMarker}\n${output.code}`
                  if (output.map) output.map.mappings = `;${output.map.mappings}`
                }
              },
            },
          ],
        },
      },
    })
    console.log(`  ${SHARED_PROFILE_DIRS[profile]}/${shared.file}  ← ${shared.specifier}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
