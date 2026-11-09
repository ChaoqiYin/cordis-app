/**
 * 安装器的契约测试。
 *
 * 用一个假的包管理器执行器代替 npm：真跑 npm 会联网、会写缓存、会受
 * registry 状态影响，而这里要验证的是「安装前后框架对项目磁盘做了什么」。
 *
 * 项目模式下事实源是项目根：package.json、项目 lockfile、app.json。
 * 不再有 app.lock。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPluginRoots } from '../lib/plugin/catalog.js'
import { PluginInstaller } from '../lib/plugin/installer.js'
import { NpmInstallSource } from '../lib/plugin/npm-source.js'

interface Fixture {
  projectRoot: string
  nodeModules: string
  installer: PluginInstaller
  /** 下一次 `add` 要落下的包 */
  queue: Array<() => void>
  /** 依次收到的包管理器参数，用来断言回滚动作 */
  calls: string[][]
  /** 依次收到的完整命令（含管理器名），用来断言检测结果 */
  runs: Array<{ command: string; args: string[] }>
}

interface FixtureOptions {
  /** 替换默认的模拟包管理器；仍会记录命令 */
  run?: (command: string, args: string[], cwd: string) => Promise<void>
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']
const INITIAL_LOCK = 'lockfileVersion: initial\n'

/**
 * 造一个项目根。
 *
 * `run` 收到的是 `['add', spec]` 或 `['remove', name]`，这里按命令模拟包管理器
 * 对 node_modules / package.json / lockfile 的改动，从而让安装器看到真实变化。
 */
function createFixture(options: FixtureOptions = {}): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cordis-installer-'))
  const nodeModules = join(projectRoot, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  writeFileSync(
    join(projectRoot, 'app.json'),
    JSON.stringify({ name: 't', version: '0.1.0', plugins: [] }, null, 2),
  )
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 't', private: true, type: 'module', dependencies: {} }, null, 2),
  )
  writeFileSync(join(projectRoot, 'pnpm-lock.yaml'), INITIAL_LOCK)

  const fixture: Fixture = {
    projectRoot,
    nodeModules,
    queue: [],
    calls: [],
    runs: [],
    installer: undefined as unknown as PluginInstaller,
  }
  fixture.installer = new PluginInstaller({
    projectRoot,
    frameworkVersion: '1.0.0',
    async run(command, args, cwd) {
      fixture.calls.push(args)
      fixture.runs.push({ command, args })
      if (options.run) {
        await options.run(command, args, cwd)
        return
      }
      if (args[0] === 'add') {
        const task = fixture.queue.shift()
        if (!task) throw new Error('测试没有准备 add 的动作')
        task()
      } else if (args[0] === 'remove') {
        rmSync(join(nodeModules, args[1]!), { recursive: true, force: true })
        removeDependency(fixture, args[1]!)
        writeLock(fixture, `${INITIAL_LOCK}# removed ${args[1]}\n`)
      }
    },
  })
  return fixture
}

/** 往 node_modules 里放一个插件包。 */
function writePlugin(
  fixture: Fixture,
  name: string,
  options: { version?: string; peer?: Record<string, string>; id?: string; ui?: Record<string, unknown> } = {},
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
    JSON.stringify({
      id: options.id ?? name,
      server: './index.js',
      ...(options.ui ? { ui: options.ui } : {}),
    }),
  )
  writeFileSync(join(dir, 'index.js'), 'export const apply = () => {}')
}

/** 模拟包管理器对项目 package.json 的改动。 */
function addDependency(fixture: Fixture, name: string, range: string): void {
  const path = join(fixture.projectRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: range }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
}

