/**
 * 插件两状态模型的存储与视图契约。
 *
 * 测试只观察外部行为：磁盘上的 app.json / plugins-state.json 内容、重新读取
 * 后的合并结果，以及视图规划对 enabled / origin / reinstallable 的输出。
 * 不触碰状态存储的内部字段或写入顺序。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PluginStateStore,
  planPluginViews,
  resolvePluginStatePath,
  type UninstalledPluginRecord,
} from '../lib/plugin/plugin-state.js'
import { scanPluginRoots, type PluginRoot } from '../lib/plugin/catalog.js'

function tempDir(prefix = 'cordis-plugin-state-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeAppJson(root: string, app: Record<string, unknown>): string {
  const path = join(root, 'app.json')
  writeFileSync(path, JSON.stringify(app, null, 2) + '\n')
  return path
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function projectStore(root: string): PluginStateStore {
  return new PluginStateStore({ mode: 'project', projectRoot: root })
}

/** 直接写状态文件，模拟外部编辑 app.json 或升级前留下的状态。 */
function seedStateFile(root: string, uninstalled: Record<string, unknown>): void {
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(
    join(root, 'data', 'plugins-state.json'),
    JSON.stringify({ version: 1, installed: {}, uninstalled }, null, 2) + '\n',
  )
}

function uninstalledRecord(
  id: string,
  overrides: Partial<UninstalledPluginRecord> = {},
): UninstalledPluginRecord {
  return {
    id,
    displayName: `${id} 展示名`,
    rootKind: 'dependency',
    sourceKind: 'npm',
    packageName: `pkg-${id}`,
    version: '1.2.3',
    spec: `pkg-${id}@1.2.3`,
    uninstalledAt: '2026-11-09T12:00:00.000Z',
    ...overrides,
  }
}

test('项目模式状态文件在 data/ 下，缺失时读取为空状态', () => {
  const root = tempDir()
  const store = projectStore(root)

  assert.equal(store.statePath, join(root, 'data', 'plugins-state.json'))
  assert.equal(
    resolvePluginStatePath({ mode: 'project', projectRoot: root }),
    join(root, 'data', 'plugins-state.json'),
  )

  const state = store.read()
  assert.deepEqual(state.uninstalledIds, [])
  assert.deepEqual(state.installed, {})
  assert.deepEqual(state.uninstalled, {})
  assert.deepEqual(state.staleUninstalledIds, [])
})

test('项目模式写入同时更新 app.json 的已卸载 id 与状态文件明细，重启后可读', () => {
  const root = tempDir()
  const appJson = writeAppJson(root, { name: 'demo', version: '1.0.0', plugins: ['keep'] })
  const store = projectStore(root)

  store.write({
    installed: {
      keep: {
        spec: 'pkg-keep@1.0.0',
        sourceKind: 'npm',
        packageName: 'pkg-keep',
        version: '1.0.0',
        installedAt: '2026-11-09T11:00:00.000Z',
      },
    },
    uninstalled: { gone: uninstalledRecord('gone') },
    uninstalledIds: ['gone'],
    staleUninstalledIds: [],
  })

  const app = readJson(appJson)
  assert.deepEqual(app.plugins, ['keep'])
  assert.deepEqual(app.uninstalledPlugins, ['gone'])

  const statePath = join(root, 'data', 'plugins-state.json')
  const raw = readJson(statePath)
  assert.equal(raw.version, 1)
  assert.deepEqual(raw.installed, {
    keep: {
      spec: 'pkg-keep@1.0.0',
      sourceKind: 'npm',
      packageName: 'pkg-keep',
      version: '1.0.0',
      installedAt: '2026-11-09T11:00:00.000Z',
    },
  })
  assert.deepEqual(raw.uninstalled, { gone: uninstalledRecord('gone') })

  // 原子写入：临时文件必须已被 rename 掉，不能留下半截 JSON。
  assert.deepEqual(
    readdirSync(join(root, 'data')).filter((name) => name.includes('.tmp')),
    [],
  )

  // 新实例只以磁盘为准，不继承内存状态。
  const reread = projectStore(root).read()
  assert.deepEqual(reread.uninstalledIds, ['gone'])
  assert.deepEqual(reread.uninstalled, { gone: uninstalledRecord('gone') })
  assert.deepEqual(reread.installed, raw.installed)
})

