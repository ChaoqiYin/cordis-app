/**
 * supervisor —— 唯一稳定的、能持有跨重启状态的一层。
 *
 * 只做五件事：
 *   1. 分配端口与 token
 *   2. fork worker
 *   3. 转发 worker 的日志
 *   4. 输出握手行
 *   5. 按退出码决定是否重新 fork
 *
 * 它不加载任何插件、不碰业务、不持有平台相关的逻辑。
 * stdout 只有一个用途：输出握手行。自己的日志一律走 stderr。
 */

import { fork } from 'node:child_process'
import { createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ENV_DEV,
  ENV_LOCAL_PLUGINS,
  ENV_PORT,
  ENV_PROJECT,
  ENV_RESOURCES,
  ENV_SERVER_ENTRY,
  ENV_TOKEN,
  ENV_VERSION,
  EXIT_PORT_IN_USE,
  EXIT_RESTART,
  FRAMEWORK_VERSION,
  MAX_PORT_RETRIES,
  encodeHandshake,
  handshakeOf,
  resolveProjectLayout,
  type HandshakeLine,
  type PluginFailure,
  type RuntimeFile,
  type WorkerMessage,
} from '@cordis-app/protocol'
import { createLoggerFactory } from '@cordis-app/kernel'

export interface SupervisorOptions {
  /** 项目根。端口、token、运行时文件与 worker 环境都以它为准。 */
  projectRoot: string
  /** 前端产物目录，交给 worker 的 static 插件分发 */
  resourcesDir?: string
  /**
   * 覆盖项目 server 入口。
   *
   * `cordis-app start` 用它指向构建产物 `dist/server/index.js`；缺省仍是
   * 项目源码里的 `server/index.js`（`run` / `dev` 的形态）。
   */
  serverEntry?: string
  /** 覆盖项目本地插件根；`dev` 指向构建出来的 .cordis/dev/plugins */
  localPluginsDir?: string
  /** 开发模式：插件前端 URL 使用时间戳而不是内容 hash */
  dev?: boolean
  /** 覆盖 worker 路径，测试时注入 */
  workerPath?: string
  /** 覆盖版本号 */
  version?: string
  /**
   * 固定端口。
   *
   * 默认由 supervisor 找空闲端口——这是「不闪窗」的前提（端口一旦变化，
   * 页面就落在旧 origin 上）。只有浏览器模式下手动指定端口时才需要覆盖，
   * 此时端口冲突直接失败：换端口等于悄悄违背用户的明确要求。
   */
  port?: number
  /** 是否监听 worker 消息，测试时用 */
  onReady?: (payload: HandshakeLine) => void
  /** 输出目标，默认 process.stdout */
  stdout?: Pick<NodeJS.WriteStream, 'write'>
  log?: (line: string) => void
}

const log = createLoggerFactory({ level: 'info' })

