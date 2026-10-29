/**
 * 插件目录的契约测试。
 *
 * 重点钉住三件事：id 与包名是两套身份、作用域包的挂载路径不丢 scope、
 * 清单不合法的包不会混进「可加载」集合。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findPlugin,
  pluginFileUrl,
  readPluginId,
  scanPlugins,
} from '../lib/plugin/catalog.js'

function nodeModules(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-catalog-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

function writePlugin(
  root: string,
  plugin: Record<string, unknown>,
  packageJson: Record<string, unknown>,
): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify(plugin))
  writeFileSync(join(root, 'package.json'), JSON.stringify(packageJson))
}

test('scanPlugins 同时保留 plugin.json 的 id 与 npm 包名', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, 'hello-package'),
    { id: 'hello', client: 'dist/client.js' },
    { name: 'hello-package', version: '1.2.3', peerDependencies: { 'cordis-app': '^1.0.0' } },
  )

  const scan = scanPlugins(dir)
  assert.equal(scan.failures.length, 0)
  assert.equal(scan.plugins.length, 1)
  assert.equal(scan.plugins[0]!.id, 'hello')
  assert.equal(scan.plugins[0]!.packageName, 'hello-package')
  assert.equal(scan.plugins[0]!.mountPath, 'hello-package')
})

test('作用域包的挂载路径保留 scope，URL 不退化成裸名', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, '@acme', 'demo'),
    { id: 'acme-demo', client: 'dist/client.js' },
    { name: '@acme/demo', peerDependencies: { 'cordis-app': '^1.0.0' } },
  )

  const plugin = scanPlugins(dir).plugins[0]!
  assert.equal(plugin.mountPath, '@acme/demo')
  assert.equal(
    pluginFileUrl(plugin, join(plugin.root, 'dist', 'client.js')),
    '/__plugins/@acme/demo/dist/client.js',
  )
})

test('缺少核心包 peer 依赖的包记为失败，不进入可加载集合', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, 'broken'),
    { id: 'broken', server: 'index.js' },
    { name: 'broken' },
  )

  const scan = scanPlugins(dir)
  assert.equal(scan.plugins.length, 0)
  assert.equal(scan.failures.length, 1)
  assert.match(scan.failures[0]!.reason, /peerDependencies/)
})

test('findPlugin 接受 id 或包名，两种身份都能命中同一个插件', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, 'hello-package'),
    { id: 'hello', client: 'dist/client.js' },
    { name: 'hello-package', peerDependencies: { 'cordis-app': '^1.0.0' } },
  )

  const scan = scanPlugins(dir)
  assert.equal(findPlugin(scan, 'hello')?.packageName, 'hello-package')
  assert.equal(findPlugin(scan, 'hello-package')?.id, 'hello')
  assert.equal(findPlugin(scan, 'missing'), undefined)
})

test('readPluginId 对清单不完整但 id 存在的插件仍然可读', () => {
  const dir = nodeModules()
  writePlugin(join(dir, 'bare'), { id: 'bare-id' }, { name: 'bare' })

  assert.equal(readPluginId(dir, 'bare'), 'bare-id')
  assert.equal(readPluginId(dir, 'missing'), undefined)
})
