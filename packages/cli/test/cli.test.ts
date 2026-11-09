/**
 * CLI 的契约测试。
 *
 * 测试对象是「命令行为」而不是「进程行为」：所有命令都接受注入的 IO 与依赖，
 * 因此这里可以断言输出文本、退出码与磁盘结果，而不需要 spawn 一个真实进程。
 * 包管理器同样由测试注入，add/remove 不会联网。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRAMEWORK_VERSION } from '@cordis-app/protocol'
import { findFreePort, generateToken, startWorker } from '@cordis-app/runtime'
import { parseArgs, UsageError, main } from '../lib/index.js'
import {
  commandAdd,
  commandEnable,
  commandList,
  commandNew,
  commandRemove,
  defaultIO,
  type CommandIO,
} from '../lib/index.js'

interface Fake {
  out: string[]
  err: string[]
  io: CommandIO
}

function fakeIO(overrides: Partial<CommandIO> = {}): Fake {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      frameworkVersion: FRAMEWORK_VERSION,
      ...overrides,
    },
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cordis-cli-'))
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 往项目 node_modules 里放一个插件包。 */
function writeInstalledPlugin(root: string, packageName: string, id: string, version = '1.2.3'): void {
  const dir = join(root, 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: packageName, version, peerDependencies: { 'cordis-app': '^1.0.0' } }),
  )
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, server: './index.js' }))
  writeFileSync(join(dir, 'index.js'), 'export const apply = () => {}')
}

/** 往任意插件根里放一个插件包（随包、项目本地、依赖根共用）。 */
function writePluginDir(dir: string, packageName: string, id: string, version = '1.2.3'): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: packageName, version, peerDependencies: { 'cordis-app': '^1.0.0' } }),
  )
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, server: './index.js' }))
  writeFileSync(join(dir, 'index.js'), 'export const apply = () => {}')
}

/** 让项目 package.json 声明一个依赖。 */
function writeDependency(root: string, name: string, range = '^1.0.0'): void {
  const path = join(root, 'package.json')
  const pkg = readJson(path)
  pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: range }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n')
}

// ---------------------------------------------------------------- 参数解析

test('子命令与位置参数分开解析', () => {
  const parsed = parseArgs(['add', 'theme-picker'])
  assert.equal(parsed.command, 'add')
  assert.deepEqual(parsed.positionals, ['theme-picker'])
})

test('--project 是项目根，--data 是兼容别名', () => {
  assert.equal(parseArgs(['list', '--project', '/tmp/x']).projectDir, '/tmp/x')
  assert.equal(parseArgs(['list', '--project=/tmp/y']).projectDir, '/tmp/y')
  assert.equal(parseArgs(['list', '--data', '/tmp/z']).projectDir, '/tmp/z')
  assert.equal(parseArgs(['list', '--data=/tmp/w']).projectDir, '/tmp/w')
})

test('未知命令与未知选项都报错', () => {
  assert.throws(() => parseArgs(['publish']), UsageError)
  assert.throws(() => parseArgs(['run', '--colour']), UsageError)
})

test('--port 必须是合法端口号', () => {
  assert.equal(parseArgs(['run', '--port', '5140']).port, 5140)
  assert.throws(() => parseArgs(['run', '--port', '0']), UsageError)
  assert.throws(() => parseArgs(['run', '--port', 'abc']), UsageError)
})

test('--shell 只对 dev 有效', () => {
  assert.equal(parseArgs(['dev', '--shell']).shell, true)
  assert.equal(parseArgs(['dev']).shell, false)
  assert.throws(() => parseArgs(['run', '--shell']), UsageError)
})

test('--help 压过任何子命令', () => {
  assert.equal(parseArgs(['add', 'foo', '--help']).command, 'help')
})

// ---------------------------------------------------------------- new

test('new 生成一个可运行的项目根', async () => {
  const root = join(tempDir(), 'demo')
  const fake = fakeIO()
  const code = await commandNew(parseArgs(['new', 'demo', '--project', root]), fake.io)
  assert.equal(code, 0)

  const app = readJson(join(root, 'app.json'))
  assert.equal(app.name, 'demo')
  assert.deepEqual(app.plugins, [], '新项目不应预装任何插件')
  assert.equal(app.framework, undefined, 'app.json 不保存框架版本范围')
  assert.deepEqual(app.ui, {
    pages: true,
    slots: ['header.right', 'activity.bottom'],
    menus: ['activity'],
    settings: true,
  })

  const pkg = readJson(join(root, 'package.json'))
  assert.equal(pkg.private, true)
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.scripts.dev, 'cordis-app dev')
  assert.equal(pkg.scripts.build, 'cordis-app build')
  assert.equal(pkg.scripts.start, 'cordis-app start')
  assert.equal(pkg.dependencies['cordis-app'], `^${FRAMEWORK_VERSION}`)
  assert.ok(pkg.dependencies.react)
  assert.ok(pkg.dependencies['react-dom'])

  // 项目骨架：body、页面、后端入口、本地插件、数据与运行时目录
  assert.ok(existsSync(join(root, 'src', 'body.tsx')))
  assert.ok(existsSync(join(root, 'src', 'pages', 'Home.tsx')))
  assert.ok(existsSync(join(root, 'server', 'index.js')))
  assert.ok(existsSync(join(root, 'plugins')))
  assert.ok(existsSync(join(root, 'data')))
  assert.ok(existsSync(join(root, '.cordis')))

  // body 直接使用宿主的默认参考实现，同时保留项目自己的编辑点；
  // 根路径渲染脚手架自带的 Home，其余路径交给 DefaultBody。
  const body = readFileSync(join(root, 'src', 'body.tsx'), 'utf8')
  assert.match(body, /cordis-app\/ui/)
  assert.match(body, /DefaultBody/)
  assert.match(body, /usePath/)
  assert.match(body, /from '\.\/pages\/Home'/)
  assert.match(body, /<Home \/>/)
  assert.match(body, /export default function Body/)

  const server = readFileSync(join(root, 'server', 'index.js'), 'utf8')
  assert.match(server, /export default function apply/)
  assert.match(server, /\/api\/hello/)

  const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')
  for (const ignored of ['node_modules/', 'dist/', '.cordis/', 'data/']) {
    assert.ok(gitignore.includes(ignored), `.gitignore 应忽略 ${ignored}`)
  }

  // 旧模型不留下任何痕迹
  assert.equal(existsSync(join(root, 'app.lock')), false)
  assert.equal(existsSync(join(root, 'instances')), false)
})

