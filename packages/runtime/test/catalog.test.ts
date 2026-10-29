/**
 * 插件目录的契约测试。
 *
 * 重点钉住：四个根的优先级、id 是唯一挂载键、重复 id 只产生一条失败、
 * 启动期 peer 兼容性，以及清单不合法的包不会混进「可加载」集合。
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
  scanPluginRoots,
  type PluginRoot,
} from '../lib/plugin/catalog.js'

function tempDir(prefix = 'cordis-catalog-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 依赖根（node_modules）里的插件。 */
function nodeModules(): string {
  return tempDir()
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

test('scanPlugins 同时保留 plugin.json 的 id 与 npm 包名，并记录依赖根', () => {
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
  assert.equal(scan.plugins[0]!.rootKind, 'dependency')
  assert.equal(scan.plugins[0]!.root, join(dir, 'hello-package'))
})

test('挂载键是插件 id：作用域 packages 不再依赖 @scope 目录', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, '@acme', 'demo'),
    { id: 'acme-demo', client: 'dist/client.js' },
    { name: '@acme/demo', peerDependencies: { 'cordis-app': '^1.0.0' } },
  )

  const plugin = scanPlugins(dir).plugins[0]!
  assert.equal(
    pluginFileUrl(plugin, join(plugin.root, 'dist', 'client.js')),
    '/__plugins/acme-demo/dist/client.js',
  )
})

test('四个根都参与发现，且 id→root 映射指向真实包目录', () => {
  const builtin = tempDir('cordis-builtin-')
  const local = tempDir('cordis-local-')
  const dependency = tempDir('cordis-dependency-')
  const user = tempDir('cordis-user-')
  const peer = { 'cordis-app': '^1.0.0' }

  writePlugin(join(builtin, 'b'), { id: 'b', client: 'c.js' }, { name: 'b', peerDependencies: peer })
  writePlugin(join(local, 'l'), { id: 'l', client: 'c.js' }, { name: 'l', peerDependencies: peer })
  writePlugin(join(dependency, 'd'), { id: 'd', client: 'c.js' }, { name: 'd', peerDependencies: peer })
  writePlugin(join(user, 'u'), { id: 'u', client: 'c.js' }, { name: 'u', peerDependencies: peer })

  const roots: PluginRoot[] = [
    { kind: 'user', dir: user },
    { kind: 'dependency', dir: dependency },
    { kind: 'local', dir: local },
    { kind: 'builtin', dir: builtin },
  ]
  const scan = scanPluginRoots(roots)

  // 传入顺序无关：内部按 builtin > local > dependency > user 排序
  assert.deepEqual(
    scan.plugins.map((plugin) => plugin.id).sort(),
    ['b', 'd', 'l', 'u'],
  )
  assert.deepEqual(
    Object.fromEntries(scan.plugins.map((plugin) => [plugin.id, plugin.rootKind])),
    { b: 'builtin', l: 'local', d: 'dependency', u: 'user' },
  )
  assert.equal(scan.roots.get('b'), join(builtin, 'b'))
  assert.equal(scan.roots.get('u'), join(user, 'u'))
})

test('不存在的根被忽略，不影响其他根', () => {
  const local = tempDir('cordis-local-')
  writePlugin(
    join(local, 'demo'),
    { id: 'demo', client: 'c.js' },
    { name: 'demo', peerDependencies: { 'cordis-app': '^1.0.0' } },
  )

  const scan = scanPluginRoots([
    { kind: 'builtin', dir: join(tempDir(), 'missing') },
    { kind: 'local', dir: local },
    { kind: 'dependency', dir: join(tempDir(), 'missing') },
    { kind: 'user', dir: join(tempDir(), 'missing') },
  ])
  assert.equal(scan.failures.length, 0)
  assert.deepEqual(scan.plugins.map((plugin) => plugin.id), ['demo'])
})

