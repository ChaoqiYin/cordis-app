/**
 * 前端清单的协议契约。
 *
 * UI 契约版本是跨进程常量：前端、插件市场与 worker 必须看到同一个数字。
 * 这里把它钉在测试里，避免某次重构把它改成两份真源。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { UI_CONTRACT_VERSION } from '../lib/constants.js'

test('UI 契约版本为 1', () => {
  assert.equal(UI_CONTRACT_VERSION, 1)
})
