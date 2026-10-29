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
import { commandAdd, commandList, commandNew, commandRemove, defaultIO, type CommandIO } from '../lib/index.js'

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

  // body 直接使用宿主的默认参考实现，同时保留项目自己的编辑点
  const body = readFileSync(join(root, 'src', 'body.tsx'), 'utf8')
  assert.match(body, /cordis-app\/ui/)
  assert.match(body, /DefaultBody/)
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
  const fake = fakeIO({
    async packageManager(_command, args, cwd) {
      assert.equal(cwd, root, '包管理器必须在项目根执行')
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

  const appAfterAdd = readJson(join(root, 'app.json'))
  assert.deepEqual(appAfterAdd.plugins, ['theme-id'], 'app.json 记 plugin.json 的 id，而不是包名')
  assert.equal(readJson(join(root, 'package.json')).dependencies['theme-picker'], '^2.1.3')

  assert.equal(await commandRemove(parseArgs(['remove', 'theme-picker', '--project', root]), fake.io), 0)
  assert.deepEqual(readJson(join(root, 'app.json')).plugins, [])
  assert.equal(readJson(join(root, 'package.json')).dependencies['theme-picker'], undefined)
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
    version: '2.0.0',
    id: 'hello-id',
    enabled: true,
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