/** 在 127.0.0.1 上找一个空闲端口，拿到后立刻释放。 */
export function findFreePort(): Promise<number> {
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

export function generateToken(): string {
  return randomBytes(32).toString('base64url')
}

export class Supervisor {
  private port = 0
  private token = ''
  private child: ReturnType<typeof fork> | undefined
  private stopping = false
  private portRetries = 0
  private started = false
  private readonly workerPath: string
  private readonly stdout: Pick<NodeJS.WriteStream, 'write'>
  private readonly version: string

  constructor(private readonly options: SupervisorOptions) {
    this.workerPath = options.workerPath ?? fileURLToPath(new URL('../worker/main.js', import.meta.url))
    this.stdout = options.stdout ?? process.stdout
    this.version = options.version ?? readVersion()
  }

  /** 分配端口与 token，然后 fork worker。返回最终监听端口。 */
  async start(): Promise<HandshakeLine> {
    if (this.options.port) {
      // 用户显式指定的端口：冲突就失败，不偷偷换一个
      this.port = this.options.port
      this.portRetries = MAX_PORT_RETRIES
    } else {
      this.port = await findFreePort()
    }
    this.token = generateToken()
    mkdirSync(resolveProjectLayout(this.options.projectRoot).cordisDir, { recursive: true })
    return this.spawn()
  }

  private spawn(): Promise<HandshakeLine> {
    return new Promise((resolve, reject) => {
      const child = fork(this.workerPath, [], {
        // 关键：worker 的 stdout 被 supervisor 吞掉，保证外壳看到的管道上
        // 只可能出现 supervisor 自己输出的握手行。
        silent: true,
        env: buildWorkerEnv({
          port: this.port,
          token: this.token,
          projectRoot: this.options.projectRoot,
          resourcesDir: this.options.resourcesDir,
          ...(this.options.serverEntry ? { serverEntry: this.options.serverEntry } : {}),
          ...(this.options.localPluginsDir ? { localPluginsDir: this.options.localPluginsDir } : {}),
          ...(this.options.dev ? { dev: true } : {}),
          version: this.version,
        }),
      })
      this.child = child

      // 必须同时消费 stdout 与 stderr：只读 stdout 会让 worker 阻塞在 write() 上，
      // 表现为「应用卡死但不报错」。
      child.stdout?.on('data', (chunk: Buffer) => this.forward('worker', chunk, 'stdout'))
      let stderrTail = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-4096)
        this.forward('worker', chunk, 'stderr')
      })

      child.on('message', (message: WorkerMessage) => {
        if (message?.type !== 'ready') return
        this.started = true
        this.portRetries = 0
        const line: HandshakeLine = {
          ready: true,
          port: message.port,
          token: this.token,
          version: this.version,
          failures: message.failures,
        }
        this.writeRuntimeFile(line)
        this.stdout.write(encodeHandshake(line) + '\n')
        this.options.onReady?.(line)
        resolve(line)
      })

      child.on('error', (error) => {
        if (!this.started) reject(error)
        else log.error('worker error', error)
      })

      child.on('exit', (code, signal) => {
        this.child = undefined
        if (this.stopping) return
        this.onExit(code, signal, stderrTail, reject)
      })
    })
  }

  private onExit(
    code: number | null,
    signal: string | null,
    stderrTail: string,
    reject: (error: Error) => void,
  ): void {
    if (code === EXIT_RESTART) {
      log.info('worker 请求重启，端口与 token 保持不变')
      this.spawn().catch((error) => log.error('重启失败', error))
      return
    }

    if (code === EXIT_PORT_IN_USE) {
      // 76 只允许出现在首次启动：重启阶段换端口会让页面落在旧 origin 上。
      if (this.started) {
        log.error('重启阶段端口被占用，这是致命错误，不自动恢复')
        process.exit(EXIT_PORT_IN_USE)
      }
      if (this.portRetries >= MAX_PORT_RETRIES) {
        log.error(`连续 ${MAX_PORT_RETRIES} 次端口冲突，放弃`)
        process.exit(EXIT_PORT_IN_USE)
      }
      this.portRetries += 1
      log.warn(`首次启动端口冲突，换一个端口重试（${this.portRetries}/${MAX_PORT_RETRIES}）`)
      findFreePort().then((port) => {
        this.port = port
        this.spawn().catch((error) => reject(error))
      })
      return
    }

    if (code === 0) {
      log.info('worker 正常退出')
      return
    }

    log.error(`worker 异常退出 code=${code} signal=${signal}\n${stderrTail}`)
    if (!this.started) reject(new Error(`worker 启动失败（exit ${code}）`))
  }

  /** 请求 worker 优雅重启（供 CLI / HTTP 安装流程调用）。 */
  restart(): void {
    this.child?.kill('SIGTERM')
    // worker 收到 SIGTERM 会走退出码 75 的路径；这里只是兜底
    setTimeout(() => this.child?.kill('SIGKILL'), 5000).unref()
  }

  /** 终止整棵进程树并退出。 */
  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    if (!child) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
      setTimeout(() => {
        child.kill('SIGKILL')
        resolve()
      }, 5000).unref()
    })
  }

  get handshakePort(): number {
    return this.port
  }

  /**
   * 转发 worker 的输出。
   *
   * worker 的 stdout 在正常路径上是空的（它用 IPC 报告就绪），这里只做兜底；
   * stderr 承载 worker 自己的日志，按行内已有的级别标签转发，避免把 INFO
   * 一律渲染成 ERROR。
   */
  private forward(label: string, chunk: Buffer, source: 'stdout' | 'stderr'): void {
    const text = chunk.toString().trimEnd()
    if (!text) return
    for (const line of text.split(/\r?\n/)) {
      const level = classifyLogLine(line)
      const rendered = `[${label}] ${line}`
      if (level === 'error') log.error(rendered)
      else if (level === 'warn') log.warn(rendered)
      else if (level === 'info') log.info(rendered)
      else if (source === 'stdout') log.debug(rendered)
      else log.debug(rendered)
    }
  }

  /** runtime.json 是派生文件：握手是推送，它是拉取。两者内容一致。 */
  private writeRuntimeFile(line: HandshakeLine): void {
    // 就绪字段与握手共用同一份归一化逻辑，避免两边各写一半导致字段漂移
    const readiness = handshakeOf(line)
    const file: RuntimeFile = {
      port: readiness.port,
      token: readiness.token,
      version: readiness.version,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }
    writeFileSync(resolveProjectLayout(this.options.projectRoot).runtimeFile, JSON.stringify(file, null, 2))
  }
}

