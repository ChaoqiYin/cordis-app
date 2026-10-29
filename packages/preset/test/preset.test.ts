/**
 * 预设的契约测试。
 *
 * 这里断言的不是「esbuild 能打包」——那由 esbuild 自己保证。真正需要守住的是
 * 三个包对「共享模块」的理解必须一致：ui 产出 /__shared/*.js，runtime 提供它，
 * preset 把插件里的同名导入标为 external。三者任何一处漂移都会让插件与宿主
 * 拿到两份 React。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SHARED_MODULES, isShared, clientPreset, serverPreset } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
// test/ → preset/ → packages/ → 仓库根
const repo = join(here, '..', '..', '..')

test('共享白名单包含 React 与框架 client', () => {
  for (const specifier of ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'cordis-app/client']) {
    assert.ok(isShared(specifier), `${specifier} 应属于共享模块`)
  }
  assert.equal(isShared('lodash'), false)
})

test('白名单与 ui 的 shared-modules.mjs 完全一致', async () => {
  const mod = await import(join(repo, 'packages', 'ui', 'shared-modules.mjs'))
  const uiSpecifiers = mod.SHARED_SPECIFIERS as string[]
  assert.deepEqual(
    [...SHARED_MODULES].sort(),
    [...uiSpecifiers].sort(),
    'preset 与 ui 的共享列表漂移会让插件和宿主各持一份 React',
  )
})

test('前端预设外部化全部共享模块', () => {
  const build = clientPreset({ entry: 'src/client.ts', root: '/tmp/p' })
  assert.deepEqual([...(build.external ?? [])].sort(), [...SHARED_MODULES].sort())
  assert.equal(build.platform, 'browser')
  assert.equal(build.format, 'esm')
})

test('服务端预设把依赖留给 Node 解析，只外部化核心包', () => {
  const build = serverPreset({ entry: 'src/index.ts', root: '/tmp/p' })
  assert.equal(build.packages, 'external', '普通依赖必须由 Node 解析，否则多版本无法共存')
  assert.deepEqual(build.external, ['cordis-app'])
  assert.equal(build.platform, 'node')
})

test('import map 里出现的每个说明符都在预设白名单内', () => {
  const html = readFileSync(join(repo, 'packages', 'ui', 'src', 'host', 'index.ts'), 'utf8')
  // 只要宿主与插件都从裸模块名导入，构建时就会走同一条 external 规则
  assert.match(html, /from 'cordis-app\/client'/)
})
