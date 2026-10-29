/**
 * 安装器的契约测试。
 *
 * 用一个假的包管理器执行器代替 npm：真跑 npm 会联网、会写缓存、会受
 * registry 状态影响，而这里要验证的是「安装前后框架对磁盘做了什么」——
 * 包管理器只是其中一步，它成功与否不影响这些断言。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginInstaller } from '../lib/plugin/installer.js'

interface Fixture {
  instanceDir: string
  nodeModules: string
  installer: PluginInstaller
  /** 下一次 `npm add` 要落下的包 */
  queue: Array<() => void>
  /** 依次收到的包管理器命令，用来断言回滚动作 */
  calls: string[][]
}

/**
 * 造一个实例目录。
 *
 * `run` 收到的是 `['add', spec]` 或 `['remove', name]`，这里按命令模拟包管理器
 * 对 node_modules 的改动，从而让安装器看到真实的布局变化。
 */
function createFixture(): Fixture {
  const instanceDir = mkdtempSync(join(tmpdir(), 'cordis-installer-'))
  const nodeModules = join(instanceDir, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  writeFileSync(
    join(instanceDir, 'app.json'),
    JSON.stringify({ name: 't', version: '1.0.0', framework: '^1.0.0', plugins: {} }, null, 2),
  )

  const queue: Array<() => void> = []
  const calls: string[][] = []
  const installer = new PluginInstaller({
    instanceDir,
    frameworkVersion: '1.0.0',
    async run(_command, args) {
      calls.push(args)
      if (args[0] === 'add') {
        const task = queue.shift()
        if (!task) throw new Error('测试没有准备 add 的动作')
        task()
      } else if (args[0] === 'remove') {
        rmSync(join(nodeModules, args[1]!), { recursive: true, force: true })
      }
    },
  })

  return { instanceDir, nodeModules, installer, queue, calls }
}

/** 往 node_modules 里放一个插件包。 */
function writePlugin(
  fixture: Fixture,
  name: string,
  options: { version?: string; peer?: Record<string, string>; id?: string } = {},
): void {
  const dir = join(fixture.nodeModules, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name,
      version: options.version ?? '1.0.0',
      type: 'module',
      peerDependencies: options.peer ?? { 'cordis-app': '^1.0.0' },
    }),
  )
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ id: options.id ?? name, server: './index.js' }),
  )
  writeFileSync(join(dir, 'index.js'), 'export const apply = () => {}')
}

function readApp(fixture: Fixture) {
  return JSON.parse(readFileSync(join(fixture.instanceDir, 'app.json'), 'utf8'))
}

function readLock(fixture: Fixture) {
  return JSON.parse(readFileSync(join(fixture.instanceDir, 'app.lock'), 'utf8'))
}

const JOURNAL = '.install-journal.json'

/** 直接落一份事务日志，模拟「上一次安装/卸载被进程死亡打断」。 */
function writeJournal(
  fixture: Fixture,
  journal: {
    action: 'install' | 'remove'
    spec: string
    snapshot?: Record<string, string>
    appJson?: string | null
    appLock?: string | null
  },
): void {
  writeFileSync(
    join(fixture.instanceDir, JOURNAL),
    JSON.stringify({
      version: 1,
      action: journal.action,
      spec: journal.spec,
      startedAt: new Date().toISOString(),
      before: {
        snapshot: journal.snapshot ?? {},
        appJson: journal.appJson === undefined ? readFileSync(join(fixture.instanceDir, 'app.json'), 'utf8') : journal.appJson,
        appLock: journal.appLock ?? null,
      },
    }),
  )
}

function journalExists(fixture: Fixture): boolean {
  return existsSync(join(fixture.instanceDir, JOURNAL))
}

// ---------------------------------------------------------------- 安装

test('安装新插件写回 app.json 的意图清单', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'theme-picker', { version: '2.1.3' }))

  const result = await fixture.installer.install('theme-picker')
  assert.equal(result.id, 'theme-picker')
  assert.equal(result.restarted, false, '新插件不必重启，直接挂载即可')

  const app = readApp(fixture)
  assert.equal(app.plugins['theme-picker'], '^2.1.3', '没写版本时应按实际安装版本生成范围')
  assert.equal(readLock(fixture).plugins['theme-picker'].version, '2.1.3')
})

test('带上版本范围的 spec 会原样记进 app.json', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'theme-picker', { version: '2.1.3' }))

  await fixture.installer.install('theme-picker@^2.0.0')
  assert.equal(readApp(fixture).plugins['theme-picker'], '^2.0.0', '用户写的范围要保留，不能被实际版本覆盖')
})

test('scoped 包名的版本分隔符不会把作用域当成版本', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, '@scope/plugin-foo', { version: '1.4.0' }))

  await fixture.installer.install('@scope/plugin-foo@1.4.0')
  const app = readApp(fixture)
  assert.equal(app.plugins['@scope/plugin-foo'], '1.4.0')
})

