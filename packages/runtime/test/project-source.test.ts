/**
 * 项目声明的插件来源模块。
 *
 * 测试以「worker 是否真的加载了清单声明的模块」为外部行为，不检查安装器
 * 内部字段；模块只是普通项目文件，用标记文件观察加载时机。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker, type WorkerOptions } from '../lib/worker/worker.js'
import { findFreePort, generateToken } from '../lib/supervisor/supervisor.js'
import {
  loadProjectPluginSource,
  resolvePluginSourcePath,
  type PluginSourceContext,
} from '../lib/plugin/project-source.js'

interface Fixture {
  projectRoot: string
  resourcesDir: string
  userPluginsDir: string
  appJson: string
}

function createFixture(app: Record<string, unknown> = {}): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cordis-source-'))
  const resourcesDir = join(projectRoot, 'resources')
  mkdirSync(join(resourcesDir, 'ui'), { recursive: true })
  writeFileSync(join(resourcesDir, 'ui', 'index.html'), '<!doctype html><title>test</title>')
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'test', version: '1.0.0', private: true, type: 'module' }),
  )
  const appJson = join(projectRoot, 'app.json')
  writeFileSync(appJson, JSON.stringify({ name: 'test', version: '1.0.0', ...app }))
  mkdirSync(join(projectRoot, 'server'), { recursive: true })
  writeFileSync(join(projectRoot, 'server', 'index.js'), 'export default function apply() {}\n')
  return {
    projectRoot,
    resourcesDir,
    userPluginsDir: join(projectRoot, 'user-plugins'),
    appJson,
  }
}

function writeSource(projectRoot: string, body: string): void {
  writeFileSync(join(projectRoot, 'server', 'plugin-source.js'), body)
}

async function start(fixture: Fixture, options: Partial<WorkerOptions> = {}) {
  return startWorker({
    port: await findFreePort(),
    token: generateToken(),
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    userPluginsDir: fixture.userPluginsDir,
    ...options,
  })
}

test('resolvePluginSourcePath 只接受 app.json 目录内的相对路径', () => {
  const fixture = createFixture()
  const appJson = fixture.appJson

  assert.equal(
    resolvePluginSourcePath(appJson, 'server/plugin-source.js'),
    join(fixture.projectRoot, 'server', 'plugin-source.js'),
  )
  assert.throws(() => resolvePluginSourcePath(appJson, '/etc/passwd'), /必须是相对路径/)
  assert.throws(() => resolvePluginSourcePath(appJson, '../outside.js'), /目录之外/)
  assert.throws(() => resolvePluginSourcePath(appJson, ''), /不能是空字符串/)
})

test('loadProjectPluginSource 接受命名导出 readArchive 并校验返回值', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cordis-source-module-'))
  const good = join(root, 'good.js')
  writeFileSync(
    good,
    'export async function readArchive(spec) { return new TextEncoder().encode(spec) }\n',
  )

  const readArchive = await loadProjectPluginSource(good)
  const ctx: PluginSourceContext = {
    projectRoot: root,
    appJsonPath: join(root, 'app.json'),
    userDataDir: root,
    frameworkVersion: '1.0.0',
  }
  assert.equal(new TextDecoder().decode(await readArchive('demo', ctx)), 'demo')

  // 每个用例写不同文件：ESM 按 URL 缓存，同一路径的第二次 import 不会重读。
  const wrongExport = join(root, 'wrong-export.js')
  writeFileSync(wrongExport, 'export const notReadArchive = 1\n')
  await assert.rejects(loadProjectPluginSource(wrongExport), /必须导出 readArchive/)

  const wrongReturn = join(root, 'wrong-return.js')
  writeFileSync(wrongReturn, 'export async function readArchive() { return "text" }\n')
  const bad = await loadProjectPluginSource(wrongReturn)
  await assert.rejects(bad('demo', ctx), /必须返回 Uint8Array/)

  await assert.rejects(loadProjectPluginSource(join(root, 'missing.js')), /找不到插件来源模块/)
  rmSync(root, { recursive: true, force: true })
})

test('打包模式启动时加载 app.json 声明的来源模块', async () => {
  const fixture = createFixture({ pluginSource: 'server/plugin-source.js' })
  const marker = join(fixture.projectRoot, 'server', 'loaded.marker')
  writeSource(
    fixture.projectRoot,
    `import { writeFileSync } from 'node:fs'
writeFileSync(new URL('./loaded.marker', import.meta.url), 'yes')
export async function readArchive() { return new Uint8Array() }
`,
  )

  const handle = await start(fixture, { mode: 'packaged' })
  try {
    assert.ok(existsSync(marker), '打包模式应在启动时加载清单声明的来源模块')
  } finally {
    await handle.close()
    rmSync(fixture.projectRoot, { recursive: true, force: true })
  }
})

test('项目模式不加载来源模块', async () => {
  const fixture = createFixture({ pluginSource: 'server/plugin-source.js' })
  const marker = join(fixture.projectRoot, 'server', 'loaded.marker')
  writeSource(
    fixture.projectRoot,
    `import { writeFileSync } from 'node:fs'
writeFileSync(new URL('./loaded.marker', import.meta.url), 'yes')
export async function readArchive() { return new Uint8Array() }
`,
  )

  const handle = await start(fixture)
  try {
    assert.equal(existsSync(marker), false, '项目模式的安装来源是 npm，不应加载来源模块')
  } finally {
    await handle.close()
    rmSync(fixture.projectRoot, { recursive: true, force: true })
  }
})

test('显式注入的 readArchive 优先于清单声明的来源模块', async () => {
  const fixture = createFixture({ pluginSource: 'server/plugin-source.js' })
  const marker = join(fixture.projectRoot, 'server', 'loaded.marker')
  writeSource(
    fixture.projectRoot,
    `import { writeFileSync } from 'node:fs'
writeFileSync(new URL('./loaded.marker', import.meta.url), 'yes')
export async function readArchive() { return new Uint8Array() }
`,
  )

  const handle = await start(fixture, {
    mode: 'packaged',
    bundle: { readArchive: async () => new Uint8Array() },
  })
  try {
    assert.equal(existsSync(marker), false, '嵌入方显式注入时应跳过项目模块')
  } finally {
    await handle.close()
    rmSync(fixture.projectRoot, { recursive: true, force: true })
  }
})

test('清单声明了来源模块但产物缺失时拒绝启动', async () => {
  const fixture = createFixture({ pluginSource: 'server/plugin-source.js' })
  try {
    await assert.rejects(start(fixture, { mode: 'packaged' }), /找不到插件来源模块/)
  } finally {
    rmSync(fixture.projectRoot, { recursive: true, force: true })
  }
})
