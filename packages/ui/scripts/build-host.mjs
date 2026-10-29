/**
 * 构建 `@cordis-app/ui/host` → dist/host/index.js。
 *
 * 宿主组件会被项目 body 打进应用构建，因此 React 与 `cordis-app/client` 必须
 * 保持 external：浏览器里它们由 import map 指向框架的同一份实例。若在这里内联，
 * body 与插件会各持一份 RuntimeContext，插件的 hooks 直接失效。
 *
 * 这个入口只产出 ESM JS；类型由 `tsc -p tsconfig.host.json` 生成。
 */

import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'dist', 'host')

rmSync(outdir, { recursive: true, force: true })

await build({
  entryPoints: [join(root, 'src', 'host', 'index.ts')],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  // 与 shared-modules.mjs 的 external 清单保持一致，避免两份 React / RuntimeContext
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'cordis-app/client'],
  logLevel: 'warning',
})

console.log('  host/index.js  ← src/host/index.ts')