test('new 生成的项目可以直接启动后端', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({ port, token, projectRoot: root })
  try {
    const denied = await fetch(`http://127.0.0.1:${port}/api/hello`)
    assert.equal(denied.status, 401)

    const res = await fetch(`http://127.0.0.1:${port}/api/hello`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { hello: 'world' })
    assert.equal(existsSync(join(root, '.cordis')), true)
  } finally {
    await handle.close()
  }
})

test('new 不会覆盖已有内容的目录', async () => {
  const root = tempDir()
  writeFileSync(join(root, 'keep.txt'), 'do not overwrite')

  const fake = fakeIO()
  const code = await commandNew(parseArgs(['new', 'demo', '--project', root]), fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('非空')))
})

test('new 缺少名字时报用法错误', async () => {
  await assert.rejects(() => commandNew(parseArgs(['new']), fakeIO().io), UsageError)
})

// ---------------------------------------------------------------- add / remove

test('add 与 remove 在项目根更新依赖与启用列表', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  // 包管理器由测试模拟：add 写包、写依赖；remove 删包、删依赖。
  const calls: string[][] = []
  const commands: string[] = []
  const fake = fakeIO({
    async packageManager(command, args, cwd) {
      assert.equal(cwd, root, '包管理器必须在项目根执行')
      commands.push(command)
      calls.push(args)
      const name = args[1]!
      if (args[0] === 'add') {
        writeInstalledPlugin(root, name, 'theme-id', '2.1.3')
        writeDependency(root, name, '^2.1.3')
      } else {
        rmSync(join(root, 'node_modules', name), { recursive: true, force: true })
        const pkg = readJson(join(root, 'package.json'))
        delete pkg.dependencies[name]
        writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
      }
    },
  })

  assert.equal(await commandAdd(parseArgs(['add', 'theme-picker', '--project', root]), fake.io), 0)
  assert.deepEqual(calls[0], ['add', 'theme-picker'])
  assert.deepEqual(commands, ['npm'], '没有任何信号时回退 npm')

  const appAfterAdd = readJson(join(root, 'app.json'))
  assert.deepEqual(appAfterAdd.plugins, ['theme-id'], 'app.json 记 plugin.json 的 id，而不是包名')
  assert.equal(readJson(join(root, 'package.json')).dependencies['theme-picker'], '^2.1.3')

  assert.equal(await commandRemove(parseArgs(['remove', 'theme-picker', '--project', root]), fake.io), 0)
  assert.deepEqual(readJson(join(root, 'app.json')).plugins, [])
  assert.equal(readJson(join(root, 'package.json')).dependencies['theme-picker'], undefined)
})

test('add 按项目 lockfile 选择 pnpm，而不是固定 npm', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: initial\n')

  const commands: string[] = []
  const fake = fakeIO({
    async packageManager(command, args) {
      commands.push(command)
      if (args[0] === 'add') {
        writeInstalledPlugin(root, args[1]!, 'theme-id', '2.1.3')
        writeDependency(root, args[1]!, '^2.1.3')
      }
    },
  })

  assert.equal(await commandAdd(parseArgs(['add', 'theme-picker', '--project', root]), fake.io), 0)
  assert.deepEqual(commands, ['pnpm'])
  assert.equal(existsSync(join(root, 'package-lock.json')), false, 'CLI 也不能写出第二种 lockfile')
})

test('add 安装成功后清除已卸载状态', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  // 先留下一次卸载记录：安装同一个插件后，两处状态都应被清除。
  const app = readJson(join(root, 'app.json'))
  app.uninstalledPlugins = ['theme-id']
  writeFileSync(join(root, 'app.json'), JSON.stringify(app, null, 2) + '\n')
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(
    join(root, 'data', 'plugins-state.json'),
    JSON.stringify({
      version: 1,
      installed: {},
      uninstalled: {
        'theme-id': {
          id: 'theme-id',
          displayName: '主题',
          rootKind: 'dependency',
          packageName: 'theme-picker',
          version: '2.1.3',
          spec: 'theme-picker@2.1.3',
          uninstalledAt: '2026-11-01T00:00:00.000Z',
        },
      },
    }),
  )

  const fake = fakeIO({
    async packageManager(_command, args) {
      writeInstalledPlugin(root, args[1]!, 'theme-id', '2.1.3')
      writeDependency(root, args[1]!, '^2.1.3')
    },
  })

  assert.equal(await commandAdd(parseArgs(['add', 'theme-picker', '--project', root]), fake.io), 0)
  assert.deepEqual(readJson(join(root, 'app.json')).uninstalledPlugins, [])
  const state = readJson(join(root, 'data', 'plugins-state.json'))
  assert.equal(state.uninstalled['theme-id'], undefined)
  assert.equal(state.installed['theme-id'].spec, 'theme-picker')
})