function removeDependency(fixture: Fixture, name: string): void {
  const path = join(fixture.projectRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  if (pkg.dependencies) delete pkg.dependencies[name]
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
}

function writeLock(fixture: Fixture, content: string): void {
  writeFileSync(join(fixture.projectRoot, 'pnpm-lock.yaml'), content)
}

/** 队列动作：写入插件，并模拟包管理器更新 package.json 与 lockfile。 */
function installTask(fixture: Fixture, name: string, options: Parameters<typeof writePlugin>[2] = {}): void {
  fixture.queue.push(() => {
    writePlugin(fixture, name, options)
    addDependency(fixture, name, options.version ? `^${options.version}` : '^1.0.0')
    writeLock(fixture, `${INITIAL_LOCK}# added ${name}@${options.version ?? '1.0.0'}\n`)
  })
}

function readApp(fixture: Fixture) {
  return JSON.parse(readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8'))
}

function readPackage(fixture: Fixture) {
  return JSON.parse(readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8'))
}

function readLock(fixture: Fixture) {
  return readFileSync(join(fixture.projectRoot, 'pnpm-lock.yaml'), 'utf8')
}

function lockfileSnapshot(fixture: Fixture): Record<string, string | null> {
  return Object.fromEntries(
    LOCKFILES.map((name) => {
      const path = join(fixture.projectRoot, name)
      return [name, existsSync(path) ? readFileSync(path, 'utf8') : null]
    }),
  )
}

const JOURNAL = join('.cordis', 'install-journal.json')

/** 直接落一份事务日志，模拟「上一次安装/卸载被进程死亡打断」。 */
function writeJournal(
  fixture: Fixture,
  journal: {
    action: 'install' | 'remove'
    spec: string
    snapshot?: Record<string, string>
    versions?: Record<string, string>
    packageJson?: string | null
    lockfiles?: Record<string, string | null>
    appJson?: string | null
  },
): void {
  mkdirSync(join(fixture.projectRoot, '.cordis'), { recursive: true })
  writeFileSync(
    join(fixture.projectRoot, JOURNAL),
    JSON.stringify({
      version: 2,
      action: journal.action,
      spec: journal.spec,
      startedAt: new Date().toISOString(),
      before: {
        snapshot: journal.snapshot ?? {},
        versions: journal.versions ?? {},
        packageJson:
          journal.packageJson === undefined
            ? readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8')
            : journal.packageJson,
        lockfiles: journal.lockfiles ?? lockfileSnapshot(fixture),
        appJson:
          journal.appJson === undefined
            ? readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8')
            : journal.appJson,
      },
    }),
  )
}

/** 落一份 v3 日志，data 里可带 packageManager。 */
function writeJournalV3(
  fixture: Fixture,
  journal: {
    action: 'install' | 'remove'
    spec: string
    data: Record<string, unknown>
    files?: Record<string, string | null>
  },
): void {
  mkdirSync(join(fixture.projectRoot, '.cordis'), { recursive: true })
  writeFileSync(
    join(fixture.projectRoot, JOURNAL),
    JSON.stringify({
      version: 3,
      source: 'npm',
      action: journal.action,
      spec: journal.spec,
      startedAt: new Date().toISOString(),
      files:
        journal.files ??
        {
          [join(fixture.projectRoot, 'package.json')]: readFileSync(
            join(fixture.projectRoot, 'package.json'),
            'utf8',
          ),
          [join(fixture.projectRoot, 'app.json')]: readFileSync(
            join(fixture.projectRoot, 'app.json'),
            'utf8',
          ),
          ...Object.fromEntries(
            Object.entries(lockfileSnapshot(fixture)).map(([name, content]) => [
              join(fixture.projectRoot, name),
              content,
            ]),
          ),
        },
      data: journal.data,
    }),
  )
}

// ---------------------------------------------------------------- 安装

test('安装新插件把插件 id 追加到 app.json 的启用列表', async () => {
  const fixture = createFixture()
  installTask(fixture, 'theme-picker', { version: '2.1.3' })

  const result = await fixture.installer.install('theme-picker')
  assert.equal(result.id, 'theme-picker')
  assert.equal(result.restarted, false, '新插件不必重启，直接挂载即可')

  assert.deepEqual(fixture.runs[0], { command: 'pnpm', args: ['add', 'theme-picker'] }, '按 pnpm-lock 检测到 pnpm')
  assert.deepEqual(readApp(fixture).plugins, ['theme-picker'], 'app.json 记的是插件 id')
  assert.equal(readPackage(fixture).dependencies['theme-picker'], '^2.1.3', '依赖写进项目 package.json')
})

test('安装结果带出实际装进来的插件版本', async () => {
  const fixture = createFixture()
  installTask(fixture, 'theme-picker', { version: '2.1.3' })

  const result = await fixture.installer.install('theme-picker')
  assert.equal(result.version, '2.1.3')
})

test('npm 安装按 app.json 的 UI 能力填充 uiCompatibility', async () => {
  const fixture = createFixture()
  // 项目声明了 pages，但没有 settings；插件两个都要。
  writeFileSync(
    join(fixture.projectRoot, 'app.json'),
    JSON.stringify({
      name: 't',
      version: '0.1.0',
      plugins: [],
      ui: { pages: true, slots: [], menus: [], settings: false },
    }),
  )
  installTask(fixture, 'ui-plugin', { ui: { pages: true, settings: true } })

  const result = await fixture.installer.install('ui-plugin')
  assert.equal(result.uiCompatibility, 'backend-only')
})

test('没有 UI 需求的插件永远是 full', async () => {
  const fixture = createFixture()
  installTask(fixture, 'plain-plugin')

  const result = await fixture.installer.install('plain-plugin')
  assert.equal(result.uiCompatibility, 'full')
})


test('包名与 plugin.json 的 id 不一致时，app.json 记 id 而 package.json 记包名', async () => {
  const fixture = createFixture()
  installTask(fixture, 'npm-name', { id: 'internal-id', version: '1.0.0' })

  const result = await fixture.installer.install('npm-name')
  assert.equal(result.id, 'internal-id')
  assert.deepEqual(readApp(fixture).plugins, ['internal-id'])
  assert.equal(readPackage(fixture).dependencies['npm-name'], '^1.0.0')
})

test('重复 add 不会把 id 写两遍', async () => {
  const fixture = createFixture()
  installTask(fixture, 'theme-picker', { version: '1.0.0' })
  await fixture.installer.install('theme-picker')
  installTask(fixture, 'theme-picker', { version: '1.1.0' })
  await fixture.installer.install('theme-picker')

  assert.deepEqual(readApp(fixture).plugins, ['theme-picker'])
})

test('scoped 包名的版本分隔符不会把作用域当成版本', async () => {
  const fixture = createFixture()
  installTask(fixture, '@scope/plugin-foo', { version: '1.4.0' })

  await fixture.installer.install('@scope/plugin-foo@1.4.0')
  assert.deepEqual(readApp(fixture).plugins, ['@scope/plugin-foo'])
  assert.equal(readPackage(fixture).dependencies['@scope/plugin-foo'], '^1.4.0')
})

test('本地路径与 tarball 靠布局 diff 确定包名', async () => {
  for (const spec of ['/tmp/some-local-plugin', 'https://example.com/plugin.tgz']) {
    const fixture = createFixture()
    // 这类 spec 推不出包名，包管理器装进来的是「hello」这个包
    installTask(fixture, 'hello', { version: '3.0.0' })

    const result = await fixture.installer.install(spec)
    assert.equal(result.id, 'hello', `${spec} 应能识别出实际装进来的插件`)
    assert.deepEqual(readApp(fixture).plugins, ['hello'])
  }
})

test('已存在的包再次安装算升级，需要重启', async () => {
  const fixture = createFixture()
  writePlugin(fixture, 'theme-picker', { version: '2.1.0' })
  installTask(fixture, 'theme-picker', { version: '2.2.0' })

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
    addDependency(fixture, 'demo', '^1.0.0')
    writeLock(fixture, `${INITIAL_LOCK}# updated demo\n`)
  })

  const result = await fixture.installer.install('demo@^1.0.0')
  assert.equal(result.restarted, true)
  assert.match(result.reason, /布局/, '原因要说明是布局变化，而不是笼统的「升级」')
})

test('安装失败时恢复 package.json、lockfile 与 app.json，并撤回新包', async () => {
  const fixture = createFixture()
  const originalPackage = readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8')
  const originalLock = readLock(fixture)
  const originalApp = readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8')

  installTask(fixture, 'old-react', {
    peer: { 'cordis-app': '^1.0.0', react: '^18.0.0' },
  })

  await assert.rejects(() => fixture.installer.install('old-react'), /不兼容/)

  assert.equal(existsSync(join(fixture.nodeModules, 'old-react')), false, '失败安装不该留下包')
  assert.equal(readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8'), originalPackage)
  assert.equal(readLock(fixture), originalLock)
  assert.equal(readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8'), originalApp)
  assert.deepEqual(fixture.calls.at(-1), ['remove', 'old-react'])
})

test('升级失败时按事务前记录的版本装回旧版本', async () => {
  const fixture = createFixture()
  installTask(fixture, 'upgradable', { version: '1.0.0' })
  await fixture.installer.install('upgradable')

  // 新版插件声明了不兼容的 React；回滚时按事务前快照恢复 1.0.0
  installTask(fixture, 'upgradable', {
    version: '2.0.0',
    peer: { 'cordis-app': '^1.0.0', react: '^18.0.0' },
  })
  fixture.queue.push(() => writePlugin(fixture, 'upgradable', { version: '1.0.0' }))

  await assert.rejects(() => fixture.installer.install('upgradable'), /不兼容/)

  assert.deepEqual(fixture.calls.at(-1), ['add', 'upgradable@1.0.0'])
  const pkg = JSON.parse(readFileSync(join(fixture.nodeModules, 'upgradable', 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.0.0', '失败升级应当回到事务前的版本')
  assert.equal(readPackage(fixture).dependencies['upgradable'], '^1.0.0')
})

test('npm 安装不校验入口扩展名，由运行时扫描拒绝非 JS 入口', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => {
    const dir = join(fixture.nodeModules, 'ts-entry')
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'ts-entry',
        version: '1.0.0',
        type: 'module',
        peerDependencies: { 'cordis-app': '^1.0.0' },
      }),
    )
    writeFileSync(
      join(dir, 'plugin.json'),
      JSON.stringify({ id: 'ts-entry', client: 'src/client.tsx' }),
    )
    writeFileSync(join(dir, 'src', 'client.tsx'), 'export default function activate() {}\n')
    addDependency(fixture, 'ts-entry', '^1.0.0')
    writeLock(fixture, `${INITIAL_LOCK}# added ts-entry@1.0.0\n`)
  })

  const result = await fixture.installer.install('ts-entry')

  assert.equal(result.id, 'ts-entry', '安装期只关心清单与 peer，不校验入口扩展名')
  assert.deepEqual(readApp(fixture).plugins, ['ts-entry'], '安装成功后记录启用意图')
  assert.equal(existsSync(join(fixture.nodeModules, 'ts-entry')), true, '包保留在 node_modules')

  // 入口扩展名由运行时扫描拒绝，而不是安装期。
  const scan = scanPluginRoots([{ kind: 'dependency', dir: fixture.nodeModules }])
  assert.equal(scan.plugins.length, 0, '非 JS 入口不能进入可加载集合')
  assert.equal(scan.failures.length, 1)
  assert.match(scan.failures[0]!.reason, /client\.tsx/, '运行时扫描错误应指出非 JS 入口')
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
    addDependency(fixture, 'not-a-plugin', '^1.0.0')
    writeLock(fixture, `${INITIAL_LOCK}# added not-a-plugin\n`)
  })

  await assert.rejects(() => fixture.installer.install('not-a-plugin'), /plugin\.json/)
  assert.deepEqual(readApp(fixture).plugins, [])
})

