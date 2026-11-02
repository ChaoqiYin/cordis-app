import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkProjectFramework, checkProjectFrameworkFile } from '../lib/plugin/doctor.js'

function project(dependencies: Record<string, string>): unknown {
  return { name: 'demo', version: '0.1.0', dependencies }
}

test('semver 依赖范围兼容时通过', () => {
  assert.deepEqual(checkProjectFramework(project({ 'cordis-app': '^1.0.0' }), '1.0.0'), {
    ok: true,
  })
})

test('semver 依赖范围不兼容时给出范围与当前版本', () => {
  const result = checkProjectFramework(project({ 'cordis-app': '^0.9.0' }), '1.0.0')
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /\^0\.9\.0/)
  assert.match(result.reason ?? '', /1\.0\.0/)
})

test('file: 依赖按已安装版本判断：一致时通过', () => {
  assert.deepEqual(
    checkProjectFramework(
      project({ 'cordis-app': 'file:../cordis-app/packages/cordis-app' }),
      '1.0.0',
      '1.0.0',
    ),
    { ok: true },
  )
})

test('file: 依赖按已安装版本判断：不一致时失败', () => {
  const result = checkProjectFramework(
    project({ 'cordis-app': 'file:../cordis-app/packages/cordis-app' }),
    '1.0.0',
    '0.9.0',
  )
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /0\.9\.0/)
  assert.match(result.reason ?? '', /1\.0\.0/)
})

test('非 semver 依赖解析不到安装版本时不阻断启动', () => {
  assert.deepEqual(
    checkProjectFramework(project({ 'cordis-app': 'file:../cordis-app/packages/cordis-app' })),
    { ok: true },
  )
})

test('checkProjectFrameworkFile 从 node_modules 读取实际安装版本', () => {
  const root = mkdtempSync(join(tmpdir(), 'cordis-doctor-'))
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify(project({ 'cordis-app': 'file:../cordis-app/packages/cordis-app' })),
    )
    const installed = join(root, 'node_modules', 'cordis-app')
    mkdirSync(installed, { recursive: true })
    writeFileSync(
      join(installed, 'package.json'),
      JSON.stringify({
        name: 'cordis-app',
        version: '1.0.0',
        exports: { '.': './index.js', './package.json': './package.json' },
      }),
    )
    writeFileSync(join(installed, 'index.js'), 'export {}\n')

    assert.deepEqual(checkProjectFrameworkFile(join(root, 'package.json'), '1.0.0'), { ok: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
