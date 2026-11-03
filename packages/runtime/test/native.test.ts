/**
 * 原生能力的 worker 侧接缝。
 *
 * 测试只从 `startWorker` 进入：项目 server 的 `ctx.native` 是唯一观察点，
 * 外壳用 Node `http` 起的假 native server 代替。这样既覆盖环境变量、client、
 * 服务与挂载顺序，又不依赖真实桌面外壳。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorker, readWorkerOptions } from '../lib/worker/worker.js'
import { findFreePort, generateToken } from '../lib/supervisor/supervisor.js'
import {
  ENV_NATIVE_TOKEN,
  ENV_NATIVE_URL,
  ENV_PORT,
  ENV_PROJECT,
  ENV_TOKEN,
  NATIVE_COMMANDS,
  type NativeCommand,
  type NativeInfo,
} from '@cordis-app/protocol'

interface Fixture {
  projectRoot: string
  resourcesDir: string
}

/** 项目 server 把 ctx.native 暴露成 HTTP 路由，测试从项目自己的路由观察。 */
const NATIVE_SERVER = `const readJson = async (req) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

const respond = (res, value) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

export default function apply(ctx) {
  ctx.router.get('/api/native/info', (_req, res) => {
    respond(res, { available: ctx.native.available, commands: ctx.native.commands() })
  })
  ctx.router.post('/api/native/invoke', async (req, res) => {
    const body = await readJson(req)
    respond(res, await ctx.native.invoke(body.command, body.input))
  })
}
`

function createFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'cordis-native-'))
  const resourcesDir = join(projectRoot, 'resources')
  mkdirSync(join(resourcesDir, 'ui'), { recursive: true })
  mkdirSync(join(resourcesDir, 'shared'), { recursive: true })
  writeFileSync(join(resourcesDir, 'ui', 'index.html'), '<!doctype html><title>t</title>')
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'native-test', version: '1.0.0', private: true, type: 'module' }),
  )
  writeFileSync(join(projectRoot, 'app.json'), JSON.stringify({ name: 'native-test', version: '1.0.0', plugins: [] }))
  mkdirSync(join(projectRoot, 'server'), { recursive: true })
  writeFileSync(join(projectRoot, 'server', 'index.js'), NATIVE_SERVER)
  return { projectRoot, resourcesDir }
}

interface RecordedRequest {
  method: string | undefined
  path: string | undefined
  authorization: string | undefined
  body: { command?: NativeCommand; input?: unknown } | undefined
}

interface FakeNative {
  url: string
  token: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

/**
 * 假外壳：只实现 `/info` 与 `/invoke` 两个端点，把收到的请求原样记下来。
 * `invoke` 由各用例决定怎么回，未提供时回成功空对象。
 */
async function createFakeNative(options: {
  info?: Partial<NativeInfo>
  invoke?: (request: RecordedRequest, res: ServerResponse) => void | Promise<void>
} = {}): Promise<FakeNative> {
  const token = 'native-token'
  const requests: RecordedRequest[] = []
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const request: RecordedRequest = {
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
    }
    requests.push(request)
    // 客户端超时后会断开，写回响应时的错误不能反过来拖垮测试。
    res.on('error', () => {})

    if (req.url === '/info') {
      respondJson(res, 200, {
        contractVersion: 1,
        platform: 'darwin',
        arch: 'arm64',
        hasWindow: true,
        commands: [...NATIVE_COMMANDS],
        ...options.info,
      })
      return
    }
    if (req.url === '/invoke') {
      if (options.invoke) {
        await options.invoke(request, res)
        return
      }
      respondJson(res, 200, { ok: true, value: {} })
      return
    }
    respondJson(res, 404, { error: 'not_found' })
  })

  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    requests,
    close: () => closeServer(server),
  }
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
  res.end(payload)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

async function startNativeWorker(
  fixture: Fixture,
  options: { native?: { url: string; token: string; timeoutMs?: number } } = {},
) {
  const port = await findFreePort()
  const token = generateToken()
  const handle = await startWorker({
    port,
    token,
    projectRoot: fixture.projectRoot,
    resourcesDir: fixture.resourcesDir,
    ...(options.native ? { native: options.native } : {}),
  })
  return { handle, port, token, base: `http://127.0.0.1:${port}` }
}

/** 通过项目 server 自己的路由调用 ctx.native，等价于项目作者的真实用法。 */
function postNative(
  worker: { base: string; token: string },
  command: NativeCommand,
  input: unknown,
): Promise<Response> {
  return fetch(`${worker.base}/api/native/invoke`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${worker.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ command, input }),
  })
}

