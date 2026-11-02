/**
 * body UI 能力与插件 UI 需求的匹配契约。
 *
 * 匹配是纯函数：不读 DOM、不读磁盘，安装器（#6）与前端告警共用同一份判断。
 * 这里钉住三档结论和缺失项的形状，避免安装器和运行时各算一套。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchUiCapabilities } from '../lib/capabilities.js'
import type { InstallResult } from '../lib/types.js'

const body = {
  pages: true,
  slots: ['header.right', 'activity.bottom'],
  menus: ['activity'],
  settings: true,
}

test('插件没有 UI 需求时总是完整兼容', () => {
  assert.deepEqual(matchUiCapabilities(undefined, body), { compatibility: 'full', missing: [] })
  assert.deepEqual(matchUiCapabilities({}, body), { compatibility: 'full', missing: [] })
  assert.deepEqual(matchUiCapabilities({ slots: [] }, undefined), {
    compatibility: 'full',
    missing: [],
  })
})

test('body 提供全部所需出口时结果为 full', () => {
  assert.deepEqual(
    matchUiCapabilities(
      { pages: true, slots: ['header.right'], menus: ['activity'], settings: true },
      body,
    ),
    { compatibility: 'full', missing: [] },
  )
})

test('body 缺少部分出口时降级为 backend-only，并列出缺失项', () => {
  const match = matchUiCapabilities(
    {
      pages: true,
      slots: ['header.right', 'sidebar.left'],
      menus: ['activity'],
      settings: true,
    },
    { pages: true, slots: ['header.right'], menus: [], settings: false },
  )

  assert.equal(match.compatibility, 'backend-only')
  assert.deepEqual(match.missing, ['slot:sidebar.left', 'menu:activity', 'settings'])
})

test('四种缺失项都能被单独识别', () => {
  const match = matchUiCapabilities(
    { pages: true, slots: ['header.right'], menus: ['activity'], settings: true },
    { pages: false, slots: [], menus: [], settings: false },
  )

  assert.equal(match.compatibility, 'backend-only')
  assert.deepEqual(match.missing, ['pages', 'slot:header.right', 'menu:activity', 'settings'])
})

test('body 完全没有声明能力时，有 UI 需求的插件为 incompatible', () => {
  assert.deepEqual(matchUiCapabilities({ pages: true }, undefined), {
    compatibility: 'incompatible',
    missing: ['pages'],
  })
})

test('安装结果携带 UI 兼容性分级，供安装器与前端共用', () => {
  const result: InstallResult = {
    id: 'demo',
    restarted: true,
    reason: 'installed',
    uiCompatibility: matchUiCapabilities({ settings: true }, body).compatibility,
  }

  assert.equal(result.uiCompatibility, 'full')
})