test('本地路径与 tarball 靠布局 diff 确定包名', async () => {
  for (const spec of ['/tmp/some-local-plugin', 'https://example.com/plugin.tgz']) {
    const fixture = createFixture()
    // 这类 spec 推不出包名，包管理器装进来的是「hello」这个包
    fixture.queue.push(() => writePlugin(fixture, 'hello', { version: '3.0.0' }))

    const result = await fixture.installer.install(spec)
    assert.equal(result.id, 'hello', `${spec} 应能识别出实际装进来的插件`)
    assert.equal(readApp(fixture).plugins.hello, '^3.0.0')
  }
})

test('已存在的包再次安装算升级，需要重启', async () => {
  const fixture = createFixture()
  writePlugin(fixture, 'theme-picker', { version: '2.1.0' })
  fixture.queue.push(() => writePlugin(fixture, 'theme-picker', { version: '2.2.0' }))

  const result = await fixture.installer.install('theme-picker@^2.0.0')
  assert.equal(result.restarted, true, '升级已加载的插件必须重启 worker')
})

test('依赖搬家算布局变化，需要重启', async () => {
  const fixture = createFixture()
  writePlugin(fixture, 'lodash', { version: '4.17.0' })
  writePlugin(fixture, 'demo', { version: '1.0.0' })

  fixture.queue.push(() => {
    // 新版 demo 把 lodash 提到了自己的 node_modules 里：路径变了
    rmSync(join(fixture.nodeModules, 'lodash'), { recursive: true, force: true })
    writePlugin(fixture, 'demo', { version: '1.1.0' })
    const nested = join(fixture.nodeModules, 'demo', 'node_modules', 'lodash')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'lodash', version: '4.17.21' }))
  })

  const result = await fixture.installer.install('demo@^1.0.0')
  assert.equal(result.restarted, true)
  assert.match(result.reason, /布局/, '原因要说明是布局变化，而不是笼统的「升级」')
})

test('缺少 plugin.json 的包被拒绝，且不写进 app.json', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => {
    const dir = join(fixture.nodeModules, 'not-a-plugin')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'not-a-plugin', version: '1.0.0', peerDependencies: { 'cordis-app': '^1.0.0' } }),
    )
  })

  await assert.rejects(() => fixture.installer.install('not-a-plugin'), /plugin\.json/)
  assert.deepEqual(readApp(fixture).plugins, {})
})

test('未声明核心 peer 的插件被拒绝', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'loose', { peer: {} }))

  await assert.rejects(() => fixture.installer.install('loose'), /peerDependencies/)
})

test('React 大版本不兼容时安装失败', async () => {
  const fixture = createFixture()
  fixture.queue.push(() =>
    writePlugin(fixture, 'old-react', { peer: { 'cordis-app': '^1.0.0', react: '^18.0.0' } }),
  )

  await assert.rejects(() => fixture.installer.install('old-react'), /不兼容/)
})

test('校验失败时把刚装进来的包撤回', async () => {
  // 失败发生在包管理器已经改过盘之后。不回滚的话，node_modules 里有包、
  // app.json 里没有，list 与设置页会各说各话。
  const fixture = createFixture()
  fixture.queue.push(() =>
    writePlugin(fixture, 'old-react', { peer: { 'cordis-app': '^1.0.0', react: '^18.0.0' } }),
  )

  await assert.rejects(() => fixture.installer.install('old-react'), /不兼容/)
  assert.equal(existsSync(join(fixture.nodeModules, 'old-react')), false, '失败安装不该留下包')
  assert.deepEqual(readApp(fixture).plugins, {})
  assert.deepEqual(fixture.calls.at(-1), ['remove', 'old-react'])
})

test('升级失败时按 app.lock 装回旧版本', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'upgradable', { version: '1.0.0' }))
  await fixture.installer.install('upgradable')

  // 新版插件声明了不兼容的 React；回滚时按 lock 记录的 1.0.0 重装
  fixture.queue.push(() =>
    writePlugin(fixture, 'upgradable', {
      version: '2.0.0',
      peer: { 'cordis-app': '^1.0.0', react: '^18.0.0' },
    }),
  )
  fixture.queue.push(() => writePlugin(fixture, 'upgradable', { version: '1.0.0' }))

  await assert.rejects(() => fixture.installer.install('upgradable'), /不兼容/)

  assert.deepEqual(fixture.calls.at(-1), ['add', 'upgradable@1.0.0'])
  const pkg = JSON.parse(readFileSync(join(fixture.nodeModules, 'upgradable', 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.0.0', '失败升级应当回到锁定的版本')
})

test('包名与 plugin.json 的 id 不一致时不报警（两者按设计分离）', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'npm-name', { id: 'internal-id', version: '1.0.0' }))

  const result = await fixture.installer.install('npm-name')
  assert.equal(result.id, 'internal-id', '结果里报的是插件 id')
  assert.equal(readApp(fixture).plugins['npm-name'], '^1.0.0', 'app.json 记的是包名')
})