test('跨根重复 id 只产生一条失败，保留高优先级插件', () => {
  const builtin = tempDir('cordis-builtin-')
  const local = tempDir('cordis-local-')
  const dependency = tempDir('cordis-dependency-')
  const peer = { 'cordis-app': '^1.0.0' }

  writePlugin(join(builtin, 'dup'), { id: 'dup', client: 'builtin.js' }, { name: 'dup', peerDependencies: peer })
  writePlugin(join(local, 'dup'), { id: 'dup', client: 'local.js' }, { name: 'dup', peerDependencies: peer })
  writePlugin(join(dependency, 'dup'), { id: 'dup', client: 'dep.js' }, { name: 'dup', peerDependencies: peer })

  const scan = scanPluginRoots([
    { kind: 'dependency', dir: dependency },
    { kind: 'local', dir: local },
    { kind: 'builtin', dir: builtin },
  ])

  assert.equal(scan.plugins.length, 1)
  assert.equal(scan.plugins[0]!.rootKind, 'builtin')
  assert.equal(scan.roots.get('dup'), join(builtin, 'dup'))
  assert.equal(scan.failures.length, 1, '同一个 id 的冲突只报一条')
  assert.equal(scan.failures[0]!.id, 'dup')
  assert.match(scan.failures[0]!.reason, /dup/)
  assert.match(scan.failures[0]!.reason, /内置插件/)
  assert.match(scan.failures[0]!.reason, /项目本地/)
  assert.match(scan.failures[0]!.reason, /项目依赖/)
})

test('插件 id 必须是 URL 安全段：含 /、.. 或空串直接失败且不进入映射', () => {
  const dir = nodeModules()
  const peer = { 'cordis-app': '^1.0.0' }
  writePlugin(join(dir, 'slash'), { id: 'a/b', client: 'c.js' }, { name: 'slash', peerDependencies: peer })
  writePlugin(join(dir, 'dotdot'), { id: '..', client: 'c.js' }, { name: 'dotdot', peerDependencies: peer })
  writePlugin(join(dir, 'empty'), { id: '', client: 'c.js' }, { name: 'empty', peerDependencies: peer })
  writePlugin(join(dir, 'ok'), { id: 'safe-id_1', client: 'c.js' }, { name: 'ok', peerDependencies: peer })

  const scan = scanPlugins(dir)
  assert.deepEqual(scan.plugins.map((plugin) => plugin.id), ['safe-id_1'])
  assert.equal(scan.failures.length, 3)
  assert.deepEqual([...scan.roots.keys()], ['safe-id_1'])
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

test('启动期 doctor：插件 cordis-app peer 范围必须满足框架版本', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, 'old'),
    { id: 'old', client: 'c.js' },
    { name: 'old', peerDependencies: { 'cordis-app': '^0.9.0' } },
  )

  const scan = scanPlugins(dir, { frameworkVersion: '1.0.0' })
  assert.equal(scan.plugins.length, 0)
  assert.equal(scan.failures.length, 1)
  assert.equal(scan.failures[0]!.id, 'old')
  assert.match(scan.failures[0]!.reason, /1\.0\.0/)
})

test('启动期 doctor：共享模块 peer 范围必须与框架提供范围有交集', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, 'react18'),
    { id: 'react18', client: 'c.js' },
    { name: 'react18', peerDependencies: { 'cordis-app': '^1.0.0', react: '^18.0.0' } },
  )

  const scan = scanPlugins(dir, { frameworkVersion: '1.0.0' })
  assert.equal(scan.plugins.length, 0)
  assert.equal(scan.failures.length, 1)
  assert.match(scan.failures[0]!.reason, /react/)
})

test('启动期 doctor：共享模块 peer 范围兼容时插件可加载', () => {
  const dir = nodeModules()
  writePlugin(
    join(dir, 'ok'),
    { id: 'ok', client: 'c.js' },
    { name: 'ok', peerDependencies: { 'cordis-app': '^1.0.0', react: '^19.0.0' } },
  )

  const scan = scanPlugins(dir, { frameworkVersion: '1.0.0' })
  assert.equal(scan.failures.length, 0)
  assert.equal(scan.plugins.length, 1)
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

test('插件前端缓存键：生产按内容 hash，开发按时间戳', async () => {
  const { clientVersion } = await import('../lib/plugin/loader.js')
  const dir = tempDir('cordis-version-')
  const file = join(dir, 'client.js')
  writeFileSync(file, 'export const a = 1\n')

  const first = clientVersion(file, false)
  assert.equal(clientVersion(file, false), first, '内容不变时 hash 必须稳定')
  writeFileSync(file, 'export const a = 2\n')
  assert.notEqual(clientVersion(file, false), first, '内容变化必须换 hash')

  const originalNow = Date.now
  Date.now = () => 1_000
  assert.equal(clientVersion(file, true), '1000')
  Date.now = () => 2_000
  assert.equal(clientVersion(file, true), '2000')
  Date.now = originalNow
})