// ---------------------------------------------------------------- list

test('list 以项目 package.json 依赖为事实源', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  writeDependency(root, 'hello-package')
  writeInstalledPlugin(root, 'hello-package', 'hello-id', '2.0.0')

  const fake = fakeIO()
  const code = await commandList(parseArgs(['list', '--project', root, '--json']), fake.io)
  assert.equal(code, 0)

  const parsed = JSON.parse(fake.out.join('\n'))
  assert.equal(parsed.name, 'demo')
  assert.equal(parsed.plugins.length, 1)
  assert.deepEqual(parsed.plugins[0], {
    name: 'hello-package',
    id: 'hello-id',
    displayName: 'hello-id',
    version: '2.0.0',
    rootKind: 'dependency',
    origin: 'external',
    enabled: true,
    status: 'enabled',
  })
})

test('list 在未安装的依赖上说实话，不伪造版本', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  writeDependency(root, 'declared-only')

  const fake = fakeIO()
  await commandList(parseArgs(['list', '--project', root, '--json']), fake.io)
  const parsed = JSON.parse(fake.out.join('\n'))
  assert.equal(parsed.plugins[0].version, '（未安装）')
  assert.equal(parsed.plugins[0].enabled, false)
  assert.equal(parsed.plugins[0].id, null)
})

test('list 在没有任何依赖时给出明确提示', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  const fake = fakeIO()
  const code = await commandList(parseArgs(['list', '--project', root]), fake.io)
  assert.equal(code, 0)
  assert.ok(fake.out.some((line) => line.includes('尚未安装任何插件')))
})

test('list 在缺少 app.json 时返回非零', async () => {
  const fake = fakeIO()
  const code = await commandList(parseArgs(['list', '--project', tempDir()]), fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('找不到应用定义')))
})

test('list 合并扫描结果、随包插件与已卸载状态，显示来源', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  const resources = join(tempDir(), 'resources')
  writePluginDir(join(resources, 'plugins', 'builtin-pkg'), 'builtin-pkg', 'builtin-id')
  writePluginDir(join(root, 'plugins', 'local-pkg'), 'local-pkg', 'local-id')
  writePluginDir(join(root, 'node_modules', 'dep-pkg'), 'dep-pkg', 'dep-id')
  writeDependency(root, 'dep-pkg')

  // 本地插件卸载只写状态，文件仍在；list 应同时看到已启用与已卸载。
  const remove = fakeIO({ resourcesDir: resources })
  assert.equal(
    await commandRemove(parseArgs(['remove', 'local-id', '--project', root]), remove.io),
    0,
  )

  const fake = fakeIO({ resourcesDir: resources })
  assert.equal(await commandList(parseArgs(['list', '--project', root, '--json']), fake.io), 0)
  const parsed = JSON.parse(fake.out.join('\n'))
  const byId = Object.fromEntries(parsed.plugins.map((row: any) => [row.id, row]))
  assert.equal(byId['builtin-id'].origin, 'builtin')
  assert.equal(byId['builtin-id'].status, 'enabled')
  assert.equal(byId['local-id'].origin, 'local')
  assert.equal(byId['local-id'].status, 'uninstalled')
  assert.equal(byId['local-id'].enabled, false)
  assert.equal(byId['dep-id'].origin, 'external')
  assert.equal(byId['dep-id'].status, 'enabled')

  const text = fakeIO({ resourcesDir: resources })
  assert.equal(await commandList(parseArgs(['list', '--project', root]), text.io), 0)
  const output = text.out.join('\n')
  assert.match(output, /随包/)
  assert.match(output, /项目本地/)
  assert.match(output, /外部/)
  assert.match(output, /已卸载/)
  assert.match(output, /已启用/)
})

test('list 与 remove 纳入项目模式配置的用户插件根', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  const userPlugins = join(tempDir(), 'user-plugins')
  writePluginDir(join(userPlugins, 'user-pkg'), 'user-pkg', 'user-id')

  const list = fakeIO({ userPluginsDir: userPlugins })
  assert.equal(await commandList(parseArgs(['list', '--project', root, '--json']), list.io), 0)
  const row = JSON.parse(list.out.join('\n')).plugins.find((entry: any) => entry.id === 'user-id')
  assert.equal(row.rootKind, 'user')
  assert.equal(row.origin, 'external')
  assert.equal(row.status, 'enabled')

  // 项目模式的 user 插件与随包/本地插件一样只写状态，不跑包管理器。
  const calls: string[][] = []
  const remove = fakeIO({
    userPluginsDir: userPlugins,
    async packageManager(_command, args) {
      calls.push(args)
    },
  })
  assert.equal(await commandRemove(parseArgs(['remove', 'user-id', '--project', root]), remove.io), 0)
  assert.deepEqual(calls, [])
  assert.equal(existsSync(join(userPlugins, 'user-pkg', 'plugin.json')), true)
  assert.equal(readJson(join(root, 'app.json')).uninstalledPlugins.includes('user-id'), true)
})

test('list 展示已卸载但物理不存在的插件及其重装信息', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  const app = readJson(join(root, 'app.json'))
  app.uninstalledPlugins = ['gone-id']
  writeFileSync(join(root, 'app.json'), JSON.stringify(app, null, 2) + '\n')
  mkdirSync(join(root, 'data'), { recursive: true })
  writeFileSync(
    join(root, 'data', 'plugins-state.json'),
    JSON.stringify({
      version: 1,
      installed: {},
      uninstalled: {
        'gone-id': {
          id: 'gone-id',
          displayName: '已卸载的插件',
          rootKind: 'dependency',
          packageName: 'gone-pkg',
          version: '3.0.0',
          spec: 'gone-pkg@3.0.0',
          uninstalledAt: '2026-11-01T00:00:00.000Z',
        },
      },
    }),
  )

  const fake = fakeIO()
  assert.equal(await commandList(parseArgs(['list', '--project', root, '--json']), fake.io), 0)
  const parsed = JSON.parse(fake.out.join('\n'))
  const row = parsed.plugins.find((entry: any) => entry.id === 'gone-id')
  assert.equal(row.status, 'uninstalled')
  assert.equal(row.origin, 'external')
  assert.equal(row.name, 'gone-pkg')
  assert.equal(row.reinstallable, true)
})

