/**
 * CLI 的契约测试。
 *
 * 测试对象是「命令行为」而不是「进程行为」：所有命令都接受注入的 IO 与依赖，
 * 因此这里可以断言输出文本、退出码与磁盘结果，而不需要 spawn 一个真实进程。
 * 唯一需要真实进程的是 `run`——它由 runtime 的 supervisor 测试覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRAMEWORK_VERSION } from '@cordis-app/protocol'
import { parseArgs, UsageError, main } from '../lib/index.js'
import { commandList, commandNew, commandRemove, defaultIO, type CommandIO } from '../lib/index.js'

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
      frameworkVersion: '1.0.0',
      ...overrides,
    },
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cordis-cli-'))
}

// ---------------------------------------------------------------- 参数解析

test('子命令与位置参数分开解析', () => {
  const parsed = parseArgs(['add', 'theme-picker'])
  assert.equal(parsed.command, 'add')
  assert.deepEqual(parsed.positionals, ['theme-picker'])
})

test('--data 支持空格与等号两种写法', () => {
  assert.equal(parseArgs(['list', '--data', '/tmp/x']).dataDir, '/tmp/x')
  assert.equal(parseArgs(['list', '--data=/tmp/y']).dataDir, '/tmp/y')
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

test('new 生成可启动的实例目录', async () => {
  const dir = tempDir()
  const fake = fakeIO()
  const code = await commandNew(parseArgs(['new', 'demo', '--data', dir]), fake.io)
  assert.equal(code, 0)

  const appJson = JSON.parse(readFileSync(join(dir, 'instances', 'default', 'app.json'), 'utf8'))
  assert.equal(appJson.name, 'demo')
  assert.deepEqual(appJson.plugins, {}, '新应用不应预装任何插件')
  assert.equal(appJson.framework, '^1.0.0')

  // package.json 是派生物，但包管理器需要它才知道往哪里装
  const pkg = JSON.parse(readFileSync(join(dir, 'instances', 'default', 'package.json'), 'utf8'))
  assert.equal(pkg.private, true)

  // app.lock 也要在，否则第一次 add 会被当成「没有锁文件」重建整个依赖图
  const lock = JSON.parse(readFileSync(join(dir, 'instances', 'default', 'app.lock'), 'utf8'))
  assert.deepEqual(lock, { lockfileVersion: 1, plugins: {} })
})

test('new 不会覆盖已有应用', async () => {
  const dir = tempDir()
  await commandNew(parseArgs(['new', 'demo', '--data', dir]), fakeIO().io)

  const fake = fakeIO()
  const code = await commandNew(parseArgs(['new', 'demo', '--data', dir]), fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('已存在')))
})

test('new 缺少名字时报用法错误', async () => {
  await assert.rejects(() => commandNew(parseArgs(['new']), fakeIO().io), UsageError)
})

// ---------------------------------------------------------------- list

test('list 在没有任何插件时给出明确提示', async () => {
  const dir = tempDir()
  await commandNew(parseArgs(['new', 'demo', '--data', dir]), fakeIO().io)

  const fake = fakeIO()
  const code = await commandList(parseArgs(['list', '--data', dir]), fake.io)
  assert.equal(code, 0)
  assert.ok(fake.out.some((line) => line.includes('尚未安装任何插件')))
})

test('list 的 --json 输出可被解析', async () => {
  const dir = tempDir()
  await commandNew(parseArgs(['new', 'demo', '--data', dir]), fakeIO().io)
  writeApp(dir, { hello: '^1.0.0' })

  const fake = fakeIO()
  await commandList(parseArgs(['list', '--data', dir, '--json']), fake.io)
  const parsed = JSON.parse(fake.out.join('\n'))
  assert.equal(parsed.name, 'demo')
  assert.equal(parsed.plugins.length, 1)
  assert.equal(parsed.plugins[0].name, 'hello')
  // 没装时版本列必须说实话，不能凭空编一个
  assert.equal(parsed.plugins[0].version, '（未安装）')
})

test('list 从 plugin.json 读 id，与包名区分开', async () => {
  const dir = tempDir()
  await commandNew(parseArgs(['new', 'demo', '--data', dir]), fakeIO().io)
  writeApp(dir, { 'some-npm-name': '^1.0.0' })
  const pluginDir = join(dir, 'instances', 'default', 'node_modules', 'some-npm-name')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'the-real-id' }))
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({ name: 'some-npm-name', version: '1.2.3' }))
  writeFileSync(
    join(dir, 'instances', 'default', 'app.lock'),
    JSON.stringify({ lockfileVersion: 1, plugins: { 'some-npm-name': { version: '1.2.3', resolved: '' } } }),
  )

  const fake = fakeIO()
  await commandList(parseArgs(['list', '--data', dir, '--json']), fake.io)
  const parsed = JSON.parse(fake.out.join('\n'))
  assert.equal(parsed.plugins[0].id, 'the-real-id')
  assert.equal(parsed.plugins[0].version, '1.2.3')
})

test('list 在缺少 app.json 时返回非零', async () => {
  const fake = fakeIO()
  const code = await commandList(parseArgs(['list', '--data', tempDir()]), fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('找不到应用定义')))
})

// ---------------------------------------------------------------- remove

test('remove 在没有应用定义时拒绝执行', async () => {
  const fake = fakeIO()
  const code = await commandRemove(parseArgs(['remove', 'foo', '--data', tempDir()]), fake.io)
  assert.equal(code, 1)
})

// ---------------------------------------------------------------- main 分发

test('main 对用法错误返回 2，主流程错误返回 1', async () => {
  const bad = fakeIO()
  assert.equal(await main(['publish'], bad.io), 2)

  const missing = fakeIO()
  assert.equal(await main(['list', '--data', tempDir()], missing.io), 1)

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
  const code = await main(['run', '--data', tempDir()], fake.io)
  assert.equal(code, 1)
  assert.ok(fake.err.some((line) => line.includes('找不到应用定义')))
})

// ---------------------------------------------------------------- 辅助

function writeApp(dir: string, plugins: Record<string, string>): void {
  const path = join(dir, 'instances', 'default', 'app.json')
  const app = JSON.parse(readFileSync(path, 'utf8'))
  app.plugins = plugins
  writeFileSync(path, JSON.stringify(app, null, 2))
  assert.ok(existsSync(path))
}