/** 子进程环境变量由框架显式构造，不继承用户的 shell。 */
export function buildWorkerEnv(input: {
  port: number
  token: string
  projectRoot: string
  resourcesDir?: string
  serverEntry?: string
  localPluginsDir?: string
  dev?: boolean
  /** 框架版本；由 supervisor 注入，worker 据此生成 manifest 与 peer 校验 */
  version: string
}): NodeJS.ProcessEnv {
  const isWindows = process.platform === 'win32'
  const layout = resolveProjectLayout(input.projectRoot)
  const base: NodeJS.ProcessEnv = isWindows
    ? // Windows 上 PATH 不能只留 bin/：系统 DLL 的查找依赖 System32 等目录。
      { ...process.env }
    : { PATH: '', HOME: input.projectRoot, TMPDIR: layout.tmpDir }

  return {
    ...base,
    [ENV_PORT]: String(input.port),
    [ENV_TOKEN]: input.token,
    [ENV_PROJECT]: input.projectRoot,
    [ENV_VERSION]: input.version,
    ...(input.resourcesDir ? { [ENV_RESOURCES]: input.resourcesDir } : {}),
    ...(input.serverEntry ? { [ENV_SERVER_ENTRY]: input.serverEntry } : {}),
    ...(input.localPluginsDir ? { [ENV_LOCAL_PLUGINS]: input.localPluginsDir } : {}),
    ...(input.dev ? { [ENV_DEV]: '1' } : {}),
    // 用户 shell 里残留的调试或注入配置会污染 worker。
    NODE_OPTIONS: '',
    NODE_PATH: '',
  }
}

function readVersion(): string {
  // 版本只有 FRAMEWORK_VERSION 一个真源；聚合包的 package.json 在构建时生成它。
  return FRAMEWORK_VERSION
}

export type { PluginFailure }

/** 从日志行里认出级别标签。识别不出时按 debug 处理，不制造假警报。 */
function classifyLogLine(line: string): 'debug' | 'info' | 'warn' | 'error' {
  if (/\bERROR\b/.test(line)) return 'error'
  if (/\bWARN\b/.test(line)) return 'warn'
  if (/\bINFO\b/.test(line)) return 'info'
  return 'debug'
}
