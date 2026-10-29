/**
 * 共享模块表的派生一致性。
 *
 * 浏览器路径、import map、安装期 peer 范围都从这一张表派生。这里守住的是
 * 「派生函数没有漏字段」——只要有一处不再跟着表走，宿主与插件就可能各持
 * 一份 React，表现为 invalid hook call。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SHARED_MODULES,
  SHARED_MODULE_TABLE,
  SHARED_MODULE_URLS,
  SHARED_PEER_RANGES,
  SHARED_PREFIX,
} from '../lib/constants.js'

test('说明符列表与表本身的键一一对应', () => {
  assert.deepEqual(SHARED_MODULES, Object.keys(SHARED_MODULE_TABLE))
})

test('每个共享模块都有唯一的产物文件与浏览器路径', () => {
  const files = SHARED_MODULES.map((name) => SHARED_MODULE_TABLE[name].file)
  assert.equal(new Set(files).size, files.length, '产物文件名不能重复')
  assert.deepEqual(Object.keys(SHARED_MODULE_URLS), SHARED_MODULES)

  for (const name of SHARED_MODULES) {
    assert.equal(SHARED_MODULE_URLS[name], `${SHARED_PREFIX}/${SHARED_MODULE_TABLE[name].file}`)
  }
})

test('构建外部化项只能引用白名单内的模块', () => {
  for (const name of SHARED_MODULES) {
    for (const external of SHARED_MODULE_TABLE[name].externals) {
      assert.ok(
        (SHARED_MODULES as readonly string[]).includes(external),
        `${name} 的外部化项 ${external} 不在共享白名单里`,
      )
    }
  }
})

test('peer 范围表只包含做出过版本承诺的模块', () => {
  for (const name of SHARED_MODULES) {
    const range = SHARED_MODULE_TABLE[name].peerRange
    if (range) {
      assert.equal(SHARED_PEER_RANGES[name], range)
    } else {
      assert.equal(name in SHARED_PEER_RANGES, false, `${name} 没有版本承诺，不该出现在范围表里`)
    }
  }
})
