/**
 * 示例插件的冒烟测试。
 *
 * 直接跑源码：本插件由 esbuild 打包，不产出声明文件，`lib/server.js` 没有可供
 * tsc 解析的类型。Node 24 的类型擦除足以执行这份 TS 源码，而「插件用 ctx 做了
 * 什么」这件事与打包无关。
 *
 * 这里不启动 HTTP 服务——直接用一个假的 ctx 触发 apply，再手动调用注册上去的
 * 路由处理器。插件的契约就是「用 ctx 提供的东西做事」，把 ctx 换成假的即可
 * 验证它有没有越界。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, data, inject, name } from '../src/server.ts'
import type { KernelContext, RouteHandler } from '@cordis-app/kernel'

function createFakeContext() {
  const routes = new Map<string, RouteHandler>()
  const files = new Map<string, string>()

  const ctx = {
    logger: { info() {} },
    storage: {
      dir: (id: string) => `/data/${id}`,
      read: async (id: string, file: string) => {
        const value = files.get(`${id}/${file}`)
        return value === undefined ? undefined : Buffer.from(value)
      },
      write: async (id: string, file: string, value: string) => {
        files.set(`${id}/${file}`, String(value))
      },
    },
    router: {
      get(path: string, handler: RouteHandler) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }

  return { ctx: ctx as unknown as KernelContext, routes, files }
}

function createResponse() {
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) {
      response.status = status
    },
    end(body: string) {
      response.body = body
    },
  }
  return response
}

test('清单字段符合插件的身份约定', () => {
  assert.equal(name, 'hello')
  assert.ok(inject.includes('router'))
  assert.ok(inject.includes('storage'))
  assert.equal(typeof data.greeting, 'string')
})

test('注册了 /api/hello，并且访问次数确实落盘', async () => {
  const { ctx, routes, files } = createFakeContext()
  apply(ctx)

  const handler = routes.get('/api/hello')
  assert.ok(handler, 'apply 应当注册 /api/hello')

  const first = createResponse()
  await handler({} as never, first as never, {})
  assert.equal(first.status, 200)
  assert.deepEqual(JSON.parse(first.body), { greeting: data.greeting, visits: 1 })

  const second = createResponse()
  await handler({} as never, second as never, {})
  assert.equal(JSON.parse(second.body).visits, 2)

  // 数据写在自己 id 对应的目录下，不会污染别的插件
  assert.equal(files.get('hello/visits.txt'), '2')
})