test('markUninstalled 把 installed 明细移到 uninstalled，并写入 app.json', () => {
  const root = tempDir()
  const appJson = writeAppJson(root, { name: 'demo', version: '1.0.0', plugins: ['gone', 'keep'] })
  const store = projectStore(root)

  store.setInstalled('gone', {
    spec: 'pkg-gone@1.2.3',
    sourceKind: 'npm',
    packageName: 'pkg-gone',
    version: '1.2.3',
    installedAt: '2026-11-09T11:00:00.000Z',
  })

  store.markUninstalled(uninstalledRecord('gone'))

  const state = store.read()
  assert.deepEqual(state.uninstalledIds, ['gone'])
  assert.equal(state.installed.gone, undefined)
  assert.deepEqual(state.uninstalled.gone, uninstalledRecord('gone'))
  assert.deepEqual(readJson(appJson).uninstalledPlugins, ['gone'])

  // 重复记录同一个 id 不产生重复项。
  store.markUninstalled(uninstalledRecord('gone'))
  assert.deepEqual(store.read().uninstalledIds, ['gone'])
})

test('clearUninstalled 只清状态，不动 app.json.plugins 的启用顺序', () => {
  const root = tempDir()
  const appJson = writeAppJson(root, { name: 'demo', version: '1.0.0', plugins: ['a', 'b'] })
  const store = projectStore(root)

  store.markUninstalled(uninstalledRecord('a'))
  store.clearUninstalled('a')

  const state = store.read()
  assert.deepEqual(state.uninstalledIds, [])
  assert.deepEqual(state.uninstalled, {})
  assert.deepEqual(readJson(appJson).plugins, ['a', 'b'])
  assert.deepEqual(readJson(appJson).uninstalledPlugins, [])
})

test('setInstalled 清除同 id 的已卸载状态', () => {
  const root = tempDir()
  const appJson = writeAppJson(root, { name: 'demo', version: '1.0.0' })
  const store = projectStore(root)

  store.markUninstalled(uninstalledRecord('again'))
  store.setInstalled('again', {
    spec: 'pkg-again@2.0.0',
    sourceKind: 'npm',
    packageName: 'pkg-again',
    version: '2.0.0',
    installedAt: '2026-11-09T13:00:00.000Z',
  })

  const state = store.read()
  assert.deepEqual(state.uninstalledIds, [])
  assert.deepEqual(state.uninstalled, {})
  assert.deepEqual(state.installed.again, {
    spec: 'pkg-again@2.0.0',
    sourceKind: 'npm',
    packageName: 'pkg-again',
    version: '2.0.0',
    installedAt: '2026-11-09T13:00:00.000Z',
  })
  assert.deepEqual(readJson(appJson).uninstalledPlugins, [])
})

test('项目模式以 app.json 为已卸载 id 真源，状态文件只补明细', () => {
  const root = tempDir()
  writeAppJson(root, {
    name: 'demo',
    version: '1.0.0',
    uninstalledPlugins: ['with-record', 'without-record'],
  })
  seedStateFile(root, { 'with-record': uninstalledRecord('with-record') })

  const state = projectStore(root).read()
  assert.deepEqual(state.uninstalledIds, ['with-record', 'without-record'])
  assert.deepEqual(state.uninstalled, { 'with-record': uninstalledRecord('with-record') })
})

test('状态文件有、app.json 没有的记录视为过期：不展示，下次写入清理', () => {
  const root = tempDir()
  writeAppJson(root, {
    name: 'demo',
    version: '1.0.0',
    uninstalledPlugins: ['live'],
  })
  seedStateFile(root, {
    live: uninstalledRecord('live'),
    stale: uninstalledRecord('stale'),
  })
  const store = projectStore(root)

  const state = store.read()
  assert.deepEqual(state.uninstalledIds, ['live'])
  assert.deepEqual(Object.keys(state.uninstalled), ['live'])
  assert.deepEqual(state.staleUninstalledIds, ['stale'])

  // 写回同一份读取结果后，过期记录从磁盘上消失。
  store.write(state)
  const raw = readJson(join(root, 'data', 'plugins-state.json'))
  assert.deepEqual(Object.keys(raw.uninstalled as Record<string, unknown>), ['live'])
})

test('app.json 缺失时以状态文件为已卸载 id 真源', () => {
  const root = tempDir()
  const store = projectStore(root)
  store.write({
    installed: {},
    uninstalled: {
      a: uninstalledRecord('a'),
      b: uninstalledRecord('b', { rootKind: 'local', sourceKind: undefined, spec: undefined }),
    },
    uninstalledIds: ['a', 'b'],
    staleUninstalledIds: [],
  })

  const state = store.read()
  assert.deepEqual(state.uninstalledIds, ['a', 'b'])
  assert.deepEqual(Object.keys(state.uninstalled), ['a', 'b'])
  assert.equal(existsSync(join(root, 'app.json')), false)
})