test('未声明核心 peer 的插件被拒绝', async () => {
  const fixture = createFixture()
  installTask(fixture, 'loose', { peer: {} })

  await assert.rejects(() => fixture.installer.install('loose'), /peerDependencies/)
})

test('安装引入多个插件时要求改用包名', async () => {
  const fixture = createFixture()
  fixture.queue.push(() => {
    writePlugin(fixture, 'bundle-a')
    writePlugin(fixture, 'bundle-b')
    writeLock(fixture, `${INITIAL_LOCK}# added bundle\n`)
  })

  await assert.rejects(() => fixture.installer.install('/tmp/multi-plugin-bundle'), /多个插件/)
})

// ---------------------------------------------------------------- 卸载

test('卸载后 app.json 的启用列表不再保留该插件', async () => {
  const fixture = createFixture()
  installTask(fixture, 'theme-picker', { version: '2.1.3' })
  await fixture.installer.install('theme-picker')
  assert.deepEqual(readApp(fixture).plugins, ['theme-picker'])

  const result = await fixture.installer.remove('theme-picker')
  assert.equal(result.restarted, true, '卸载必须重启：require.cache 里的代码撤不掉')

  assert.deepEqual(readApp(fixture).plugins, [], 'app.json 不能再写着已卸载的插件')
  assert.equal(readPackage(fixture).dependencies['theme-picker'], undefined)
})