// ---------------------------------------------------------------- remove

test('remove 按 rootKind 分流：随包与本地只写状态，依赖走检测到的包管理器', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: initial\n')
  const resources = join(tempDir(), 'resources')
  writePluginDir(join(resources, 'plugins', 'builtin-pkg'), 'builtin-pkg', 'builtin-id')
  writePluginDir(join(root, 'plugins', 'local-pkg'), 'local-pkg', 'local-id')
  writePluginDir(join(root, 'node_modules', 'dep-pkg'), 'dep-pkg', 'dep-id')
  writeDependency(root, 'dep-pkg')

  const calls: Array<{ command: string; args: string[] }> = []
  const fake = fakeIO({
    resourcesDir: resources,
    async packageManager(command, args) {
      calls.push({ command, args })
      rmSync(join(root, 'node_modules', 'dep-pkg'), { recursive: true, force: true })
      const pkg = readJson(join(root, 'package.json'))
      delete pkg.dependencies['dep-pkg']
      writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    },
  })

  assert.equal(
    await commandRemove(parseArgs(['remove', 'builtin-id', '--project', root]), fake.io),
    0,
  )
  assert.equal(existsSync(join(resources, 'plugins', 'builtin-pkg', 'plugin.json')), true)
  assert.equal(calls.length, 0, '随包插件卸载不得跑包管理器')

  assert.equal(
    await commandRemove(parseArgs(['remove', 'local-id', '--project', root]), fake.io),
    0,
  )
  assert.equal(existsSync(join(root, 'plugins', 'local-pkg', 'plugin.json')), true)
  assert.equal(calls.length, 0, '项目本地插件卸载不得跑包管理器')

  assert.equal(
    await commandRemove(parseArgs(['remove', 'dep-pkg', '--project', root]), fake.io),
    0,
  )
  assert.deepEqual(calls, [{ command: 'pnpm', args: ['remove', 'dep-pkg'] }])
  assert.equal(existsSync(join(root, 'node_modules', 'dep-pkg')), false)

  const app = readJson(join(root, 'app.json'))
  assert.deepEqual(
    new Set(app.uninstalledPlugins),
    new Set(['builtin-id', 'local-id', 'dep-id']),
  )
  const state = readJson(join(root, 'data', 'plugins-state.json'))
  assert.equal(state.uninstalled['dep-id'].rootKind, 'dependency')
  assert.equal(state.uninstalled['dep-id'].spec, 'dep-pkg@1.2.3')
  assert.equal(state.uninstalled['builtin-id'].rootKind, 'builtin')
  assert.equal(state.uninstalled['builtin-id'].spec, undefined)

  // 幂等：再次卸载不报错，也不会再跑一次包管理器。
  assert.equal(
    await commandRemove(parseArgs(['remove', 'dep-id', '--project', root]), fake.io),
    0,
  )
  assert.equal(calls.length, 1)
})

test('enable 恢复随包与本地插件，只清状态不跑包管理器', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  const resources = join(tempDir(), 'resources')
  writePluginDir(join(resources, 'plugins', 'builtin-pkg'), 'builtin-pkg', 'builtin-id')
  writePluginDir(join(root, 'plugins', 'local-pkg'), 'local-pkg', 'local-id')

  let packageManagerCalls = 0
  const fake = fakeIO({
    resourcesDir: resources,
    async packageManager() {
      packageManagerCalls++
    },
  })

  assert.equal(
    await commandRemove(parseArgs(['remove', 'local-id', '--project', root]), fake.io),
    0,
  )
  assert.equal(
    await commandRemove(parseArgs(['remove', 'builtin-id', '--project', root]), fake.io),
    0,
  )

  assert.equal(await commandEnable(parseArgs(['enable', 'local-id', '--project', root]), fake.io), 0)
  assert.equal(
    await commandEnable(parseArgs(['enable', 'builtin-id', '--project', root]), fake.io),
    0,
  )
  assert.equal(packageManagerCalls, 0, '恢复随包/本地插件不得跑包管理器')

  const app = readJson(join(root, 'app.json'))
  assert.deepEqual(app.plugins, ['local-id', 'builtin-id'], '启用的插件追加到启用顺序末尾')
  assert.deepEqual(app.uninstalledPlugins, [])
  assert.equal(existsSync(join(root, 'plugins', 'local-pkg', 'plugin.json')), true)

  // 幂等：已启用插件再次启用不报错，也不重复追加。
  assert.equal(await commandEnable(parseArgs(['enable', 'local-id', '--project', root]), fake.io), 0)
  assert.deepEqual(readJson(join(root, 'app.json')).plugins, ['local-id', 'builtin-id'])
})

