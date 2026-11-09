/**
 * 包管理器检测器的纯逻辑单测。
 *
 * 检测只读项目根下的文件，不执行任何命令。这里直接构造 package.json、
 * lockfile 与 node_modules 证据的组合，断言检测结果或错误信息——冲突规则
 * 需要精确断言，放进 HTTP 缝隙会被请求样板淹没。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectPackageManager } from '../lib/plugin/package-manager.js'

function project(): string {
  return mkdtempSync(join(tmpdir(), 'cordis-pm-'))
}

function writePackageJson(root: string, value: Record<string, unknown>): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify(value))
}

function touch(root: string, name: string): void {
  const path = join(root, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '')
}

function evidence(root: string, ...names: string[]): void {
  for (const name of names) touch(root, join('node_modules', name))
}

test('没有任何信号时回退 npm', () => {
  const root = project()
  writePackageJson(root, { name: 't' })

  assert.equal(detectPackageManager({ projectRoot: root }).name, 'npm')
})

test('package.json#packageManager 支持 name@version 形式', () => {
  const root = project()
  writePackageJson(root, { name: 't', packageManager: 'pnpm@10.26.2' })

  assert.equal(detectPackageManager({ projectRoot: root }).name, 'pnpm')
})

test('package.json#packageManager 优先于 lockfile', () => {
  const root = project()
  writePackageJson(root, { name: 't', packageManager: 'yarn@4.5.0' })
  touch(root, 'package-lock.json')

  assert.equal(detectPackageManager({ projectRoot: root }).name, 'yarn')
})

test('显式 yarnPath 优先级最高', () => {
  const root = project()
  writePackageJson(root, { name: 't', packageManager: 'pnpm@10.0.0' })
  touch(root, 'package-lock.json')
  const yarnPath = join(root, 'vendor', 'yarn.cjs')

  const detected = detectPackageManager({ projectRoot: root, yarnPath })
  assert.equal(detected.name, 'yarn')
  assert.equal(detected.command, process.execPath)
  assert.deepEqual(detected.argsPrefix, [yarnPath])
})

test('package.json#packageManager 不是受支持的管理器时报错', () => {
  const root = project()
  writePackageJson(root, { name: 't', packageManager: 'deno@2.0.0' })

  assert.throws(
    () => detectPackageManager({ projectRoot: root }),
    (error: Error) =>
      /packageManager/.test(error.message) &&
      /deno/.test(error.message) &&
      /npm|pnpm|yarn|bun/.test(error.message),
  )
})

for (const [lockfile, name] of [
  ['pnpm-lock.yaml', 'pnpm'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
] as const) {
  test(`唯一的 ${lockfile} 识别为 ${name}`, () => {
    const root = project()
    writePackageJson(root, { name: 't' })
    touch(root, lockfile)

    assert.equal(detectPackageManager({ projectRoot: root }).name, name)
  })
}

test('同一管理器的多个 lockfile 不算冲突', () => {
  const root = project()
  writePackageJson(root, { name: 't' })
  touch(root, 'bun.lock')
  touch(root, 'bun.lockb')

  assert.equal(detectPackageManager({ projectRoot: root }).name, 'bun')
})

test('多个 lockfile 指向不同管理器时用 node_modules 证据消歧', () => {
  const root = project()
  writePackageJson(root, { name: 't' })
  touch(root, 'pnpm-lock.yaml')
  touch(root, 'package-lock.json')
  evidence(root, '.pnpm')

  assert.equal(detectPackageManager({ projectRoot: root }).name, 'pnpm')
})

test('证据必须命中候选管理器', () => {
  const root = project()
  writePackageJson(root, { name: 't' })
  touch(root, 'pnpm-lock.yaml')
  touch(root, 'yarn.lock')
  evidence(root, '.package-lock.json')

  assert.throws(
    () => detectPackageManager({ projectRoot: root }),
    (error: Error) =>
      /pnpm/.test(error.message) &&
      /yarn/.test(error.message) &&
      /package-lock|证据/.test(error.message) &&
      /packageManager|删除|清理/.test(error.message),
  )
})

test('证据命中多个时视为歧义', () => {
  const root = project()
  writePackageJson(root, { name: 't' })
  touch(root, 'pnpm-lock.yaml')
  touch(root, 'yarn.lock')
  evidence(root, '.pnpm', '.yarn-integrity')

  assert.throws(() => detectPackageManager({ projectRoot: root }), /歧义|无法消歧/)
})

test('没有 lockfile 时唯一的 node_modules 证据可确定管理器', () => {
  const root = project()
  writePackageJson(root, { name: 't' })
  evidence(root, '.yarn-integrity')

  assert.equal(detectPackageManager({ projectRoot: root }).name, 'yarn')
})

test('没有 lockfile 且证据不唯一时明确报错', () => {
  const root = project()
  writePackageJson(root, { name: 't' })
  evidence(root, '.pnpm', '.package-lock.json')

  assert.throws(
    () => detectPackageManager({ projectRoot: root }),
    (error: Error) =>
      /pnpm/.test(error.message) &&
      /npm/.test(error.message) &&
      /packageManager|清理/.test(error.message),
  )
})

test('package.json 缺失时仍按 lockfile 检测', () => {
  const root = project()
  touch(root, 'pnpm-lock.yaml')

  assert.equal(detectPackageManager({ projectRoot: root }).name, 'pnpm')
})