test('app.json 存在但没有 uninstalledPlugins 字段表示没有显式卸载', () => {
  const root = tempDir()
  writeAppJson(root, { name: 'demo', version: '1.0.0', plugins: ['a'] })
  seedStateFile(root, { a: uninstalledRecord('a') })

  const state = projectStore(root).read()
  assert.deepEqual(state.uninstalledIds, [])
  assert.deepEqual(state.uninstalled, {})
  assert.deepEqual(state.staleUninstalledIds, ['a'])
})

test('打包模式只写 <userData>/plugins-state.json，不碰只读 app.json', () => {
  const root = tempDir()
  const userDataDir = join(root, 'user-data')
  const appJson = writeAppJson(root, { name: 'demo', version: '1.0.0', plugins: ['gone'] })
  const originalApp = readFileSync(appJson, 'utf8')

  const store = new PluginStateStore({ mode: 'packaged', projectRoot: root, userDataDir })
  assert.equal(store.statePath, join(userDataDir, 'plugins-state.json'))

  store.markUninstalled(uninstalledRecord('gone'))

  assert.equal(readFileSync(appJson, 'utf8'), originalApp)
  const state = store.read()
  assert.deepEqual(state.uninstalledIds, ['gone'])
  assert.deepEqual(state.uninstalled, { gone: uninstalledRecord('gone') })
})

test('打包模式以状态文件为真源，忽略 app.json 的 uninstalledPlugins', () => {
  const root = tempDir()
  const userDataDir = join(root, 'user-data')
  writeAppJson(root, {
    name: 'demo',
    version: '1.0.0',
    uninstalledPlugins: ['from-app-json'],
  })
  const store = new PluginStateStore({ mode: 'packaged', projectRoot: root, userDataDir })
  store.write({
    installed: {},
    uninstalled: { 'from-state': uninstalledRecord('from-state') },
    uninstalledIds: ['from-state'],
    staleUninstalledIds: [],
  })

  const state = store.read()
  assert.deepEqual(state.uninstalledIds, ['from-state'])
  assert.deepEqual(Object.keys(state.uninstalled), ['from-state'])
})

test('视图规划：启用视图剔除已卸载 id，origin 按来源映射', () => {
  const builtin = tempDir('cordis-state-builtin-')
  const local = tempDir('cordis-state-local-')
  const dependency = tempDir('cordis-state-dependency-')
  const user = tempDir('cordis-state-user-')

  writePlugin(join(builtin, 'builtin-pkg'), 'builtin-id')
  writePlugin(join(local, 'local-pkg'), 'local-id')
  writePlugin(join(dependency, 'dep-pkg'), 'dep-id')
  writePlugin(join(user, 'user-pkg'), 'user-id')

  const roots: PluginRoot[] = [
    { kind: 'builtin', dir: builtin },
    { kind: 'local', dir: local },
    { kind: 'dependency', dir: dependency },
    { kind: 'user', dir: user },
  ]
  const scan = scanPluginRoots(roots)

  const views = planPluginViews(scan, {
    installed: {},
    uninstalled: {},
    uninstalledIds: ['dep-id'],
    staleUninstalledIds: [],
  })

  assert.deepEqual(
    views.plugins.map((plugin) => plugin.id).sort(),
    ['builtin-id', 'dep-id', 'local-id', 'user-id'],
  )
  assert.deepEqual(
    views.enabled.map((plugin) => plugin.id).sort(),
    ['builtin-id', 'local-id', 'user-id'],
  )
  assert.equal(views.uninstalledIds.has('dep-id'), true)
  assert.equal(views.enabledRoots.has('dep-id'), false)
  assert.equal(views.enabledRoots.get('builtin-id'), join(builtin, 'builtin-pkg'))

  const byId = new Map(views.plugins.map((plugin) => [plugin.id, plugin]))
  assert.equal(byId.get('builtin-id')!.origin, 'builtin')
  assert.equal(byId.get('local-id')!.origin, 'local')
  assert.equal(byId.get('dep-id')!.origin, 'external')
  assert.equal(byId.get('user-id')!.origin, 'external')
  assert.equal(byId.get('dep-id')!.enabled, false)
  assert.equal(byId.get('dep-id')!.reinstallable, false) // 物理存在但没有卸载记录
})

