/**
 * 聚合包 `cordis-app` 的对外契约。
 *
 * 这个包本身不实现任何能力：它只把框架的公开面拼成一条稳定的 import 路径。
 * 因此这里检查的是「消费者能否解析到」以及「转出有没有走样」——
 * 子路径解析、client 的薄转出、server 的纯类型、preset 的转出、CLI 版本。
 *
 * 所有断言都从包自己的 package.json 与真实解析结果出发，不复制一份期望清单：
 * 一旦聚合包漏转出一个子路径，消费者在类型检查或运行时会立刻发现。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FRAMEWORK_VERSION, SHARED_MODULE_TABLE } from '@cordis-app/protocol'
// 类型层面必须可用：插件作者只依赖聚合包就能写服务端与前端入口。
import type { ClientContext } from 'cordis-app/client'
import type { KernelContext, RouteHandler } from 'cordis-app/server'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
  name: string
  version: string
  license: string
  bin: Record<string, string>
  files: string[]
  publishConfig?: { access?: string }
}

/** 让类型导入参与检查，同时不影响运行时。 */
type _ServerTypes = [KernelContext, RouteHandler]
type _ClientTypes = ClientContext

test('聚合包的子路径都能从消费者解析到真实文件', () => {
  assert.equal(packageJson.name, 'cordis-app')
  for (const subpath of ['', '/client', '/server', '/preset', '/ui', '/package.json']) {
    const resolved = fileURLToPath(import.meta.resolve(`cordis-app${subpath}`))
    assert.ok(existsSync(resolved), `cordis-app${subpath || ''} 应解析到存在的文件，实际为 ${resolved}`)
  }
})

test('cordis-app/client 是现有 client 入口的薄转出', async () => {
  const aggregate = await import('cordis-app/client')
  const source = await import('@cordis-app/ui')

  assert.deepEqual(
    Object.keys(aggregate).sort(),
    Object.keys(source).sort(),
    '聚合包不能增加或遗漏 client 的导出——否则插件与宿主会看到两份不同的公开面',
  )
  // 用插件作者实际会用的名字再确认一次，避免两边同时漏掉某个导出时互相抵消
  for (const name of ['ClientRuntime', 'Registry', 'RuntimeContext', 'usePluginData', 'useRuntime']) {
    assert.ok(name in aggregate, `cordis-app/client 应导出 ${name}`)
  }
})

test('共享模块表与 cordis-app/client 构建入口保持原状', () => {
  assert.equal(
    SHARED_MODULE_TABLE['cordis-app/client'].entry,
    'src/client/index.ts',
    '聚合包不能复制 client 实现；共享模块仍由 UI 包的客户端源码构建',
  )
})

test('cordis-app/ui 转出宿主组件，且不携带运行时重复实现', async () => {
  const aggregate = await import('cordis-app/ui')
  const source = await import('@cordis-app/ui/host')

  assert.deepEqual(
    Object.keys(aggregate).sort(),
    Object.keys(source).sort(),
    '聚合包不能增加或遗漏宿主导出',
  )
  for (const name of [
    'BodyHost',
    'DefaultBody',
    'PluginPageOutlet',
    'PluginSlot',
    'PluginMenuTrigger',
    'SettingsPanel',
    'usePath',
    'navigate',
  ]) {
    assert.ok(name in aggregate, `cordis-app/ui 应导出 ${name}`)
  }
})

test('cordis-app/server 只提供类型，不携带运行时值', async () => {
  const server = await import('cordis-app/server')
  assert.deepEqual(Object.keys(server), [], '服务端入口出现运行时值，会让插件产物留下无法解析的 import')
})

test('cordis-app/preset 转出服务端与前端构建预设', async () => {
  const aggregate = await import('cordis-app/preset')
  const source = await import('@cordis-app/preset')

  assert.equal(aggregate.clientPreset, source.clientPreset)
  assert.equal(aggregate.serverPreset, source.serverPreset)
  assert.equal(aggregate.isShared, source.isShared)
  assert.deepEqual(aggregate.SHARED_MODULES, source.SHARED_MODULES)
})

test('框架版本只有一个真源（打包后的 package.json）', () => {
  assert.equal(FRAMEWORK_VERSION, packageJson.version, '版本常量必须由 cordis-app/package.json 生成')
})

test('CLI bin 输出版本，与 package.json 一致', () => {
  const output = execFileSync(process.execPath, [join(packageRoot, 'bin', 'cordis-app.js'), '--version'], {
    encoding: 'utf8',
  }).trim()
  assert.equal(output, packageJson.version)
})

test('发布元数据齐全', () => {
  assert.equal(packageJson.license, 'AGPL-3.0-only')
  assert.equal(packageJson.bin['cordis-app'], './bin/cordis-app.js')
  assert.ok(packageJson.files.includes('lib'), '编译产物必须随包发布')
  assert.ok(packageJson.files.includes('bin'), 'CLI 入口必须随包发布')
  assert.equal(packageJson.publishConfig?.access, 'public')
})
