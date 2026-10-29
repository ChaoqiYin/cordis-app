/**
 * 宿主侧共享模块视图的契约。
 *
 * build-shared、vite external、import map 三处都从 shared-modules.mjs 读，
 * 而它只转述协议层的表。这里确认转述没有走样：路径、说明符、外部化关系
 * 与实际浏览器地址必须一致。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SHARED_MODULE_URLS } from '@cordis-app/protocol'
import { SHARED_MODULES, SHARED_SPECIFIERS, importMap } from '../shared-modules.mjs'

test('import map 与协议层的浏览器路径完全一致', () => {
  assert.deepEqual(importMap().imports, SHARED_MODULE_URLS)
})

test('每个共享模块都有构建入口与产物文件名', () => {
  for (const module of SHARED_MODULES) {
    assert.ok(module.entry, `${module.specifier} 缺少构建入口`)
    assert.ok(module.file, `${module.specifier} 缺少产物文件名`)
  }
  assert.equal(new Set(SHARED_SPECIFIERS).size, SHARED_SPECIFIERS.length, '说明符不能重复')
})

test('共享模块之间的 external 关系都落在白名单内', () => {
  for (const module of SHARED_MODULES) {
    for (const external of module.externals) {
      assert.ok(
        SHARED_SPECIFIERS.includes(external),
        `${module.specifier} 外部化了 ${external}，但它不在共享白名单里`,
      )
    }
  }
})
