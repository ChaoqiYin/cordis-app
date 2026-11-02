import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  validateDist,
  planStaging,
  scanBareImports,
  validateBareImports,
  planBareImportScan,
  parseArgs,
  assertPresetLib,
  bundleRuntime,
} from './package-desktop.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const scriptPath = join(here, 'package-desktop.mjs')
// 冒烟测试用的 ws 由 runtime 包声明，工作区里只有它自己解析得到。
const runtimeNodeModules = resolve(here, '..', '..', 'runtime', 'node_modules')
const repoRoot = resolve(here, '..', '..', '..')
const runtimeLib = join(repoRoot, 'packages', 'runtime', 'lib')
const shellAppDir = resolve(here, '..', 'app')

function tempDir(t, prefix = 'cordis-package-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * 递归快照一棵目录树：相对路径 → 内容 hash 或目录标记。
 *
 * 用来证明发布门禁在失败路径上没有改动外壳的暂存目录，而不是假设它本来
 * 就是空的——开发者跑过 `package:desktop` 后目录里通常有产物。
 */
function snapshotTree(root) {
  const snapshot = new Map()
  if (!existsSync(root)) return snapshot

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      const key = relative(root, full)
      if (entry.isDirectory()) {
        snapshot.set(`${key}/`, 'dir')
        walk(full)
      } else if (entry.isFile()) {
        snapshot.set(
          key,
          createHash('sha256').update(readFileSync(full)).digest('hex'),
        )
      }
    }
  }
  walk(root)
  return snapshot
}

/** 写一个最小可打包项目；`serverSource` 决定裸导入门禁是否失败。 */
function writeProject(t, serverSource = "import lodash from 'lodash'\n") {
  const root = tempDir(t)
  const project = join(root, 'project')
  const dist = join(project, 'dist')
  for (const relativePath of [
    'app.json',
    'package.json',
    'server/index.js',
    'resources/ui/index.html',
  ]) {
    mkdirSync(join(dist, relativePath, '..'), { recursive: true })
    writeFileSync(join(dist, relativePath), 'x')
  }
  writeFileSync(join(dist, 'server', 'index.js'), serverSource)

  return {
    project,
    dist,
    out: join(root, 'install'),
    root,
  }
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

test('scanBareImports 放行 Node 内置与框架提供依赖，报告其余裸导入', () => {
  const source = `
    import { readFile } from 'node:fs/promises'
    import path from 'node:path'
    import { EventEmitter } from 'events'
    import type { Server } from 'cordis-app'
    import { definePlugin } from 'cordis-app/server'
    import local from './local.js'
    import absolute from '/abs/module.js'
    import lodash from 'lodash'
    import protocol from '@cordis-app/protocol'
    export { thing } from 'left-pad'
    const lazy = await import('dynamic-dep')
    const legacy = require('cjs-dep')
    const bundled = __require("esbuild-dep")
  `

  const violations = scanBareImports(source, 'server/index.js')

  assert.deepEqual(
    violations.map((violation) => violation.specifier).sort(),
    ['@cordis-app/protocol', 'cjs-dep', 'dynamic-dep', 'esbuild-dep', 'left-pad', 'lodash'],
  )
  assert.ok(violations.every((violation) => violation.file === 'server/index.js'))
})

test('validateBareImports 放行只含白名单导入的 dist', (t) => {
  const dist = join(tempDir(t), 'dist')
  mkdirSync(join(dist, 'server'), { recursive: true })
  writeFileSync(
    join(dist, 'server', 'index.js'),
    `
      import { readFile } from 'node:fs/promises'
      import { EventEmitter } from 'events'
      import type { Server } from 'cordis-app'
      import { definePlugin } from 'cordis-app/server'
      import local from './local.js'
    `,
  )

  assert.deepEqual(validateBareImports(dist), {
    ok: true,
    violations: [],
    errors: [],
  })
})

test('validateBareImports 报告项目与插件服务端的违规文件与包名', (t) => {
  const dist = join(tempDir(t), 'dist')
  const pluginDir = join(dist, 'resources', 'plugins', 'hello')
  mkdirSync(join(dist, 'server'), { recursive: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(dist, 'server', 'index.js'),
    "import lodash from 'lodash'\n",
  )
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'hello', server: 'server.js' }),
  )
  writeFileSync(
    join(pluginDir, 'server.js'),
    "import protocol from '@cordis-app/protocol'\n",
  )

  assert.deepEqual(validateBareImports(dist), {
    ok: false,
    violations: [
      { file: 'server/index.js', specifier: 'lodash' },
      { file: 'resources/plugins/hello/server.js', specifier: '@cordis-app/protocol' },
    ],
    errors: [],
  })
})