test('enable 按卸载记录重装外部插件', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: initial\n')
  writePluginDir(join(root, 'node_modules', 'dep-pkg'), 'dep-pkg', 'dep-id')
  writeDependency(root, 'dep-pkg')

  const calls: Array<{ command: string; args: string[] }> = []
  const fake = fakeIO({
    async packageManager(command, args) {
      calls.push({ command, args })
      if (args[0] === 'remove') {
        rmSync(join(root, 'node_modules', 'dep-pkg'), { recursive: true, force: true })
        const pkg = readJson(join(root, 'package.json'))
        delete pkg.dependencies['dep-pkg']
        writeFileSync(join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
      } else {
        writePluginDir(join(root, 'node_modules', 'dep-pkg'), 'dep-pkg', 'dep-id')
        writeDependency(root, 'dep-pkg')
      }
    },
  })

  assert.equal(
    await commandRemove(parseArgs(['remove', 'dep-id', '--project', root]), fake.io),
    0,
  )
  assert.deepEqual(calls, [{ command: 'pnpm', args: ['remove', 'dep-pkg'] }])

  assert.equal(await commandEnable(parseArgs(['enable', 'dep-id', '--project', root]), fake.io), 0)
  assert.deepEqual(calls[1], {
    command: 'pnpm',
    args: ['add', 'dep-pkg@1.2.3'],
  }, '重装必须使用卸载记录里的 spec')

  const app = readJson(join(root, 'app.json'))
  assert.deepEqual(app.uninstalledPlugins, [])
  assert.deepEqual(app.plugins, ['dep-id'])
  const state = readJson(join(root, 'data', 'plugins-state.json'))
  assert.equal(state.uninstalled['dep-id'], undefined)
  assert.equal(state.installed['dep-id'].spec, 'dep-pkg@1.2.3')
  assert.equal(existsSync(join(root, 'node_modules', 'dep-pkg', 'plugin.json')), true)
})

test('enable 缺少重装 spec 时报错并以非零退出码结束', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  const app = readJson(join(root, 'app.json'))
  app.uninstalledPlugins = ['ghost']
  writeFileSync(join(root, 'app.json'), JSON.stringify(app, null, 2) + '\n')

  const fake = fakeIO()
  const code = await commandEnable(parseArgs(['enable', 'ghost', '--project', root]), fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('无法一键装回')))
})

// ---------------------------------------------------------------- remove

test('remove 在没有应用定义时拒绝执行', async () => {
  const fake = fakeIO()
  const code = await commandRemove(parseArgs(['remove', 'foo', '--project', tempDir()]), fake.io)
  assert.equal(code, 1)
})

// ---------------------------------------------------------------- main 分发

test('main 对用法错误返回 2，主流程错误返回 1', async () => {
  const bad = fakeIO()
  assert.equal(await main(['publish'], bad.io), 2)

  const missing = fakeIO()
  assert.equal(await main(['list', '--project', tempDir()], missing.io), 1)

  const help = fakeIO()
  assert.equal(await main(['--help'], help.io), 0)
  assert.ok(help.out.join('\n').includes('cordis-app new'))
})

test('--version 与 new 使用的框架版本来自唯一真源', async () => {
  assert.equal(defaultIO.frameworkVersion, FRAMEWORK_VERSION)

  const fake = fakeIO()
  assert.equal(await main(['--version'], fake.io), 0)
  assert.equal(fake.out[0], FRAMEWORK_VERSION)
})

test('run 在缺少应用定义时不会去 fork worker', async () => {
  const fake = fakeIO()
  const code = await main(['run', '--project', tempDir()], fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('找不到应用定义')))
})

// ---------------------------------------------------------------- dev / build / start

import type {
  BuildResult,
  ProjectDevServer,
  ProjectDevServerOptions,
  ProjectWatcher,
  ProjectWatcherOptions,
} from '@cordis-app/ui/build'
import type { AppExitEvent, AppHandle, StartAppOptions } from '@cordis-app/runtime'
import { commandBuild, commandDev, commandStart } from '../lib/index.js'
import { ShellPortUnavailableError, shellArguments } from '../lib/index.js'
import type { ShellDevBackend, ShellDevOptions } from '../lib/index.js'

/** 一个可观察的假 AppHandle：只实现命令真正会用的成员。 */
class FakeApp implements AppHandle {
  readonly url = 'http://127.0.0.1:5000/#token=t'
  readonly token = 't'
  readonly port = 5000
  stopped = 0
  restarted = 0
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()

  on(event: keyof import('@cordis-app/runtime').AppEvents, listener: (payload: any) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return () => set.delete(listener)
  }

  emit(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(payload)
  }

  async stop(): Promise<void> {
    this.stopped++
  }

  async restart(): Promise<void> {}

  async restartWorker(): Promise<void> {
    this.restarted++
  }
}

function writeBuiltProject(root: string): void {
  mkdirSync(join(root, 'dist', 'resources', 'ui'), { recursive: true })
  mkdirSync(join(root, 'dist', 'server'), { recursive: true })
  writeFileSync(join(root, 'dist', 'app.json'), JSON.stringify({ name: 'demo', version: '0.1.0' }))
  writeFileSync(join(root, 'dist', 'resources', 'ui', 'index.html'), '<!doctype html>')
  writeFileSync(join(root, 'dist', 'server', 'index.js'), 'export default function apply() {}\n')
}

test('dev/build/start 都是合法子命令', () => {
  assert.equal(parseArgs(['dev']).command, 'dev')
  assert.equal(parseArgs(['build']).command, 'build')
  assert.equal(parseArgs(['start']).command, 'start')
})

test('build 调用构建器并打印产物位置', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  const result: BuildResult = {
    projectRoot: root,
    outDir: join(root, 'dist'),
    resourcesDir: join(root, 'dist', 'resources'),
    serverEntry: join(root, 'dist', 'server', 'index.js'),
    appJson: join(root, 'dist', 'app.json'),
    packageJson: join(root, 'dist', 'package.json'),
    plugins: [],
  }
  const calls: string[] = []
  const fake = fakeIO({
    projectBuilder: async (options) => {
      calls.push(options.projectRoot)
      return result
    },
  })

  const code = await commandBuild(parseArgs(['build', '--project', root]), fake.io)
  assert.equal(code, 0)
  assert.deepEqual(calls, [root])
  assert.ok(fake.out.some((line) => line.includes(result.outDir)))
  assert.ok(fake.out.some((line) => line.includes('构建完成')))
})

