/**
 * 项目布局的契约测试。
 *
 * 项目根是唯一的应用形态：CLI、supervisor、worker 共用这一份路径推导。
 * 这里钉住「项目根里有什么」，以及运行时文件与用户数据分离的边界。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveProjectLayout, resolveProjectRoot } from '../lib/paths.js'

test('resolveProjectLayout 把所有项目文件放在项目根下', () => {
  const projectRoot = join('/tmp', 'cordis-project')
  const layout = resolveProjectLayout(projectRoot)

  assert.equal(layout.projectRoot, projectRoot)
  assert.equal(layout.packageJson, join(projectRoot, 'package.json'))
  assert.equal(layout.appJson, join(projectRoot, 'app.json'))
  assert.equal(layout.bodyEntry, join(projectRoot, 'src', 'body.tsx'))
  assert.equal(layout.pagesDir, join(projectRoot, 'src', 'pages'))
  assert.equal(layout.serverEntry, join(projectRoot, 'server', 'index.js'))
  assert.equal(layout.localPluginsDir, join(projectRoot, 'plugins'))
  assert.equal(layout.dataDir, join(projectRoot, 'data'))
  assert.equal(layout.config, join(projectRoot, 'data', 'config.json'))
  assert.equal(layout.nodeModulesDir, join(projectRoot, 'node_modules'))
  assert.equal(layout.distDir, join(projectRoot, 'dist'))
})

test('运行时文件放在 .cordis，不混进用户数据', () => {
  const projectRoot = join('/tmp', 'cordis-project')
  const layout = resolveProjectLayout(projectRoot)
  const cordisDir = join(projectRoot, '.cordis')

  assert.equal(layout.cordisDir, cordisDir)
  assert.equal(layout.runtimeFile, join(cordisDir, 'runtime.json'))
  assert.equal(layout.tmpDir, join(cordisDir, 'tmp'))
  assert.equal(layout.logsDir, join(cordisDir, 'logs'))
})

test('布局不再有实例层与公共 app.lock', () => {
  const layout = resolveProjectLayout('/tmp/cordis-project') as Record<string, unknown>

  assert.equal('instanceDir' in layout, false)
  assert.equal('appLock' in layout, false)
})

test('布局为打包根预留可选字段，但默认不启用', () => {
  const plain = resolveProjectLayout('/tmp/cordis-project')
  assert.equal(plain.builtinPluginsDir, undefined)
  assert.equal(plain.userPluginsDir, undefined)

  const packaged = resolveProjectLayout('/tmp/cordis-project', {
    builtinPluginsDir: '/app/resources/plugins',
    userPluginsDir: '/user/plugins',
  })
  assert.equal(packaged.builtinPluginsDir, '/app/resources/plugins')
  assert.equal(packaged.userPluginsDir, '/user/plugins')
})

test('resolveProjectRoot 中显式目录优先于当前目录，环境变量优先于显式目录', () => {
  const cwd = join('/tmp', 'cwd')
  const cli = join('/tmp', 'from-cli')
  const env = { CORDIS_APP_PROJECT: join('/tmp', 'from-env') }

  assert.equal(resolveProjectRoot(undefined, {}, cwd), cwd)
  assert.equal(resolveProjectRoot(cli, {}, cwd), cli)
  assert.equal(resolveProjectRoot(cli, env, cwd), join('/tmp', 'from-env'))
})