test('validateBareImports 在插件清单损坏时失败并指出清单路径', (t) => {
  const dist = join(tempDir(t), 'dist')
  const pluginDir = join(dist, 'resources', 'plugins', 'broken')
  const manifestPath = join(pluginDir, 'plugin.json')
  mkdirSync(join(dist, 'server'), { recursive: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(dist, 'server', 'index.js'), "import 'node:fs'\n")
  writeFileSync(manifestPath, '{ not json')

  const result = validateBareImports(dist)

  assert.equal(result.ok, false)
  assert.deepEqual(result.violations, [])
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0].includes(manifestPath), `错误应指出清单路径：${result.errors[0]}`)
})

test('validateBareImports 在插件声明 server 但文件缺失时失败', (t) => {
  const dist = join(tempDir(t), 'dist')
  const pluginDir = join(dist, 'resources', 'plugins', 'hello')
  const expectedPath = join(pluginDir, 'server.js')
  mkdirSync(join(dist, 'server'), { recursive: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(dist, 'server', 'index.js'), "import 'node:fs'\n")
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'hello', server: 'server.js' }),
  )

  const result = validateBareImports(dist)

  assert.equal(result.ok, false)
  assert.deepEqual(result.violations, [])
  assert.equal(result.errors.length, 1)
  assert.ok(result.errors[0].includes(expectedPath), `错误应指出缺失入口：${result.errors[0]}`)
})

test('validateBareImports 允许没有 server 入口的插件', (t) => {
  const dist = join(tempDir(t), 'dist')
  const pluginDir = join(dist, 'resources', 'plugins', 'ui-only')
  mkdirSync(join(dist, 'server'), { recursive: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(dist, 'server', 'index.js'), "import 'node:fs'\n")
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'ui-only', client: 'client.js' }),
  )

  assert.deepEqual(validateBareImports(dist), {
    ok: true,
    violations: [],
    errors: [],
  })
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

test('白名单外裸导入在暂存与打包前非零退出，不留下半成品', (t) => {
  const { project, dist, out } = writeProject(t)
  const pluginDir = join(dist, 'resources', 'plugins', 'hello')
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({ id: 'hello', server: 'server.js' }),
  )
  writeFileSync(
    join(pluginDir, 'server.js'),
    "import protocol from '@cordis-app/protocol'\n",
  )

  // 不假设 app/ 为空：跑过 package:desktop 的开发者目录里通常已有暂存产物。
  // 断言的是「这次运行没有改动它」，而不是「它必须为空」。
  const before = snapshotTree(shellAppDir)

  const result = spawnSync(
    process.execPath,
    [scriptPath, '--project', project, '--out', out],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /server\/index\.js/)
  assert.match(result.stderr, /lodash/)
  assert.match(result.stderr, /resources\/plugins\/hello\/server\.js/)
  assert.match(result.stderr, /@cordis-app\/protocol/)
  assert.match(result.stderr, /重新执行 cordis-app build/)
  assert.doesNotMatch(result.stderr, /packages: 'external'/)
  assert.doesNotMatch(result.stderr, /distribution 预设/)
  assert.equal(existsSync(out), false, '失败时不应生成安装目录')
  assert.deepEqual(snapshotTree(shellAppDir), before, '失败时不得修改外壳 app 目录')
})