test('start 在产物缺失时失败并提示先 build', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  const fake = fakeIO({
    appStarter: async () => {
      throw new Error('不应启动')
    },
  })
  const code = await commandStart(parseArgs(['start', '--project', root]), fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('cordis-app build')))
})

test('start 用 dist 的 resources 与 server 入口启动，而不是源码入口', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  writeBuiltProject(root)

  let options: StartAppOptions | undefined
  const app = new FakeApp()
  const fake = fakeIO({
    appStarter: async (value) => {
      options = value
      setTimeout(() => app.emit('exit', { code: 0, signal: null, expected: true }), 0)
      return app
    },
  })

  const code = await commandStart(parseArgs(['start', '--project', root]), fake.io)
  assert.equal(code, 0)
  assert.equal(options?.projectRoot, root)
  assert.equal(options?.resourcesDir, join(root, 'dist', 'resources'))
  assert.equal(options?.serverEntry, join(root, 'dist', 'server', 'index.js'))
  assert.equal(
    options?.appJson,
    join(root, 'dist', 'app.json'),
    'worker 必须读构建产物里的清单，而不是源码根',
  )
  assert.equal(options?.mode, 'packaged', 'start 运行的是构建产物，安装来源应为签名插件包')
  assert.equal(
    options?.userPluginsDir,
    join(root, 'data', 'plugins'),
    '用户插件根是 <userData>/plugins，userData 仍是项目可写数据目录',
  )
  assert.ok(fake.out.includes(app.url))
})

test('start 只依赖 dist 产物：源码根 app.json 缺失也能启动', async () => {
  // start 是「运行构建产物」：清单、前端与服务端入口都来自 dist。
  // 源码根没有 app.json 时不能因此拒绝启动。
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)
  writeBuiltProject(root)
  rmSync(join(root, 'app.json'))

  let options: StartAppOptions | undefined
  const app = new FakeApp()
  const fake = fakeIO({
    appStarter: async (value) => {
      options = value
      setTimeout(() => app.emit('exit', { code: 0, signal: null, expected: true }), 0)
      return app
    },
  })

  const code = await commandStart(parseArgs(['start', '--project', root]), fake.io)
  assert.equal(code, 0, '源码根缺 app.json 不应阻止 start')
  assert.equal(options?.appJson, join(root, 'dist', 'app.json'))
})

test('dev 先构建 worker 产物，再起 Vite，并在 server 变化时重启 worker', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  const app = new FakeApp()
  let watcherOptions: ProjectWatcherOptions | undefined
  let appOptions: StartAppOptions | undefined
  let devOptions: ProjectDevServerOptions | undefined
  let reloads = 0

  const watcher: ProjectWatcher = {
    devRoot: join(root, '.cordis', 'dev'),
    serverEntry: join(root, '.cordis', 'dev', 'server', 'index.js'),
    localPluginsDir: join(root, '.cordis', 'dev', 'plugins'),
    async close() {},
  }
  const dev: ProjectDevServer = {
    url: 'http://127.0.0.1:5173/#token=t',
    port: 5173,
    server: {} as ProjectDevServer['server'],
    reload() {
      reloads++
    },
    async close() {},
  }

  const fake = fakeIO({
    projectWatcher: async (options) => {
      watcherOptions = options
      return watcher
    },
    appStarter: async (options) => {
      appOptions = options
      setTimeout(() => {
        void (async () => {
          await watcherOptions?.onChange?.({ kind: 'server' })
          app.emit('exit', { code: 0, signal: null, expected: true } satisfies AppExitEvent)
        })()
      }, 0)
      return app
    },
    devServerStarter: async (options) => {
      devOptions = options
      return dev
    },
  })

  const code = await commandDev(parseArgs(['dev', '--project', root]), fake.io)

  assert.equal(code, 0)
  assert.equal(watcherOptions?.projectRoot, root)
  assert.equal(appOptions?.dev, true)
  assert.equal(appOptions?.serverEntry, watcher.serverEntry)
  assert.equal(appOptions?.localPluginsDir, watcher.localPluginsDir)
  assert.deepEqual(devOptions?.worker, { port: app.port, token: app.token })
  assert.equal(app.restarted, 1, 'server 变化应重启 worker')
  assert.equal(reloads, 0, 'server 变化不需要刷新页面')
  assert.ok(fake.out.includes(dev.url))
  assert.equal(app.stopped, 1)
})

test('dev 的插件前端变化在重启后触发整页刷新', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  const app = new FakeApp()
  let watcherOptions: ProjectWatcherOptions | undefined
  let reloads = 0

  const fake = fakeIO({
    projectWatcher: async (options) => {
      watcherOptions = options
      return {
        devRoot: join(root, '.cordis', 'dev'),
        serverEntry: join(root, '.cordis', 'dev', 'server', 'index.js'),
        localPluginsDir: join(root, '.cordis', 'dev', 'plugins'),
        async close() {},
      }
    },
    appStarter: async () => {
      setTimeout(() => {
        void (async () => {
          await watcherOptions?.onChange?.({ kind: 'plugin' })
          app.emit('exit', { code: 0, signal: null, expected: true } satisfies AppExitEvent)
        })()
      }, 0)
      return app
    },
    devServerStarter: async () =>
      ({
        url: 'http://127.0.0.1:5173/#token=t',
        port: 5173,
        server: {} as ProjectDevServer['server'],
        reload() {
          reloads++
        },
        async close() {},
      }) satisfies ProjectDevServer,
  })

  const code = await commandDev(parseArgs(['dev', '--project', root]), fake.io)
  assert.equal(code, 0)
  assert.equal(app.restarted, 1)
  assert.equal(reloads, 1)
})

