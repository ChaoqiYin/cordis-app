import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  validateDist,
  planStaging,
  scanBareImports,
  planBareImportScan,
  parseArgs,
  bundleRuntime,
} from './package-desktop.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const scriptPath = join(here, 'package-desktop.mjs')
// 冒烟测试用的 ws 由 runtime 包声明，工作区里只有它自己解析得到。
const runtimeNodeModules = resolve(here, '..', '..', 'runtime', 'node_modules')

function tempDir(t, prefix = 'cordis-package-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('validateDist 报出缺少的必要产物', (t) => {
  const root = tempDir(t)
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'dist', 'app.json'), '{}')

  const result = validateDist(join(root, 'dist'))

  assert.equal(result.ok, false)
  assert.deepEqual(result.missing.sort(), [
    'package.json',
    'resources/ui/index.html',
    'server/index.js',
  ])
})

test('validateDist 在必要产物齐全时通过', (t) => {
  const dist = join(tempDir(t), 'dist')
  for (const relative of [
    'app.json',
    'package.json',
    'server/index.js',
    'resources/ui/index.html',
  ]) {
    mkdirSync(join(dist, relative, '..'), { recursive: true })
    writeFileSync(join(dist, relative), 'x')
  }

  assert.deepEqual(validateDist(dist), { ok: true, missing: [] })
})

test('planStaging 清空 app 目录但保留仓库占位文件', () => {
  const plan = planStaging({
    distDir: '/project/dist',
    shellAppDir: '/repo/packages/shell/app',
  })

  assert.equal(plan.target, '/repo/packages/shell/app')
  assert.deepEqual(plan.preserve, ['.gitignore', '.gitkeep'])
  assert.deepEqual(
    plan.copies.map((copy) => [copy.from, copy.to]),
    [
      ['/project/dist/app.json', '/repo/packages/shell/app/app.json'],
      ['/project/dist/package.json', '/repo/packages/shell/app/package.json'],
      ['/project/dist/server', '/repo/packages/shell/app/server'],
      ['/project/dist/resources', '/repo/packages/shell/app/resources'],
    ],
  )
})

test('planStaging 把可选公钥复制成随包 PEM', () => {
  const plan = planStaging({
    distDir: '/project/dist',
    shellAppDir: '/repo/packages/shell/app',
    publicKeyPath: '/keys/bundle.pem',
  })

  assert.deepEqual(plan.copies.at(-1), {
    from: '/keys/bundle.pem',
    to: '/repo/packages/shell/app/bundle-public-key.pem',
  })
})

test('scanBareImports 只报告非 node:、非相对的模块', () => {
  const source = `
    import { readFile } from 'node:fs/promises'
    import path from 'node:path'
    import local from './local.js'
    import absolute from '/abs/module.js'
    import lodash from 'lodash'
    export { thing } from 'left-pad'
    const lazy = await import('dynamic-dep')
    const legacy = require('cjs-dep')
  `

  const warnings = scanBareImports(source, 'server/index.js')

  assert.deepEqual(
    warnings.map((warning) => warning.specifier).sort(),
    ['cjs-dep', 'dynamic-dep', 'left-pad', 'lodash'],
  )
  assert.ok(warnings.every((warning) => warning.file === 'server/index.js'))
})

test('planBareImportScan 包含项目 server 与内置插件服务端入口', () => {
  const targets = planBareImportScan({
    distDir: '/project/dist',
    pluginManifests: [
      { dir: 'hello', manifest: { server: 'server.js', client: 'client.js' } },
      { dir: 'ui-only', manifest: { client: 'client.js' } },
    ],
  })

  assert.deepEqual(
    targets.map((target) => target.label),
    ['server/index.js', 'resources/plugins/hello/server.js'],
  )
})