test('安装引入多个插件时要求改用包名', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => {
    writePlugin(fixture, 'bundle-a')
    writePlugin(fixture, 'bundle-b')
  })

  await assert.rejects(() => fixture.installer.install('/tmp/multi-plugin-bundle'), /多个插件/)
})

// ---------------------------------------------------------------- 卸载

test('卸载后 app.lock 与 app.json 都不再保留该插件', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'theme-picker', { version: '2.1.3' }))
  await fixture.installer.install('theme-picker')
  assert.equal(readApp(fixture).plugins['theme-picker'], '^2.1.3')

  const result = await fixture.installer.remove('theme-picker')
  assert.equal(result.restarted, true, '卸载必须重启：require.cache 里的代码撤不掉')

  assert.equal(readApp(fixture).plugins['theme-picker'], undefined, 'app.json 不能再写着已卸载的插件')
  assert.equal(readLock(fixture).plugins['theme-picker'], undefined, 'lock 是重建而不是累加')
})

test('卸载不波及其他插件的清单项', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'keep-me', { version: '1.0.0' }))
  await fixture.installer.install('keep-me')
  fixture.queue.push(() => writePlugin(fixture, 'drop-me', { version: '1.0.0' }))
  await fixture.installer.install('drop-me')

  await fixture.installer.remove('drop-me')

  const app = readApp(fixture)
  assert.equal(app.plugins['keep-me'], '^1.0.0')
  assert.equal(app.plugins['drop-me'], undefined)
})

test('卸载不存在的插件不破坏清单', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'existing', { version: '1.0.0' }))
  await fixture.installer.install('existing')

  const result = await fixture.installer.remove('never-installed')
  assert.equal(result.id, 'never-installed')
  assert.equal(readApp(fixture).plugins.existing, '^1.0.0')
})

// ---------------------------------------------------------------- 事务恢复

test('成功安装后不留下事务日志', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => writePlugin(fixture, 'theme-picker'))
  await fixture.installer.install('theme-picker')
  assert.equal(journalExists(fixture), false)
})

test('恢复会撤掉上一次安装新增的插件包，并还原 app.json', async () => {
  const fixture = createFixture()
  writePlugin(fixture, 'half-installed', { version: '1.0.0' })
  // 事务前 app.json 是空的，日志里记的就是它
  writeJournal(fixture, { action: 'install', spec: 'half-installed' })

  const result = await fixture.installer.recover()

  assert.equal(result?.action, 'install')
  assert.equal(result?.spec, 'half-installed')
  assert.equal(existsSync(join(fixture.nodeModules, 'half-installed')), false, '残留包要被撤掉')
  assert.deepEqual(readApp(fixture).plugins, {}, 'app.json 回到事务前')
  assert.equal(journalExists(fixture), false, '恢复完成后删除日志')
})

test('恢复会把被中断卸载删掉的包按 lock 装回', async () => {
  const fixture = createFixture()
  const originalApp = readFileSync(join(fixture.instanceDir, 'app.json'), 'utf8')
  const originalLock = JSON.stringify(
    { lockfileVersion: 1, plugins: { keep: { version: '1.2.0', resolved: 'https://example.com/keep.tgz' } } },
    null,
    2,
  )
  writeJournal(fixture, {
    action: 'remove',
    spec: 'keep',
    snapshot: { keep: join(fixture.nodeModules, 'keep') },
    appJson: originalApp,
    appLock: originalLock,
  })
  fixture.queue.push(() => writePlugin(fixture, 'keep', { version: '1.2.0' }))

  const result = await fixture.installer.recover()

  assert.equal(result?.action, 'remove')
  assert.deepEqual(fixture.calls.at(-1), ['add', 'keep@1.2.0'], '按事务前的 lock 恢复版本')
  assert.equal(readFileSync(join(fixture.instanceDir, 'app.lock'), 'utf8'), originalLock, 'lock 原文还原')
  assert.equal(journalExists(fixture), false)
})

test('没有事务日志时 recover 是空操作', async () => {
  const fixture = createFixture()
  assert.equal(await fixture.installer.recover(), undefined)
  assert.deepEqual(fixture.calls, [])
})

// ---------------------------------------------------------------- 布局快照

test('布局快照跳过点目录与无 package.json 的目录', () => {
  const fixture = createFixture()
  writePlugin(fixture, 'demo')
  mkdirSync(join(fixture.nodeModules, '.bin'), { recursive: true })
  mkdirSync(join(fixture.nodeModules, 'empty'), { recursive: true })

  const layout = fixture.installer.snapshot()
  assert.deepEqual([...layout.keys()], ['demo'])
})

test('scoped 包在快照里的名字带作用域', () => {
  const fixture = createFixture()
  writePlugin(fixture, '@scope/plugin-foo')

  const layout = fixture.installer.snapshot()
  assert.deepEqual([...layout.keys()], ['@scope/plugin-foo'])
})