test('dev --shell 用固定端口起 Vite，并把开发 UI 与 watcher 产物交给外壳', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  let devOptions: ProjectDevServerOptions | undefined
  let shellOptions: ShellDevOptions | undefined
  let watcherOptions: ProjectWatcherOptions | undefined
  let exitListener: ((code: number | null) => void) | undefined
  let devClosed = 0
  let watcherClosed = 0
  let shellStopped = 0
  let restarts = 0
  let reloads = 0
  let browserOpened = 0

  const watcher: ProjectWatcher = {
    devRoot: join(root, '.cordis', 'dev'),
    serverEntry: join(root, '.cordis', 'dev', 'server', 'index.js'),
    localPluginsDir: join(root, '.cordis', 'dev', 'plugins'),
    async close() {
      watcherClosed++
    },
  }
  const dev: ProjectDevServer = {
    url: 'http://127.0.0.1:5173/',
    port: 5173,
    server: {} as ProjectDevServer['server'],
    reload() {
      reloads++
    },
    async close() {
      devClosed++
    },
  }
  const backend: ShellDevBackend = {
    async restartWorker() {
      restarts++
    },
    onExit(listener) {
      exitListener = listener
      return () => {}
    },
    async stop() {
      shellStopped++
    },
  }

  const fake = fakeIO({
    shellLocator: () => ({ path: '/opt/cordis-app' }),
    findFreePort: async () => 51234,
    projectWatcher: async (options) => {
      watcherOptions = options
      return watcher
    },
    devServerStarter: async (options) => {
      devOptions = options
      return dev
    },
    shellDevStarter: async (options) => {
      shellOptions = options
      setTimeout(() => {
        void (async () => {
          await watcherOptions?.onChange?.({ kind: 'server' })
          exitListener?.(0)
        })()
      }, 0)
      return backend
    },
    openBrowser: () => {
      browserOpened++
    },
  })

  const code = await commandDev(parseArgs(['dev', '--shell', '--project', root]), fake.io)

  assert.equal(code, 0)
  assert.equal(devOptions?.worker.port, 51234)
  assert.equal(
    (devOptions?.worker as { token?: string }).token,
    undefined,
    '外壳模式不需要 Vite 知道 token：入口地址由外壳用握手 token 拼出来',
  )
  assert.equal(shellOptions?.shellPath, '/opt/cordis-app')
  assert.equal(shellOptions?.projectRoot, root)
  assert.equal(shellOptions?.workerPort, 51234)
  assert.equal(shellOptions?.devUrl, dev.url)
  assert.equal(shellOptions?.serverEntry, watcher.serverEntry)
  assert.equal(shellOptions?.localPluginsDir, watcher.localPluginsDir)
  assert.equal(restarts, 1, 'server 变化应重启 worker')
  assert.equal(reloads, 0, 'server 变化不需要刷新页面')
  assert.equal(browserOpened, 0, '外壳模式不打开浏览器')
  assert.ok(fake.out.includes('外壳已启动'))
  assert.ok(
    !fake.out.some((line) => line.includes('127.0.0.1:5173')),
    '外壳模式不打印开发地址',
  )
  assert.equal(devClosed, 1)
  assert.equal(watcherClosed, 1)
  assert.equal(shellStopped, 1)
})

test('dev --shell 的插件变化在重启后触发整页刷新', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  let devOptions: ProjectDevServerOptions | undefined
  let watcherOptions: ProjectWatcherOptions | undefined
  let exitListener: ((code: number | null) => void) | undefined
  let reloads = 0
  let restarts = 0

  const dev: ProjectDevServer = {
    url: 'http://127.0.0.1:5173/',
    port: 5173,
    server: {} as ProjectDevServer['server'],
    reload() {
      reloads++
    },
    async close() {},
  }
  const backend: ShellDevBackend = {
    async restartWorker() {
      restarts++
    },
    onExit(listener) {
      exitListener = listener
      return () => {}
    },
    async stop() {},
  }
  const fake = fakeIO({
    shellLocator: () => ({ path: '/opt/cordis-app' }),
    findFreePort: async () => 51234,
    projectWatcher: async (options) => {
      watcherOptions = options
      return {
        devRoot: join(root, '.cordis', 'dev'),
        serverEntry: join(root, '.cordis', 'dev', 'server', 'index.js'),
        localPluginsDir: join(root, '.cordis', 'dev', 'plugins'),
        async close() {},
      }
    },
    devServerStarter: async (options) => {
      devOptions = options
      return dev
    },
    shellDevStarter: async () => {
      setTimeout(() => {
        void (async () => {
          await watcherOptions?.onChange?.({ kind: 'plugin' })
          exitListener?.(0)
        })()
      }, 0)
      return backend
    },
  })

  const code = await commandDev(parseArgs(['dev', '--shell', '--project', root]), fake.io)

  assert.equal(code, 0)
  assert.equal(devOptions?.worker.port, 51234)
  assert.equal(restarts, 1, '插件变化也要重启 worker')
  assert.equal(reloads, 1, '插件前端入口换了 URL，需要整页刷新')
})

