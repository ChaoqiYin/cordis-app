/**
 * 插件静态资源解析的契约测试。
 *
 * 静态服务只接受「id → 插件根」映射，绝不把 URL 直接拼到 node_modules。
 * 这里直接测解析结果，避免依赖 HTTP 对 `..` 的预归一化。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePluginFile } from '../lib/builtin/static.js'

function pluginRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'cordis-static-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'client.js'), 'export default () => {}')
  return root
}

test('按插件 id 查映射，再安全解析剩余文件路径', () => {
  const root = pluginRoot()
  const roots = new Map([['demo', root]])

  assert.equal(resolvePluginFile('/__plugins/demo/client.js', roots), join(root, 'client.js'))
  assert.equal(resolvePluginFile('/__plugins/demo/client.js', new Map()), undefined)
  assert.equal(resolvePluginFile('/__shared/react.js', roots), undefined)
})

test('id 段经过 URL 解码后查表，作用域目录不影响挂载', () => {
  const root = pluginRoot()
  const roots = new Map([['acme-demo', root]])

  assert.equal(
    resolvePluginFile('/__plugins/acme%2Ddemo/client.js', roots),
    join(root, 'client.js'),
  )
})

test('插件资源路径穿越被拦截', () => {
  const root = pluginRoot()
  const roots = new Map([['demo', root]])

  assert.equal(resolvePluginFile('/__plugins/demo/../../../etc/passwd', roots), undefined)
  assert.equal(resolvePluginFile('/__plugins/demo/%2e%2e/%2e%2e/etc/passwd', roots), undefined)
  assert.equal(resolvePluginFile('/__plugins/demo/a\0b', roots), undefined)
  assert.equal(resolvePluginFile('/__plugins/%2e%2e/client.js', roots), undefined)
  assert.equal(resolvePluginFile('/__plugins/demo/%E0%A4%A/client.js', roots), undefined)
})