test('worker 读取原生环境变量后立即从环境对象删除', () => {
  const env: NodeJS.ProcessEnv = {
    [ENV_PORT]: '5140',
    [ENV_TOKEN]: 'worker-token',
    [ENV_PROJECT]: '/tmp/project',
    [ENV_NATIVE_URL]: 'http://127.0.0.1:4321',
    [ENV_NATIVE_TOKEN]: 'native-token',
  }

  const options = readWorkerOptions(env)

  assert.deepEqual(options.native, { url: 'http://127.0.0.1:4321', token: 'native-token' })
  assert.equal(Object.hasOwn(env, ENV_NATIVE_URL), false, 'token 与端点不能留在环境里给插件抢读')
  assert.equal(Object.hasOwn(env, ENV_NATIVE_TOKEN), false)
})

test('invoke 透传 command 与 input，并返回成功 envelope', async () => {
  const fake = await createFakeNative({
    invoke: (_request, res) => {
      respondJson(res, 200, { ok: true, value: { paths: ['/tmp/a.csv', '/tmp/b.csv'] } })
    },
  })
  const fixture = createFixture()
  const worker = await startNativeWorker(fixture, {
    native: { url: fake.url, token: fake.token },
  })
  try {
    const input = { multiple: true, filters: [{ name: 'CSV', extensions: ['csv'] }] }
    const response = await postNative(worker, 'path.chooseOpen', input)
    assert.deepEqual(await response.json(), {
      ok: true,
      value: { paths: ['/tmp/a.csv', '/tmp/b.csv'] },
    })

    const forwarded = fake.requests.find((request) => request.path === '/invoke')
    assert.ok(forwarded, 'client 必须真的发出 /invoke')
    assert.equal(forwarded?.method, 'POST')
    assert.deepEqual(forwarded?.body, { command: 'path.chooseOpen', input })
    assert.equal(forwarded?.authorization, `Bearer ${fake.token}`)
  } finally {
    await worker.handle.close()
    await fake.close()
  }
})

test('业务失败按 envelope 错误码映射，不当作 transport 异常', async () => {
  const fake = await createFakeNative({
    invoke: (request, res) => {
      if (request.body?.command === 'path.chooseSave') {
        respondJson(res, 200, { ok: false, code: 'cancelled' })
        return
      }
      respondJson(res, 200, {
        ok: false,
        code: 'unsupported',
        platform: 'linux',
        message: '未找到 zenity/kdialog',
      })
    },
  })
  const fixture = createFixture()
  const worker = await startNativeWorker(fixture, {
    native: { url: fake.url, token: fake.token },
  })
  try {
    const cancelled = await postNative(worker, 'path.chooseSave', {})
    assert.deepEqual(await cancelled.json(), { ok: false, code: 'cancelled' })

    const unsupported = await postNative(worker, 'notification.show', { title: 't', body: 'b' })
    assert.deepEqual(await unsupported.json(), {
      ok: false,
      code: 'unsupported',
      platform: 'linux',
      message: '未找到 zenity/kdialog',
    })
  } finally {
    await worker.handle.close()
    await fake.close()
  }
})

test('非交互命令超过 RPC 超时返回 timeout', async () => {
  const fake = await createFakeNative({
    invoke: async (_request, res) => {
      await delay(200)
      respondJson(res, 200, { ok: true, value: {} })
    },
  })
  const fixture = createFixture()
  const worker = await startNativeWorker(fixture, {
    native: { url: fake.url, token: fake.token, timeoutMs: 30 },
  })
  try {
    const response = await postNative(worker, 'window.setTitle', { title: '慢命令' })
    const result = await response.json()
    assert.equal(result.ok, false)
    assert.equal(result.code, 'timeout', '超时必须映射成固定错误码，而不是抛异常')
    assert.match(result.message, /window\.setTitle/)
  } finally {
    await worker.handle.close()
    await fake.close()
  }
})

