/**
 * 把前端壳（web shell）随包发布到 `dist/shell/`。
 *
 * 「前端壳」指页面入口 index.html、main.tsx 与样式，与 Go 桌面外壳无关。
 * 项目构建与开发都需要同一份壳入口：只发布 dist 时源码目录不在包里，
 * 因此这里把它们复制过去，并把入口脚本改成相对路径。
 * 壳本身引用 `cordis-app/ui` 与 `virtual:cordis-app/body`，由构建器注入。
 */

import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'dist', 'shell')

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

copyFileSync(join(root, 'index.html'), join(outdir, 'index.html'))
copyFileSync(join(root, 'src', 'ui', 'main.tsx'), join(outdir, 'main.tsx'))
copyFileSync(join(root, 'src', 'ui', 'styles.css'), join(outdir, 'styles.css'))

// 共享模块不能落到 shell 目录里。开发服务器以 shell 为 root，一旦
// `/__shared/*.js` 是可解析的真实文件，Vite 会按文件解析它并在安装路径位于
// node_modules 时追加 `?v=<browserHash>`；而共享 bundle 之间写的是不带查询的
// 同一个 URL，于是 React 被加载两份，hooks 读到 null dispatcher。
// /__shared 只由 `serveSharedModules` 中间件提供（见 src/build/index.ts），
// 地址在开发与生产完全一致。

const html = readFileSync(join(outdir, 'index.html'), 'utf8').replace(
  '/src/ui/main.tsx',
  './main.tsx',
)
writeFileSync(join(outdir, 'index.html'), html)

console.log('  shell/index.html + main.tsx + styles.css')