test('parseArgs 接受打包必需的参数', () => {
  assert.deepEqual(
    parseArgs([
      '--project',
      '/project',
      '--out',
      '/out',
      '--bundle-public-key',
      '/keys/bundle.pem',
    ]),
    { project: '/project', out: '/out', publicKey: '/keys/bundle.pem', help: false },
  )
  assert.throws(() => parseArgs(['--project']), /缺少/)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

test('缺少 dist 必要文件时命令非零退出并指出缺失项', (t) => {
  const project = tempDir(t)
  const out = tempDir(t)

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--project', project, '--out', out],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /app\.json/)
  assert.match(result.stderr, /server\/index\.js/)
  assert.match(result.stderr, /resources\/ui\/index\.html/)
})

test('bundleRuntime 把可选原生依赖内联为空模块', async (t) => {
  const root = tempDir(t, 'cordis-package-empty-')
  const entryDir = join(root, 'entries')
  const outDir = join(root, 'out')
  mkdirSync(entryDir, { recursive: true })

  writeFileSync(
    join(entryDir, 'entry.mjs'),
    `
      import * as bufferutil from 'bufferutil'
      import * as utf8 from 'utf-8-validate'

      export const keys = [...Object.keys(bufferutil), ...Object.keys(utf8)]
    `,
  )

  await bundleRuntime({
    entries: [{ entry: join(entryDir, 'entry.mjs'), outfile: 'entry.mjs' }],
    outDir,
    nodePaths: [runtimeNodeModules],
  })

  const module = await import(pathToFileURL(join(outDir, 'entry.mjs')).href)
  assert.deepEqual(module.keys, [])
})

test('bundleRuntime 产出可加载的 ESM：顶层 await、ws 与大消息掩码都可用', async (t) => {
  const root = tempDir(t, 'cordis-package-smoke-')
  const entryDir = join(root, 'entries')
  const outDir = join(root, 'out')
  mkdirSync(entryDir, { recursive: true })

  writeFileSync(
    join(entryDir, 'supervisor.mjs'),
    `
      import { WebSocket } from 'ws'

      // 复刻 ws 的可选原生依赖分支：打包配置必须让这里落到纯 JS 回退。
      let bufferUtil = null
      if (!process.env.WS_NO_BUFFER_UTIL) {
        try {
          bufferUtil = require('bufferutil')
        } catch {}
      }

      function fallbackMask(source, key, output, offset, length) {
        for (let index = 0; index < length; index++) {
          output[offset + index] = source[index] ^ key[index & 3]
        }
      }

      export function maskBytes(source, key) {
        const output = Buffer.alloc(source.length)
        if (bufferUtil) bufferUtil.mask(source, key, output, 0, source.length)
        else fallbackMask(source, key, output, 0, source.length)
        return output
      }

      export const hasWebSocket = typeof WebSocket === 'function'
      export const ready = await Promise.resolve('supervisor-ready')
    `,
  )
  writeFileSync(
    join(entryDir, 'worker.mjs'),
    `
      import { WebSocket } from 'ws'

      export const workerReady = 'worker-ready'
      export const hasWebSocket = typeof WebSocket === 'function'
    `,
  )

  await bundleRuntime({
    entries: [
      {
        entry: join(entryDir, 'supervisor.mjs'),
        outfile: 'cordis-app-supervisor.mjs',
      },
      { entry: join(entryDir, 'worker.mjs'), outfile: 'cordis-app-worker.mjs' },
    ],
    outDir,
    nodePaths: [runtimeNodeModules],
  })

  const supervisor = await import(
    pathToFileURL(join(outDir, 'cordis-app-supervisor.mjs')).href
  )
  const worker = await import(pathToFileURL(join(outDir, 'cordis-app-worker.mjs')).href)

  assert.equal(supervisor.ready, 'supervisor-ready')
  assert.equal(supervisor.hasWebSocket, true)
  assert.equal(worker.workerReady, 'worker-ready')
  assert.equal(worker.hasWebSocket, true)

  // 超过 48 字节才会走 bufferutil 加速分支；空模块会让这里抛 TypeError。
  const source = Buffer.from(Array.from({ length: 200 }, (_, index) => index % 251))
  const key = Buffer.from([1, 2, 3, 4])
  assert.deepEqual(
    supervisor.maskBytes(source, key),
    Buffer.from(source.map((byte, index) => byte ^ key[index & 3])),
  )

  // 随包分发时不能留下对可选原生依赖的导入。
  const supervisorSource = readFileSync(
    join(outDir, 'cordis-app-supervisor.mjs'),
    'utf8',
  )
  assert.doesNotMatch(supervisorSource, /from ['"](bufferutil|utf-8-validate)['"]/)
})
