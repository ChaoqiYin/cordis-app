/**
 * 把前端壳（web shell）随包发布到 `dist/shell/`。
 *
 * 「前端壳」指页面入口 index.html、main.tsx 与样式，与 Go 桌面外壳无关。
 * 项目构建与开发都需要同一份壳入口：只发布 dist 时源码目录不在包里，
 * 因此这里把它们复制过去，并把入口脚本改成相对路径。
 * 壳本身引用 `cordis-app/ui` 与 `virtual:cordis-app/body`，由构建器注入。
 */

import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHARED_MODULES } from '../shared-modules.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = join(root, 'dist', 'shell')

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

copyFileSync(join(root, 'index.html'), join(outdir, 'index.html'))
copyFileSync(join(root, 'src', 'ui', 'main.tsx'), join(outdir, 'main.tsx'))
copyFileSync(join(root, 'src', 'ui', 'styles.css'), join(outdir, 'styles.css'))

// 开发服务器以 shell 目录为 root：把共享模块放进去，`/__shared/*.js` 才是
// 可解析的真实文件。生产由 worker 从 resources/shared 提供，URL 完全相同，
// 因此开发与生产的模块身份一致。
const shared = join(root, 'dist', 'shared')
mkdirSync(join(outdir, '__shared'), { recursive: true })
for (const module of SHARED_MODULES) {
  const file = join(shared, module.file)
  if (!existsSync(file)) {
    throw new Error(`共享模块产物缺失：${file}。请先运行 build:shared。`)
  }
  cpSync(file, join(outdir, '__shared', module.file))
}

const html = readFileSync(join(outdir, 'index.html'), 'utf8').replace(
  '/src/ui/main.tsx',
  './main.tsx',
)
writeFileSync(join(outdir, 'index.html'), html)

console.log('  shell/index.html + main.tsx + styles.css')
