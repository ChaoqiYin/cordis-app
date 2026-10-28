/**
 * 构建共享模块 → dist/shared/。
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
import { SHARED_MODULES } from '../shared-modules.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outdir = join(root, 'dist', 'shared')
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
      define: { 'process.env.NODE_ENV': '"production"' },
      build: {
        outDir: outdir,
        emptyOutDir: false,
        // 文件名由 import map 固定，不能带 hash
        minify: true,
        target: 'es2022',
        sourcemap: false,
        lib: { entry, formats: ['es'], fileName: () => shared.file },
        rollupOptions: {
          external: shared.externals,
        },
      },
    })
    console.log(`  shared/${shared.file}  ← ${shared.specifier}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