test('卸载不波及其他插件的启用项', async () => {
  const fixture = createFixture()
  installTask(fixture, 'keep-me', { version: '1.0.0' })
  await fixture.installer.install('keep-me')
  installTask(fixture, 'drop-me', { version: '1.0.0' })
  await fixture.installer.install('drop-me')

  await fixture.installer.remove('drop-me')

  assert.deepEqual(readApp(fixture).plugins, ['keep-me'])
})

test('卸载不存在的插件不破坏清单', async () => {
  const fixture = createFixture()
  installTask(fixture, 'existing', { version: '1.0.0' })
  await fixture.installer.install('existing')

  const result = await fixture.installer.remove('never-installed')
  assert.equal(result.id, 'never-installed')
  assert.deepEqual(readApp(fixture).plugins, ['existing'])
})

// ---------------------------------------------------------------- 事务恢复

test('成功安装后没有待恢复的事务', async () => {
  const fixture = createFixture()
  installTask(fixture, 'theme-picker')
  await fixture.installer.install('theme-picker')

  const callsBefore = fixture.calls.length
  assert.equal(await fixture.installer.recover(), undefined)
  assert.equal(fixture.calls.length, callsBefore, '没有日志时 recover 不应调用包管理器')
})

test('恢复会撤掉上一次中断安装新增的包，并还原三个事实文件', async () => {
  const fixture = createFixture()
  const originalPackage = readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8')
  const originalLock = readLock(fixture)
  const originalApp = readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8')

  // 事务开始后：包已写入，package.json / lockfile 已被包管理器改过，进程死亡。
  writePlugin(fixture, 'half-installed', { version: '1.0.0' })
  addDependency(fixture, 'half-installed', '^1.0.0')
  writeLock(fixture, `${INITIAL_LOCK}# added half-installed\n`)
  writeJournal(fixture, {
    action: 'install',
    spec: 'half-installed',
    packageJson: originalPackage,
    // 日志记的是事务开始前的内容；lockfile 已被模拟的包管理器改过，这里显式给原文
    lockfiles: { ...lockfileSnapshot(fixture), 'pnpm-lock.yaml': originalLock },
    appJson: originalApp,
  })

  const result = await fixture.installer.recover()

  assert.equal(result?.action, 'install')
  assert.equal(result?.spec, 'half-installed')
  assert.equal(existsSync(join(fixture.nodeModules, 'half-installed')), false, '残留包要被撤掉')
  assert.equal(readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8'), originalPackage)
  assert.equal(readLock(fixture), originalLock)
  assert.equal(readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8'), originalApp)
})

test('恢复会把被中断卸载删掉的包按事务前版本装回', async () => {
  const fixture = createFixture()
  const originalPackage = readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8')
  const originalLock = readLock(fixture)
  const originalApp = readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8')

  // 事务前有 keep；事务中包被删掉。日志里的快照记录它原来的位置。
  writeJournal(fixture, {
    action: 'remove',
    spec: 'keep',
    snapshot: { keep: join(fixture.nodeModules, 'keep') },
    versions: { keep: '1.2.0' },
    packageJson: originalPackage,
    lockfiles: lockfileSnapshot(fixture),
    appJson: originalApp,
  })
  installTask(fixture, 'keep', { version: '1.2.0' })

  const result = await fixture.installer.recover()

  assert.equal(result?.action, 'remove')
  assert.deepEqual(fixture.calls.at(-1), ['add', 'keep@1.2.0'], '按事务前快照恢复版本')
  assert.equal(readFileSync(join(fixture.projectRoot, 'package.json'), 'utf8'), originalPackage)
  assert.equal(readLock(fixture), originalLock)
  assert.equal(readFileSync(join(fixture.projectRoot, 'app.json'), 'utf8'), originalApp)
})

test('没有事务日志时 recover 是空操作', async () => {
  const fixture = createFixture()
  assert.equal(await fixture.installer.recover(), undefined)
  assert.deepEqual(fixture.calls, [])
})

// ---------------------------------------------------------------- 生命周期事务

test('额外快照文件与物理动作同事务：提交钩子失败时一起回滚', async () => {
  const fixture = createFixture()
  installTask(fixture, 'theme-picker', { version: '2.1.3' })
  const statePath = join(fixture.projectRoot, 'data', 'plugins-state.json')
  mkdirSync(join(fixture.projectRoot, 'data'), { recursive: true })
  writeFileSync(statePath, '{"version":1,"installed":{},"uninstalled":{}}\n')
  const before = readFileSync(statePath, 'utf8')

  await assert.rejects(
    () =>
      fixture.installer.install('theme-picker', {
        snapshotPaths: [statePath],
        commit() {
          // 模拟状态写盘只完成一半后失败：事务必须把状态文件也还原。
          writeFileSync(statePath, '{"broken":true}\n')
          throw new Error('状态写入失败')
        },
      }),
    /状态写入失败/,
  )

  assert.equal(readFileSync(statePath, 'utf8'), before, '状态文件必须回到事务前')
  assert.equal(existsSync(join(fixture.nodeModules, 'theme-picker')), false, '新包必须被撤回')
  assert.deepEqual(readApp(fixture).plugins, [], 'app.json 的启用顺序必须回滚')
  assert.equal(existsSync(join(fixture.projectRoot, JOURNAL)), false, '回滚后不留下事务日志')
})

test('提交钩子在物理动作之后执行，并能读到实际安装结果', async () => {
  const fixture = createFixture()
  installTask(fixture, 'theme-picker', { version: '2.1.3' })
  const seen: Array<{ id: string; version?: string }> = []

  const result = await fixture.installer.install('theme-picker', {
    commit(installed) {
      seen.push({ id: installed.id, ...(installed.version ? { version: installed.version } : {}) })
    },
  })

  assert.deepEqual(seen, [{ id: 'theme-picker', version: '2.1.3' }])
  assert.equal(result.id, 'theme-picker')
})

test('逻辑卸载走同一条事务：状态写入失败时回滚，成功时提交', async () => {
  const fixture = createFixture()
  const statePath = join(fixture.projectRoot, 'data', 'plugins-state.json')
  mkdirSync(join(fixture.projectRoot, 'data'), { recursive: true })
  writeFileSync(statePath, 'before\n')

  await assert.rejects(
    () =>
      fixture.installer.logical(
        'remove',
        'demo',
        { id: 'demo', restarted: true, reason: '逻辑卸载' },
        {
          snapshotPaths: [statePath],
          commit() {
            writeFileSync(statePath, 'half-written\n')
            throw new Error('逻辑卸载状态写入失败')
          },
        },
      ),
    /逻辑卸载状态写入失败/,
  )
  assert.equal(readFileSync(statePath, 'utf8'), 'before\n')
  assert.deepEqual(fixture.calls, [], '逻辑卸载不能调用包管理器')

  const result = await fixture.installer.logical(
    'remove',
    'demo',
    { id: 'demo', restarted: true, reason: '逻辑卸载' },
    {
      snapshotPaths: [statePath],
      commit() {
        writeFileSync(statePath, 'committed\n')
      },
    },
  )
  assert.deepEqual(result, { id: 'demo', restarted: true, reason: '逻辑卸载' })
  assert.equal(readFileSync(statePath, 'utf8'), 'committed\n')
  assert.equal(existsSync(join(fixture.projectRoot, JOURNAL)), false)
})

// ---------------------------------------------------------------- 包管理器适配

test('安装事务日志记录检测到的包管理器', async () => {
  const fixture = createFixture()
  let recorded: { data?: { packageManager?: string } } | undefined
  fixture.queue.push(() => {
    recorded = JSON.parse(readFileSync(join(fixture.projectRoot, JOURNAL), 'utf8'))
    writePlugin(fixture, 'theme-picker')
    addDependency(fixture, 'theme-picker', '^1.0.0')
    writeLock(fixture, `${INITIAL_LOCK}# added theme-picker\n`)
  })

  await fixture.installer.install('theme-picker')

  assert.equal(recorded?.data?.packageManager, 'pnpm', '日志要记下本次实际使用的管理器')
})

test('恢复使用事务日志里的包管理器，而不是当前检测结果', async () => {
  const fixture = createFixture()
  // 当前项目没有任何信号，重新检测会回退 npm；日志里的 pnpm 必须优先。
  rmSync(join(fixture.projectRoot, 'pnpm-lock.yaml'))
  const keepDir = join(fixture.nodeModules, 'keep')
  mkdirSync(keepDir, { recursive: true })
  writeJournalV3(fixture, {
    action: 'remove',
    spec: 'keep',
    data: {
      snapshot: { keep: keepDir },
      versions: { keep: '1.2.0' },
      packageManager: 'pnpm',
    },
  })
  installTask(fixture, 'keep', { version: '1.2.0' })

  await fixture.installer.recover()

  assert.deepEqual(fixture.runs.at(-1), { command: 'pnpm', args: ['add', 'keep@1.2.0'] })
})

test('两次动作之间 lockfile 变化时重新检测包管理器', async () => {
  const fixture = createFixture()
  installTask(fixture, 'first')
  await fixture.installer.install('first')

  // 项目从 pnpm 迁移到 yarn：下一次动作必须使用新的管理器，不能复用上一次的缓存。
  rmSync(join(fixture.projectRoot, 'pnpm-lock.yaml'))
  writeFileSync(join(fixture.projectRoot, 'yarn.lock'), '')
  fixture.queue.push(() => {
    writePlugin(fixture, 'second')
    addDependency(fixture, 'second', '^1.0.0')
  })

  await fixture.installer.install('second')

  assert.deepEqual(
    fixture.runs.map((run) => run.command),
    ['pnpm', 'yarn'],
  )
})

test('旧事务日志没有 packageManager 字段时回退 npm', async () => {
  const fixture = createFixture()
  const keepDir = join(fixture.nodeModules, 'keep')
  mkdirSync(keepDir, { recursive: true })
  // v2 日志没有包管理器字段，即便项目现在是 pnpm 也按 npm 恢复。
  writeJournal(fixture, {
    action: 'remove',
    spec: 'keep',
    snapshot: { keep: keepDir },
    versions: { keep: '1.2.0' },
  })
  installTask(fixture, 'keep', { version: '1.2.0' })

  await fixture.installer.recover()

  assert.deepEqual(fixture.runs.at(-1), { command: 'npm', args: ['add', 'keep@1.2.0'] })
})

test('包管理器信号冲突时明确报错，且不执行任何包管理器命令', async () => {
  const fixture = createFixture()
  rmSync(join(fixture.projectRoot, 'pnpm-lock.yaml'))
  writeFileSync(join(fixture.projectRoot, 'package-lock.json'), '{}')
  writeFileSync(join(fixture.projectRoot, 'yarn.lock'), '')

  await assert.rejects(
    () => fixture.installer.install('theme-picker'),
    (error: Error) =>
      /冲突|歧义/.test(error.message) &&
      /npm/.test(error.message) &&
      /yarn/.test(error.message) &&
      /packageManager|删除/.test(error.message),
  )
  assert.deepEqual(fixture.runs, [], '检测失败不能先跑一次包管理器')
})

test('包管理器执行失败时错误信息包含管理器与命令', async () => {
  const fixture = createFixture({
    async run() {
      throw new Error('spawn ENOENT')
    },
  })

  await assert.rejects(
    () => fixture.installer.install('theme-picker'),
    (error: Error) =>
      /pnpm/.test(error.message) &&
      /add theme-picker/.test(error.message) &&
      /ENOENT/.test(error.message),
  )
})

// ---------------------------------------------------------------- 布局快照

/** 布局快照只属于 npm 来源；这里直接构造来源，避免把它的实现细节挂回事务层。 */
function npmSourceOf(fixture: Fixture): NpmInstallSource {
  return new NpmInstallSource({
    projectRoot: fixture.projectRoot,
    frameworkVersion: '1.0.0',
  })
}

test('布局快照跳过点目录与无 package.json 的目录', () => {
  const fixture = createFixture()
  writePlugin(fixture, 'demo')
  mkdirSync(join(fixture.nodeModules, '.bin'), { recursive: true })
  mkdirSync(join(fixture.nodeModules, 'empty'), { recursive: true })

  const layout = npmSourceOf(fixture).snapshot()
  assert.deepEqual([...layout.keys()], ['demo'])
})

test('scoped 包在快照里的名字带作用域', () => {
  const fixture = createFixture()
  writePlugin(fixture, '@scope/plugin-foo')

  const layout = npmSourceOf(fixture).snapshot()
  assert.deepEqual([...layout.keys()], ['@scope/plugin-foo'])
})
