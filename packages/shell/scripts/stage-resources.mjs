#!/usr/bin/env node
/**
 * 构建期把前端产物放进外壳源码目录，供 `//go:embed` 嵌入。
 *
 * 嵌入而不是打包时旁挂，是为了让「外壳 + UI」成为一个不可分割的版本单元：
 * 不会出现外壳升级了、磁盘上的 UI 还是旧的。运行时由 resource.go 释放到
 * <install-dir>/resources，worker 的 static 插件只从磁盘读。
 *
 * 用法：node scripts/stage-resources.mjs
 */

import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const shellDir = resolve(here, '..')
const repo = resolve(shellDir, '..', '..')
const uiDist = join(repo, 'packages', 'ui', 'dist')
const target = join(shellDir, 'resources')

if (!existsSync(join(uiDist, 'ui', 'index.html'))) {
  console.error('找不到前端产物，请先执行 pnpm build:ui')
  process.exit(1)
}

// 必须整体清空产物目录：上一版遗留的 hash 文件名如果留着，会被一起嵌进去，
// 包体随版本单调增长，而且永远删不掉。资源根目录本身要保留——没有它
// `//go:embed all:resources` 会直接编译失败。
for (const sub of ['ui', 'shared']) {
  rmSync(join(target, sub), { recursive: true, force: true })
}

cpSync(join(uiDist, 'ui'), join(target, 'ui'), { recursive: true })
cpSync(join(uiDist, 'shared'), join(target, 'shared'), { recursive: true })

console.log(`已暂存前端产物到 ${target}，可以执行 go build`)