test('门禁失败时不删除外壳 app 里已有的暂存文件', (t) => {
  const { project, out } = writeProject(t)
  const serverDir = join(shellAppDir, 'server')
  const serverExisted = existsSync(serverDir)
  const sentinel = join(serverDir, 'test-sentinel.txt')

  mkdirSync(serverDir, { recursive: true })
  writeFileSync(sentinel, 'keep-me')
  t.after(() => {
    // 只清理本用例创建的东西；不碰目录里任何已有产物。
    rmSync(sentinel, { force: true })
    if (
      !serverExisted &&
      existsSync(serverDir) &&
      readdirSync(serverDir).length === 0
    ) {
      rmdirSync(serverDir)
    }
  })

  const before = snapshotTree(shellAppDir)
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--project', project, '--out', out],
    { encoding: 'utf8' },
  )

  assert.equal(result.status, 1)
  assert.equal(readFileSync(sentinel, 'utf8'), 'keep-me', '已有暂存文件必须保留')
  assert.deepEqual(snapshotTree(shellAppDir), before, '测试不得修改外壳 app 目录')
  assert.equal(existsSync(out), false, '失败时不应生成安装目录')
})

test('assertPresetLib 在 preset 产物缺失时提示先构建', () => {
  const presetLib = '/repo/packages/preset/lib/index.js'

  assert.throws(
    () => assertPresetLib(presetLib, { existsSync: () => false }),
    /pnpm build:preset/,
  )
  assert.equal(assertPresetLib(presetLib, { existsSync: () => true }), presetLib)
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

/**
 * 返回真实 runtime 入口；缺产物时先尝试构建，构建不了就让调用方 SKIP。
 *
 * `pnpm test:shell` 不保证 runtime 已经构建过（CI 可能只跑这一步），所以在
 * 测试内补一次构建。构建失败不伪装成通过：明确输出 SKIP 原因。
 */
function ensureRealRuntimeEntries(t) {
  const entries = [
    {
      entry: join(runtimeLib, 'supervisor', 'main.js'),
      outfile: 'cordis-app-supervisor.mjs',
    },
    {
      entry: join(runtimeLib, 'worker', 'main.js'),
      outfile: 'cordis-app-worker.mjs',
    },
  ]

  if (entries.every(({ entry }) => existsSync(entry))) return entries

  const build = spawnSync(
    'pnpm',
    ['--filter', '@cordis-app/runtime', 'build'],
    { cwd: repoRoot, encoding: 'utf8' },
  )
  if (build.error || build.status !== 0) {
    const reason = build.error
      ? build.error.message
      : (build.stderr || build.stdout || '').trim() || `退出码 ${build.status}`
    t.skip(`无法构建 @cordis-app/runtime，跳过真实入口冒烟：${reason}`)
    return undefined
  }

  const missing = entries.filter(({ entry }) => !existsSync(entry))
  if (missing.length > 0) {
    t.skip(
      `构建后仍找不到真实入口，跳过真实入口冒烟：${missing
        .map(({ entry }) => entry)
        .join(', ')}`,
    )
    return undefined
  }
  return entries
}

test('真实入口冒烟：esbuild 产物可解析、无原生可选依赖、保留顶层 await', async (t) => {
  const entries = ensureRealRuntimeEntries(t)
  if (!entries) return

  const outDir = tempDir(t, 'cordis-package-real-')
  await bundleRuntime({ entries, outDir, nodePaths: [runtimeNodeModules] })

  // 只做静态检查，不执行/导入产物：真实入口一运行就会拉起 supervisor 与 worker。
  for (const { outfile } of entries) {
    const file = join(outDir, outfile)
    const check = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
    })
    assert.equal(check.status, 0, `${outfile} 不是合法的 ESM：${check.stderr}`)

    const source = readFileSync(file, 'utf8')
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s+|require\s*\(\s*)['"](?:bufferutil|utf-8-validate)['"]/,
      `${outfile} 不能静态导入可选原生依赖`,
    )
  }

  // supervisor 入口本身就是顶层 await；打包不能把它降级成 CJS 或包装掉。
  const supervisorSource = readFileSync(
    join(outDir, 'cordis-app-supervisor.mjs'),
    'utf8',
  )
  assert.match(supervisorSource, /\bawait\s+supervisor\.start\(\)/)
})