test('dev --shell 在端口被抢占时换端口重启 Vite 与外壳', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  const ports = [51234, 51235]
  const shellPorts: number[] = []
  let devStarts = 0
  let devClosed = 0
  let attempts = 0
  let closedBeforeRetry: number | undefined
  let exitListener: ((code: number | null) => void) | undefined

  const backend: ShellDevBackend = {
    async restartWorker() {},
    onExit(listener) {
      exitListener = listener
      return () => {}
    },
    async stop() {},
  }
  const fake = fakeIO({
    shellLocator: () => ({ path: '/opt/cordis-app' }),
    findFreePort: async () => ports.shift()!,
    projectWatcher: async () => ({
      devRoot: join(root, '.cordis', 'dev'),
      serverEntry: join(root, '.cordis', 'dev', 'server', 'index.js'),
      localPluginsDir: join(root, '.cordis', 'dev', 'plugins'),
      async close() {},
    }),
    devServerStarter: async () => {
      devStarts++
      return {
        url: 'http://127.0.0.1:5173/',
        port: 5173,
        server: {} as ProjectDevServer['server'],
        reload() {},
        async close() {
          devClosed++
        },
      }
    },
    shellDevStarter: async (options) => {
      attempts++
      if (attempts === 2) closedBeforeRetry = devClosed
      shellPorts.push(options.workerPort)
      if (attempts === 1) throw new ShellPortUnavailableError('端口被占用')
      setTimeout(() => exitListener?.(0), 0)
      return backend
    },
  })

  const code = await commandDev(parseArgs(['dev', '--shell', '--project', root]), fake.io)

  assert.equal(code, 0)
  assert.equal(attempts, 2, '端口冲突后应再试一次')
  assert.deepEqual(shellPorts, [51234, 51235])
  assert.equal(devStarts, 2, 'Vite 的代理目标换端口，必须跟着重启')
  assert.equal(closedBeforeRetry, 1, '第一轮 Vite 在重试前应关闭')
  assert.ok(fake.err.some((line) => line.includes('被占用')))
})

test('dev --shell 找不到外壳且不能自动编译时直接失败', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  let watcherStarted = false
  let built = 0
  const fake = fakeIO({
    shellLocator: () => ({
      error: 'CORDIS_APP_SHELL 指向的文件不存在：/opt/missing',
      canBuild: false,
    }),
    shellBuilder: async () => {
      built++
      return { ok: true }
    },
    projectWatcher: async () => {
      watcherStarted = true
      throw new Error('找不到外壳时不该启动 watcher')
    },
  })

  const code = await commandDev(parseArgs(['dev', '--shell', '--project', root]), fake.io)

  assert.equal(code, 1)
  assert.equal(built, 0, '显式覆盖错误时不该尝试自动编译')
  assert.equal(watcherStarted, false, '缺外壳时应在启动任何进程之前失败')
  assert.ok(fake.err.some((line) => line.includes('CORDIS_APP_SHELL')))
})

test('dev --shell 缺外壳时先编译一次再继续启动', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  let locateCalls = 0
  let built = 0
  let watcherStarted = false
  const fake = fakeIO({
    shellLocator: () => {
      locateCalls++
      return locateCalls === 1
        ? { error: '找不到桌面外壳：/repo/dist/cordis-app', canBuild: true }
        : { path: '/opt/cordis-app' }
    },
    shellBuilder: async () => {
      built++
      return { ok: true }
    },
    projectWatcher: async () => {
      watcherStarted = true
      // 断言到「编译后继续启动」即可，不需要真的起 Vite 与外壳
      throw new Error('stop after watcher')
    },
  })

  const code = await commandDev(parseArgs(['dev', '--shell', '--project', root]), fake.io)

  assert.equal(code, 1)
  assert.equal(built, 1)
  assert.equal(locateCalls, 2, '编译后应重新定位外壳')
  assert.equal(watcherStarted, true)
  assert.ok(fake.out.some((line) => line.includes('正在编译')))
})

test('dev --shell 自动编译失败时提示手动构建', async () => {
  const root = join(tempDir(), 'demo')
  await commandNew(parseArgs(['new', 'demo', '--project', root]), fakeIO().io)

  let watcherStarted = false
  const fake = fakeIO({
    shellLocator: () => ({ error: '找不到桌面外壳', canBuild: true }),
    shellBuilder: async () => ({ ok: false, error: 'go build 失败（exit 1）' }),
    projectWatcher: async () => {
      watcherStarted = true
      throw new Error('编译失败时不该启动 watcher')
    },
  })

  const code = await commandDev(parseArgs(['dev', '--shell', '--project', root]), fake.io)

  assert.equal(code, 1)
  assert.equal(watcherStarted, false)
  assert.ok(fake.err.some((line) => line.includes('go build 失败')))
  assert.ok(fake.err.some((line) => line.includes('pnpm build:shell')))
})

test('外壳参数把端口、开发 UI 与 watcher 产物原样传给外壳', () => {
  const args = shellArguments({
    shellPath: '/opt/cordis-app',
    projectRoot: '/project',
    resourcesDir: '/repo/packages/ui/dist',
    workerPort: 51234,
    devUrl: 'http://127.0.0.1:5173/',
    serverEntry: '/project/.cordis/dev/server/index.js',
    localPluginsDir: '/project/.cordis/dev/plugins',
    runtimeJsonPath: '/project/.cordis/runtime.json',
  })

  assert.deepEqual(args, [
    '--data',
    '/project',
    '--resources',
    '/repo/packages/ui/dist',
    '--worker-port',
    '51234',
    '--dev-ui',
    'http://127.0.0.1:5173/',
    '--server-entry',
    '/project/.cordis/dev/server/index.js',
    '--local-plugins',
    '/project/.cordis/dev/plugins',
    '--dev',
  ])
})