test('视图规划：物理存在且有卸载记录的插件可一键启用', () => {
  const dependency = tempDir('cordis-state-dependency-')
  writePlugin(join(dependency, 'dep-pkg'), 'dep-id')
  const scan = scanPluginRoots([{ kind: 'dependency', dir: dependency }])

  const views = planPluginViews(scan, {
    installed: {},
    uninstalled: { 'dep-id': uninstalledRecord('dep-id') },
    uninstalledIds: ['dep-id'],
    staleUninstalledIds: [],
  })

  assert.equal(views.plugins[0]!.enabled, false)
  assert.equal(views.plugins[0]!.reinstallable, true)
  assert.deepEqual(views.uninstalled, []) // 物理存在时不重复进已卸载列表
})

test('视图规划：已卸载列表只放扫描不到但有记录的插件，reinstallable 看 spec', () => {
  const scan = scanPluginRoots([])

  const views = planPluginViews(scan, {
    installed: {},
    uninstalled: {
      'with-spec': uninstalledRecord('with-spec', { rootKind: 'dependency' }),
      'without-spec': uninstalledRecord('without-spec', {
        rootKind: 'builtin',
        sourceKind: undefined,
        packageName: undefined,
        spec: undefined,
      }),
      'missing-record': undefined as never,
    },
    uninstalledIds: ['with-spec', 'without-spec', 'missing-record'],
    staleUninstalledIds: [],
  })

  assert.deepEqual(
    views.uninstalled.map((plugin) => plugin.id).sort(),
    ['missing-record', 'with-spec', 'without-spec'],
  )
  const byId = new Map(views.uninstalled.map((plugin) => [plugin.id, plugin]))
  assert.equal(byId.get('with-spec')!.reinstallable, true)
  assert.equal(byId.get('with-spec')!.origin, 'external')
  assert.equal(byId.get('without-spec')!.reinstallable, false)
  assert.equal(byId.get('without-spec')!.origin, 'builtin')
  assert.equal(byId.get('missing-record')!.reinstallable, false)
  assert.equal(byId.get('missing-record')!.displayName, 'missing-record')
})

test('视图规划：enabledScan 可直接交给 loader，只含启用插件与启用失败', () => {
  const builtin = tempDir('cordis-state-builtin-')
  const dependency = tempDir('cordis-state-dependency-')
  writePlugin(join(builtin, 'builtin-pkg'), 'builtin-id')
  writePlugin(join(dependency, 'dep-pkg'), 'dep-id')

  const scan = scanPluginRoots([
    { kind: 'builtin', dir: builtin },
    { kind: 'dependency', dir: dependency },
  ])
  scan.failures.push({ id: 'dep-id', reason: '已卸载插件失败' })

  const views = planPluginViews(scan, {
    installed: {},
    uninstalled: { 'dep-id': uninstalledRecord('dep-id') },
    uninstalledIds: ['dep-id'],
    staleUninstalledIds: [],
  })

  assert.deepEqual(
    views.enabledScan.plugins.map((plugin) => plugin.id),
    ['builtin-id'],
  )
  assert.equal(views.enabledScan.roots.get('builtin-id'), join(builtin, 'builtin-pkg'))
  assert.equal(views.enabledScan.roots.has('dep-id'), false)
  assert.deepEqual(views.enabledScan.failures, [])
})

test('app.json 的 uninstalledPlugins 去重并忽略非字符串项', () => {
  const root = tempDir()
  writeAppJson(root, {
    name: 'demo',
    version: '1.0.0',
    uninstalledPlugins: ['a', 'a', 1, 'b'],
  })
  seedStateFile(root, {
    a: uninstalledRecord('a'),
    b: uninstalledRecord('b'),
  })

  assert.deepEqual(projectStore(root).read().uninstalledIds, ['a', 'b'])
})

test('视图规划：已卸载插件的加载失败不进入启用视图的失败列表', () => {
  const dependency = tempDir('cordis-state-dependency-')
  writePlugin(join(dependency, 'dep-pkg'), 'dep-id')
  const scan = scanPluginRoots([{ kind: 'dependency', dir: dependency }])
  scan.failures.push({ id: 'dep-id', reason: '插件声明不兼容' })
  scan.failures.push({ id: 'other-id', reason: '另一个失败' })

  const views = planPluginViews(scan, {
    installed: {},
    uninstalled: {},
    uninstalledIds: ['dep-id'],
    staleUninstalledIds: [],
  })

  assert.deepEqual(views.failures, [{ id: 'other-id', reason: '另一个失败' }])
})

function writePlugin(root: string, id: string, version = '1.0.0'): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ id, client: 'client.js' }))
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: `pkg-${id}`,
      version,
      peerDependencies: { 'cordis-app': '^1.0.0' },
    }),
  )
}
