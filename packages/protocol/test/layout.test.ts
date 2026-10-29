/**
 * 数据目录布局的契约测试。
 *
 * 布局被 supervisor、worker、CLI 三方共用，任何一处手写路径都会造成
 * 「CLI 装的插件 worker 看不到」。这里把布局钉死，改目录结构时先改测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveDataDir, resolveLayout } from '../lib/paths.js'

test('resolveLayout 把实例相关文件都放在 instances/<name> 下', () => {
  const dataDir = join('/tmp', 'cordis-data')
  const layout = resolveLayout(dataDir)
  const instanceDir = join(dataDir, 'instances', 'default')

  assert.equal(layout.dataDir, dataDir)
  assert.equal(layout.instanceDir, instanceDir)
  assert.equal(layout.appJson, join(instanceDir, 'app.json'))
  assert.equal(layout.appLock, join(instanceDir, 'app.lock'))
  assert.equal(layout.packageJson, join(instanceDir, 'package.json'))
  assert.equal(layout.config, join(instanceDir, 'config.json'))
  assert.equal(layout.pluginDataDir, join(instanceDir, 'data'))
  assert.equal(layout.nodeModulesDir, join(instanceDir, 'node_modules'))
})

test('resolveLayout 把跨实例的 runtime.json 与 tmp 留在数据根目录', () => {
  const dataDir = join('/tmp', 'cordis-data')
  const layout = resolveLayout(dataDir)

  assert.equal(layout.runtimeFile, join(dataDir, 'runtime.json'))
  assert.equal(layout.tmpDir, join(dataDir, 'tmp'))
})

test('resolveLayout 支持命名实例，且默认实例可省略', () => {
  const dataDir = join('/tmp', 'cordis-data')

  assert.equal(resolveLayout(dataDir, 'work').instanceDir, join(dataDir, 'instances', 'work'))
  assert.equal(resolveLayout(dataDir).instanceDir, resolveLayout(dataDir, 'default').instanceDir)
})

test('resolveDataDir 中环境变量优先于命令行参数', () => {
  const env = { CORDIS_APP_DATA: join('/tmp', 'from-env') }

  assert.equal(resolveDataDir(join('/tmp', 'from-cli'), env), join('/tmp', 'from-env'))
  assert.equal(resolveDataDir(join('/tmp', 'from-cli'), {}), join('/tmp', 'from-cli'))
})
