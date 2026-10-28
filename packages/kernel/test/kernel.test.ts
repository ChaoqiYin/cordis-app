/**
 * kernel 的冒烟测试。
 *
 * 跑构建产物而不是源码：Node 的类型擦除不会把 `./x.js` 解析回 `./x.ts`，
 * 而产物才是真正会发布、被 runtime 加载的东西。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createKernel } from '../lib/kernel.js'
import { createLoggerFactory } from '../lib/logger.js'
import { ConfigStore } from '../lib/config.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('挂载插件并注入配置，卸载后清理干净', async () => {
  const kernel = createKernel()
  const seen: string[] = []

  const handle = kernel.plugin(
    {
      name: 'demo',
      apply(ctx, config: { accent: string }) {
        seen.push(`apply:${config.accent}`)
        ctx.set('demoService', { ok: true })
        ctx.effect(() => () => seen.push('dispose'))
      },
    },
    { accent: '#fff' },
  )

  await kernel.ready()
  assert.equal(handle.status, 'active')
  assert.equal(kernel.context.demoService.ok, true)

  handle.dispose()
  assert.deepEqual(seen, ['apply:#fff', 'dispose'])
  assert.equal(kernel.context.demoService, undefined)
})

test('inject 软等待：依赖注册后插件自动恢复', async () => {
  const kernel = createKernel()
  let applied = false

  kernel.plugin({ name: 'needs-router', inject: ['router'], apply: () => (applied = true) })
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(applied, false, '依赖缺失时插件不应执行')

  kernel.service('router', () => ({ get() {} }))
  await kernel.ready()
  assert.equal(applied, true, '依赖注册后插件应自动执行')
})

test('restart 走 dispose → apply，配置被替换', async () => {
  const kernel = createKernel()
  const seen: number[] = []
  const handle = kernel.plugin(
    {
      name: 'restartable',
      apply(_ctx, config: { v: number }) {
        seen.push(config.v)
      },
    },
    { v: 1 },
  )
  await kernel.ready()
  handle.restart({ v: 2 })
  await kernel.ready()
  assert.deepEqual(seen, [1, 2])
})

test('isolate 让插件的前端 scope 可以独立卸载', async () => {
  const kernel = createKernel()
  const disposed: string[] = []

  for (const id of ['a', 'b']) {
    kernel.isolate(id).plugin({
      name: id,
      apply(ctx) {
        ctx.effect(() => () => disposed.push(id))
      },
    })
  }
  await kernel.ready()
  assert.deepEqual(disposed, [])

  // 卸载其中一个 isolate 的作用域，不应波及另一个
  kernel.isolate('a').dispose()
  assert.deepEqual(disposed, ['a'])
})

test('同名服务在同一作用域内重复注册会硬失败', async () => {
  const kernel = createKernel()
  kernel.service('dup', () => ({}))
  assert.throws(() => kernel.service('dup', () => ({})), /has been registered/)
})

test('logger 按级别过滤且写 stderr 之外的注入目标', () => {
  const lines: string[] = []
  const logger = createLoggerFactory({ level: 'warn', write: (l) => lines.push(l), timestamps: false })
  const log = logger('test')
  log.info('ignored')
  log.warn('kept')
  log.error('also kept')
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /WARN\s+test kept/)
})

test('config 原子落盘且可回读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cordis-config-'))
  const file = join(dir, 'config.json')
  const store = new ConfigStore({ filePath: file })
  store.set('demo', { dark: true })
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk, { demo: { dark: true } })

  const reloaded = new ConfigStore({ filePath: file })
  assert.deepEqual(reloaded.get('demo'), { dark: true })
})