test('path.choose* 不设 RPC 超时，用户慢慢选择不会被中断', async () => {
  const fake = await createFakeNative({
    invoke: async (_request, res) => {
      // 明显长于 client 的 30ms 默认超时；交互命令仍应等到结果。
      await delay(80)
      respondJson(res, 200, { ok: true, value: { paths: ['/tmp/slow.csv'] } })
    },
  })
  const fixture = createFixture()
  const worker = await startNativeWorker(fixture, {
    native: { url: fake.url, token: fake.token, timeoutMs: 30 },
  })
  try {
    const response = await postNative(worker, 'path.chooseOpen', { multiple: true })
    assert.deepEqual(await response.json(), {
      ok: true,
      value: { paths: ['/tmp/slow.csv'] },
    })
  } finally {
    await worker.handle.close()
    await fake.close()
  }
})

test('没有原生环境变量时 ctx.native 降级为不可用', async () => {
  const fixture = createFixture()
  const worker = await startNativeWorker(fixture)
  try {
    const info = await (
      await fetch(`${worker.base}/api/native/info`, {
        headers: { authorization: `Bearer ${worker.token}` },
      })
    ).json()
    assert.deepEqual(info, { available: false, commands: [] })

    const response = await postNative(worker, 'system.info', {})
    assert.deepEqual(await response.json(), {
      ok: false,
      code: 'unsupported',
      message: '当前没有可用的原生外壳',
    })
  } finally {
    await worker.handle.close()
  }
})

test('契约版本不匹配时降级并告警，但不阻止启动', async () => {
  const fake = await createFakeNative({ info: { contractVersion: 99 } })
  const fixture = createFixture()
  const logs: string[] = []
  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  let worker: Awaited<ReturnType<typeof startNativeWorker>> | undefined
  try {
    worker = await startNativeWorker(fixture, {
      native: { url: fake.url, token: fake.token },
    })

    const health = await fetch(`${worker.base}/__health`)
    assert.equal(health.status, 200, '契约不匹配不能阻止 worker 启动')

    const info = await (
      await fetch(`${worker.base}/api/native/info`, {
        headers: { authorization: `Bearer ${worker.token}` },
      })
    ).json()
    assert.deepEqual(info, { available: false, commands: [] })

    const response = await postNative(worker, 'system.info', {})
    assert.equal((await response.json()).code, 'unsupported')
    assert.ok(
      logs.some((line) => line.includes('契约版本不匹配')),
      '版本不匹配必须留下明确告警',
    )
  } finally {
    process.stderr.write = originalWrite
    await worker?.handle.close()
    await fake.close()
  }
})

test('每次原生调用写审计日志：调用方、命令、结果码与耗时', async () => {
  const fake = await createFakeNative({
    invoke: (request, res) => {
      if (request.body?.command === 'path.chooseSave') {
        respondJson(res, 200, { ok: false, code: 'cancelled' })
        return
      }
      respondJson(res, 200, { ok: true, value: {} })
    },
  })
  const fixture = createFixture()
  const logs: string[] = []
  const originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    logs.push(String(chunk))
    return true
  }) as typeof process.stderr.write

  let worker: Awaited<ReturnType<typeof startNativeWorker>> | undefined
  try {
    worker = await startNativeWorker(fixture, {
      native: { url: fake.url, token: fake.token },
    })
    await postNative(worker, 'window.setSize', { width: 800, height: 600 })
    await postNative(worker, 'path.chooseSave', {})

    assert.ok(
      logs.some((line) =>
        /native caller=project command=window\.setSize code=ok durationMs=\d+/.test(line),
      ),
      `审计日志必须记录项目、命令、结果码与耗时，实际日志：${logs.join('')}`,
    )
    assert.ok(
      logs.some((line) =>
        /native caller=project command=path\.chooseSave code=cancelled durationMs=\d+/.test(line),
      ),
      '失败结果同样要写审计',
    )
  } finally {
    process.stderr.write = originalWrite
    await worker?.handle.close()
    await fake.close()
  }
})

test('有外壳时项目 server 的 ctx.native 可用并拥有全量命令', async () => {
  const fake = await createFakeNative()
  const fixture = createFixture()
  const worker = await startNativeWorker(fixture, {
    native: { url: fake.url, token: fake.token },
  })
  try {
    const response = await fetch(`${worker.base}/api/native/info`, {
      headers: { authorization: `Bearer ${worker.token}` },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      available: true,
      commands: [...NATIVE_COMMANDS],
    })

    assert.equal(fake.requests[0]?.method, 'GET')
    assert.equal(fake.requests[0]?.path, '/info')
    assert.equal(
      fake.requests[0]?.authorization,
      `Bearer ${fake.token}`,
      'client 必须用原生 token 鉴权，而不是页面 token',
    )
  } finally {
    await worker.handle.close()
    await fake.close()
  }
})
