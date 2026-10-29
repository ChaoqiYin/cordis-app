/**
 * 项目构建的对外契约：目录布局、body 替换、共享模块与幂等。
 *
 * 断言只绑定 `build` 文档承诺的文件，不绑定 Vite 的内部文件名。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHARED_MODULE_TABLE, WS_PATH } from '@cordis-app/protocol'
import { buildProject, createProjectDevServer, swapIntoPlace } from '../src/build/index.ts'

/** 取一个当前空闲的端口，避免测试与开发者本机的 5173 冲突。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'cordis-build-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'server'), { recursive: true })
  mkdirSync(join(root, 'plugins', 'demo'), { recursive: true })

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'demo-app', version: '0.1.0', private: true, type: 'module' }),
  )
  writeFileSync(
    join(root, 'app.json'),
    JSON.stringify({ name: 'demo-app', version: '0.1.0', plugins: ['demo'] }),
  )
  writeFileSync(
    join(root, 'src', 'body.tsx'),
    'export default function Body() { return null }\n',
  )
  writeFileSync(
    join(root, 'server', 'index.ts'),
    'const answer: number = 42\nexport default function apply() { return answer }\n',
  )
  writeFileSync(
    join(root, 'plugins', 'demo', 'plugin.json'),
    JSON.stringify({ id: 'demo', displayName: 'Demo', client: 'client.js', server: 'server.js' }),
  )
  writeFileSync(
    join(root, 'plugins', 'demo', 'package.json'),
    JSON.stringify({ name: 'demo-plugin', version: '0.0.1', peerDependencies: { 'cordis-app': '*' } }),
  )
  writeFileSync(join(root, 'plugins', 'demo', 'client.js'), 'export const marker = "demo"\n')
  writeFileSync(join(root, 'plugins', 'demo', 'server.js'), 'export default function apply() {}\n')
  return root
}

test('build 产出发布布局，body 与 server 都来自项目源码', async () => {
  const root = createProject()
  const result = await buildProject({ projectRoot: root })

  assert.equal(result.projectRoot, root)
  assert.ok(existsSync(join(result.outDir, 'app.json')))
  assert.ok(existsSync(join(result.outDir, 'package.json')))
  assert.ok(existsSync(join(result.resourcesDir, 'ui', 'index.html')))
  assert.ok(existsSync(result.serverEntry))

  // 共享模块清单只有协议一份；构建必须逐个落盘。
  for (const definition of Object.values(SHARED_MODULE_TABLE)) {
    assert.ok(
      existsSync(join(result.resourcesDir, 'shared', definition.file)),
      `缺少共享模块 ${definition.file}`,
    )
  }

  assert.ok(existsSync(join(result.resourcesDir, 'plugins', 'demo', 'plugin.json')))
  assert.ok(existsSync(join(result.resourcesDir, 'plugins', 'demo', 'client.js')))
  assert.ok(existsSync(join(result.resourcesDir, 'plugins', 'demo', 'server.js')))

  const server = readFileSync(result.serverEntry, 'utf8')
  assert.match(server, /apply/, '项目 server 入口应被打包成可 import 的 ESM')
  assert.doesNotMatch(server, /interface|: number/, 'TypeScript 类型应被剥离')
})

test('dev 代理的 WebSocket 路径与前端连接路径一致', async () => {
  // 通过公共入口 createProjectDevServer 观察代理配置；devProxyConfig 本身
  // 是实现细节，不再单独导出。
  const root = mkdtempSync(join(tmpdir(), 'cordis-dev-proxy-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'body.tsx'), 'export default function Body() { return null }\n')

  const dev = await createProjectDevServer({
    projectRoot: root,
    port: await freePort(),
    strictPort: true,
    worker: { port: 9000, token: 'test-token' },
  })
  try {
    const proxy = dev.server.config.server.proxy as Record<string, { ws?: boolean }>

    assert.deepEqual(
      Object.keys(proxy).sort(),
      ['/api', '/__health', '/__plugins', WS_PATH].sort(),
      'WebSocket 必须代理到 WS_PATH，而不是另一条字面量路径',
    )
    assert.equal(proxy[WS_PATH]?.ws, true, `${WS_PATH} 必须启用 ws 代理`)
    assert.equal(proxy['/api']?.ws, false)
    assert.equal(proxy['/ws'], undefined, '不保留 /ws 别名')
  } finally {
    await dev.close()
  }
})

test('产物切换失败时把旧目录移回原位，而不是丢掉新旧两份', () => {
  const calls: Array<[string, string]> = []
  let renames = 0
  let removed = false

  assert.throws(
    () =>
      swapIntoPlace('/project/dist.tmp', '/project/dist', {
        existsSync: () => true,
        renameSync(from, to) {
          calls.push([from, to])
          renames += 1
          // 第一次：旧产物 → 备份；第二次：staging → outDir 失败。
          if (renames === 2) throw new Error('rename 失败')
        },
        rmSync() {
          removed = true
        },
      }),
    /rename 失败/,
  )

  assert.equal(calls.length, 3, '旧目录移出、切换失败、旧目录移回')
  assert.equal(calls[0]![0], '/project/dist')
  assert.match(calls[0]![1], /^\/project\/dist\.old-/)
  assert.deepEqual(calls[2]!, [calls[0]![1], '/project/dist'], '失败后必须把备份移回原位')
  assert.equal(removed, false, '切换失败时不能删除旧产物')
})

test('重复 build 幂等，不残留上一次的文件', async () => {
  const root = createProject()
  const first = await buildProject({ projectRoot: root })
  const stale = join(first.resourcesDir, 'ui', 'stale.txt')
  writeFileSync(stale, 'stale')

  const second = await buildProject({ projectRoot: root })
  assert.equal(second.outDir, first.outDir)
  assert.equal(existsSync(stale), false)
  assert.ok(existsSync(join(second.resourcesDir, 'ui', 'index.html')))
})

test('缺少 body 时构建失败，且不留下可运行目录', async () => {
  const root = createProject()
  const { rmSync } = await import('node:fs')
  rmSync(join(root, 'src', 'body.tsx'))

  await assert.rejects(() => buildProject({ projectRoot: root }), /body/)
  assert.equal(existsSync(join(root, 'dist')), false)
})
