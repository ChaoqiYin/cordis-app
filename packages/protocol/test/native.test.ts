/**
 * 原生能力契约的常量部分。
 *
 * 命令名、错误码、契约版本与环境变量是外壳、supervisor、worker 之间的字符串
 * 真源，必须与 ADR 0003 一字不差；这里逐项钉住，避免某一侧单独改名。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENV_NATIVE_TOKEN,
  ENV_NATIVE_URL,
  NATIVE_COMMANDS,
  NATIVE_CONTRACT_VERSION,
  NATIVE_ERROR_CODES,
} from '../lib/native.js'

test('原生能力契约版本为 1', () => {
  assert.equal(NATIVE_CONTRACT_VERSION, 1)
})

test('原生端点与 token 的环境变量名与 ADR 一致', () => {
  assert.equal(ENV_NATIVE_URL, 'CORDIS_APP_NATIVE_URL')
  assert.equal(ENV_NATIVE_TOKEN, 'CORDIS_APP_NATIVE_TOKEN')
})

test('命令表覆盖 ADR 0003 的 16 条命令', () => {
  assert.deepEqual([...NATIVE_COMMANDS].sort(), [
    'notification.show',
    'path.chooseDirectory',
    'path.chooseOpen',
    'path.chooseSave',
    'shell.openExternal',
    'shell.openPath',
    'shell.showItemInFolder',
    'system.info',
    'window.close',
    'window.focus',
    'window.maximize',
    'window.minimize',
    'window.restore',
    'window.setSize',
    'window.setTitle',
    'window.state',
  ])
  assert.equal(new Set(NATIVE_COMMANDS).size, NATIVE_COMMANDS.length, '命令名不能重复')
})

test('错误码固定为 7 个', () => {
  assert.deepEqual([...NATIVE_ERROR_CODES].sort(), [
    'busy',
    'cancelled',
    'denied',
    'internal',
    'invalid',
    'timeout',
    'unsupported',
  ])
})
