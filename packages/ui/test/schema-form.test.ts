/**
 * SchemaForm 的外部行为契约。
 *
 * 控件断言走 `react-dom/server` 的静态标记，不引入 DOM 环境；
 * 初始值合成与草稿同步用纯函数覆盖，避免依赖 effect 时序。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SchemaForm } from '../dist/host/index.js'
import {
  contentKey,
  mergeInitial,
  shouldResetDraft,
} from '../src/host/schema-form-model.ts'

test('初始值递归合并：对象保留嵌套默认值，数组与标量直接替换', () => {
  const defaults = {
    nested: { host: 'localhost', port: 8080 },
    tags: ['默认'],
    title: '默认标题',
  }
  const configured = {
    nested: { port: 9000 },
    tags: ['自定义'],
    title: '自定义标题',
  }

  assert.deepEqual(mergeInitial(defaults, configured), {
    nested: { host: 'localhost', port: 9000 },
    tags: ['自定义'],
    title: '自定义标题',
  })
})

test('内容键只随内容变化，与对象身份无关', () => {
  const first = { nested: { enabled: true }, name: '示例' }
  const sameContent = { nested: { enabled: true }, name: '示例' }
  const changed = { nested: { enabled: false }, name: '示例' }

  assert.equal(contentKey(first), contentKey(sameContent))
  assert.notEqual(contentKey(first), contentKey(changed))
})

test('草稿重置判定：内容键不变时保留草稿，变化时重置', () => {
  assert.equal(shouldResetDraft('{"name":"a"}', '{"name":"a"}'), false)
  assert.equal(shouldResetDraft('{"name":"a"}', '{"name":"b"}'), true)
})

/**
 * 直接渲染一个只含单个字段的 schema。
 *
 * 这里不启动浏览器：SSR 只执行首次渲染，正好用来断言「schema 生成了哪种控件」。
 */
async function renderField(meta: Record<string, unknown>): Promise<string> {
  return renderToStaticMarkup(
    createElement(SchemaForm, {
      schema: {
        type: 'object',
        dict: { field: { type: 'string', meta } },
      },
      value: {},
      onSave: () => {},
    }),
  )
}

test('role: textarea 渲染固定 4 行的多行输入', async () => {
  const html = await renderField({ role: 'textarea', default: 'a=1' })

  assert.match(html, /<textarea[^>]*rows="4"/)
  assert.match(html, /a=1/)
})

test('role: textarea 遵守 disabled', async () => {
  const html = await renderField({ role: 'textarea', disabled: true, default: 'a=1' })

  assert.match(html, /<textarea[^>]*\bdisabled\b/)
})

test('role: color 渲染颜色选择器', async () => {
  const html = await renderField({ role: 'color', default: '#4f8cff' })

  assert.match(html, /type="color"/)
  assert.match(html, /value="#4f8cff"/)
})

test('role: path 保留路径占位符', async () => {
  const html = await renderField({ role: 'path', default: '/tmp' })

  assert.match(html, /type="text"/)
  assert.match(html, /placeholder="路径"/)
})

test('未知 role 回退为单行文本输入', async () => {
  const html = await renderField({ role: 'date', default: '2026-01-01' })
  const fieldInput = html.match(/<input id="field-field"[^>]*>/)?.[0] ?? ''

  assert.match(fieldInput, /type="text"/)
  assert.doesNotMatch(fieldInput, /placeholder=/)
  assert.doesNotMatch(html, /type="color"/)
  assert.doesNotMatch(html, /<textarea/)
})
