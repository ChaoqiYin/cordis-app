/**
 * 程序化启动入口。
 *
 * supervisor 永远是子进程：`startApp()` 只负责拉起、读取握手、转发事件和
 * 管理生命周期。把 worker 放进当前进程会让退出码 75/76、重启和崩溃隔离
 * 全部失效——而这套语义正是「页面不闪窗」的基础。
 *
 * 子进程契约只有一条：supervisor 的 stdout 上出现 `@@CORDIS_APP@@{...}`。
 * 其余人类可读日志走 stderr，由这里可选地转发。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  ENV_VERSION,
  EXIT_PORT_IN_USE,
  EXIT_RESTART,
  HANDSHAKE_PREFIX,
  decodeHandshake,
  type HandshakeLine,
  type PluginFailure,
  type RuntimeMode,
} from '@cordis-app/protocol'

/** supervisor 子进程的最小结构；测试可以注入一个假的实现。 */
export interface SupervisorChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export interface SpawnSupervisorOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio?: 'pipe' | 'ignore' | 'inherit' | Array<'pipe' | 'ignore' | 'inherit'>
}

/** 注入点：默认用 node:child_process.spawn 拉起 supervisor 入口。 */
export type SpawnSupervisor = (
  command: string,
  args: string[],
  options: SpawnSupervisorOptions,
) => SupervisorChild

export interface StartAppOptions {
  /** 项目根。所有路径与运行时文件都以它为准。 */
  projectRoot: string
  /** 覆盖 resources 根；`cordis-app start` 指向 `<project>/dist/resources` */
  resourcesDir?: string
  /** 覆盖项目 server 入口；`cordis-app start` 指向 `<project>/dist/server/index.js` */
  serverEntry?: string
  /** 覆盖项目本地插件根；`cordis-app dev` 指向现场构建的 `.cordis/dev/plugins` */
  localPluginsDir?: string
  /**
   * 打包形态的可写用户插件根；`cordis-app start` 指向项目可写数据目录下的
   * `plugins/`。worker 用 `dirname(userPluginsDir)` 作为用户数据根。
   */
  userPluginsDir?: string
  /** 运行形态；缺省 `project`。打包形态只接受签名插件包。 */
  mode?: RuntimeMode
  /** 固定端口；缺省由 supervisor 找空闲端口 */
  port?: number
  /** 框架版本覆盖（测试/嵌入场景） */
  version?: string
  /** 开发模式：插件前端 URL 用时间戳做缓存键 */
  dev?: boolean
  /** 启动超时，默认 15 秒 */
  timeoutMs?: number
  /** 停止时等待 SIGTERM 的宽限期，默认 5 秒 */
  stopTimeoutMs?: number
  /** 覆盖 supervisor 入口文件，测试时使用 */
  supervisorPath?: string
  /** 注入 spawn 实现 */
  spawn?: SpawnSupervisor
  /** stderr 转发目标；默认 process.stderr */
  stderr?: Pick<NodeJS.WriteStream, 'write'>
  /** supervisor 的 stdout 不是握手时（例如调试输出）的去处；默认丢弃 */
  stdout?: Pick<NodeJS.WriteStream, 'write'>
}

export interface AppExitEvent {
  code: number | null
  signal: NodeJS.Signals | null
  /** true 表示由 stop()/restart() 触发，不是异常退出 */
  expected: boolean
}

export interface AppEvents {
  ready: HandshakeLine
  'plugin-failure': PluginFailure
  exit: AppExitEvent
}

export interface AppHandle {
  /** 带 token fragment 的访问地址 */
  readonly url: string
  readonly token: string
  readonly port: number
  /** 停止 supervisor 并等待退出；幂等 */
  stop(): Promise<void>
  /** 先停后起。端口与 token 会随新 supervisor 变化。 */
  restart(): Promise<void>
  /**
   * 请求 worker 优雅重启（退出码 75）。
   *
   * 端口、token 与 supervisor 都不变，前端靠既有 WebSocket 重连语义恢复。
   * `dev` 用它响应服务端文件变化。
   */
  restartWorker(): Promise<void>
  on<E extends keyof AppEvents>(event: E, listener: (payload: AppEvents[E]) => void): () => void
}

/** 启动失败时带上退出码与阶段，调用方能区分超时、端口占用与异常退出。 */
export class StartAppError extends Error {
  readonly exitCode?: number
  readonly kind: 'spawn' | 'timeout' | 'exit' | 'startup'

  constructor(
    message: string,
    options: { exitCode?: number; kind: 'spawn' | 'timeout' | 'exit' | 'startup'; cause?: unknown } = {
      kind: 'startup',
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'StartAppError'
    this.exitCode = options.exitCode
    this.kind = options.kind
  }
}

/**
 * 启动应用。
 *
 * 返回时已经收到 supervisor 的握手行：`url` / `token` / `port` 可直接使用。
 * 启动失败（超时、端口占用、就绪前退出）会 reject，不会留下孤儿进程。
 */
export async function startApp(options: StartAppOptions): Promise<AppHandle> {
  const emitter = new EventEmitter<AppEvents>()
  const timeoutMs = options.timeoutMs ?? 15_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000
  const spawnImpl = options.spawn ?? defaultSpawn
  const supervisorPath =
    options.supervisorPath ??
    fileURLToPath(new URL('./supervisor/main.js', import.meta.url))
  const stderr = options.stderr ?? process.stderr
  const stdout = options.stdout

  let child: SupervisorChild | undefined
  let stopping = false
  let restarting = false
  let expectedExit = false
  let state: HandshakeLine | undefined
  let stderrTail = ''
  let lastExit: AppExitEvent | undefined
  const pastFailures: PluginFailure[] = []

  const args = ['--project', options.projectRoot]
  if (options.resourcesDir) args.push('--resources', options.resourcesDir)
  if (options.serverEntry) args.push('--server-entry', options.serverEntry)
  if (options.localPluginsDir) args.push('--local-plugins', options.localPluginsDir)
  if (options.userPluginsDir) args.push('--user-plugins', options.userPluginsDir)
  if (options.mode) args.push('--mode', options.mode)
  if (options.dev) args.push('--dev')

  const emitExit = (event: AppExitEvent): void => {
    lastExit = event
    emitter.emit('exit', event)
  }

  async function launch(): Promise<HandshakeLine> {
    expectedExit = false
    stderrTail = ''

    let spawned: SupervisorChild
    try {
      spawned = spawnImpl(process.execPath, [supervisorPath, ...args], {
        cwd: options.projectRoot,
        env: {
          ...process.env,
          // supervisor 没有 --version 参数；版本通过环境注入，避免再造一个真源。
          ...(options.version ? { [ENV_VERSION]: options.version } : {}),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new StartAppError(`无法启动 supervisor：${(error as Error).message}`, {
        kind: 'spawn',
        cause: error,
      })
    }
    child = spawned

    return new Promise<HandshakeLine>((resolve, reject) => {
      let settled = false
      let buffer = ''
      let timer: ReturnType<typeof setTimeout> | undefined

      const fail = (error: StartAppError): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        reject(error)
      }

      const handleStdoutLine = (line: string): void => {
        const trimmed = line.trim()
        if (!trimmed) return
        if (!trimmed.startsWith(HANDSHAKE_PREFIX)) {
          // 非握手行不是错误：supervisor 的日志本应按约定走 stderr。
          stdout?.write(trimmed + '\n')
          return
        }
        const payload = decodeHandshake(trimmed)
        if (!payload) {
          stdout?.write(trimmed + '\n')
          return
        }
        if (settled) {
          // 第二次握手来自 supervisor 内部的 worker 重启；supervisor 进程
          // 本身没有退出，因此 handle 的端口/token 不变，也不再发 ready。
          state = payload
          return
        }
        settled = true
        if (timer) clearTimeout(timer)
        state = payload
        for (const failure of payload.failures) {
          pastFailures.push(failure)
          emitter.emit('plugin-failure', failure)
        }
        emitter.emit('ready', payload)
        resolve(payload)
      }

      timer = setTimeout(() => {
        // 超时必须有可读错误，并且不能留下一个继续占用端口的进程。
        fail(
          new StartAppError(`启动超时（${timeoutMs}ms 内没有收到 supervisor 握手）`, {
            kind: 'timeout',
          }),
        )
        spawned.kill('SIGTERM')
      }, timeoutMs)

      spawned.stdout?.on('data', (chunk) => {
        buffer += chunk.toString()
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          handleStdoutLine(line)
          newline = buffer.indexOf('\n')
        }
      })

      spawned.stderr?.on('data', (chunk) => {
        const text = chunk.toString()
        stderrTail = (stderrTail + text).slice(-4096)
        stderr.write(text)
      })

      spawned.on('error', (error) => {
        fail(
          new StartAppError(`supervisor 启动失败：${error.message}`, {
            kind: 'spawn',
            cause: error,
          }),
        )
      })

      spawned.on('exit', (code, signal) => {
        child = undefined
        const expected = expectedExit || stopping
        if (!settled) {
          const error = exitError(code, signal, stderrTail)
          settled = true
          if (timer) clearTimeout(timer)
          reject(error)
          emitExit({ code, signal, expected })
          return
        }
        emitExit({ code, signal, expected })
      })
    })
  }

  await launch()
  if (!state) throw new StartAppError('supervisor 握手成功但缺少就绪状态', { kind: 'startup' })

  const stopChild = (): Promise<void> => {
    const current = child
    if (!current) return Promise.resolve()
    expectedExit = true
    return new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(grace)
        resolve()
      }
      current.on('exit', () => finish())
      const grace = setTimeout(() => {
        current.kill('SIGKILL')
        // SIGKILL 之后仍然给事件循环一个机会；不能再无限等待。
        setTimeout(finish, 100).unref()
      }, stopTimeoutMs)
      grace.unref()
      current.kill('SIGTERM')
    })
  }

  /**
   * 所有并发 stop/restart 共享同一次等待。
   *
   * 若第二个 stop() 自己再调一次 stopChild()，会重复发 SIGTERM、重复挂 exit
   * 监听；若它看到 child 已被置空就立即 resolve，又会在第一个 stop() 仍等待
   * 时提前返回。缓存 Promise 让两边的「已停止」是同一个事实。
   */
  let stopPromise: Promise<void> | undefined
  const stopChildShared = (): Promise<void> => {
    if (!stopPromise) {
      const pending = stopChild().finally(() => {
        if (stopPromise === pending) stopPromise = undefined
      })
      stopPromise = pending
    }
    return stopPromise
  }

  const handle: AppHandle = {
    get url() {
      return state ? accessUrl(state.port, state.token) : ''
    },
    get token() {
      return state?.token ?? ''
    },
    get port() {
      return state?.port ?? 0
    },
    async stop() {
      // 幂等：重复或并发的 stop() 等的是同一个子进程退出。
      stopping = true
      await stopChildShared()
    },
    async restart() {
      if (restarting) return
      restarting = true
      try {
        await stopChildShared()
        const payload = await launch()
        state = payload
      } finally {
        restarting = false
      }
    },
    async restartWorker() {
      const current = state
      if (!current) throw new StartAppError('应用尚未就绪，无法重启 worker', { kind: 'startup' })
      let response: Response
      try {
        response = await fetch(`http://127.0.0.1:${current.port}/api/restart`, {
          method: 'POST',
          headers: { authorization: `Bearer ${current.token}` },
          signal: AbortSignal.timeout(5_000),
        })
      } catch (error) {
        // AbortSignal 的超时、连接被拒都统一成 StartAppError，调用方只按
        // `kind` 分支，不需要认识 DOMException / TimeoutError。
        throw new StartAppError(`重启 worker 失败：${(error as Error).message}`, {
          kind: 'startup',
          cause: error,
        })
      }
      if (!response.ok) {
        throw new StartAppError(`重启 worker 失败：HTTP ${response.status}`, { kind: 'startup' })
      }
      // supervisor 会在 worker 退出码 75 后重新 fork，端口与 token 保持不变。
    },
    on(event, listener) {
      const off = emitter.on(event, listener)
      // 就绪事件可能早于调用方拿到 handle；补发一次，避免消费者永远等不到。
      if (event === 'ready' && state) {
        queueMicrotask(() => {
          if (state) (listener as (payload: HandshakeLine) => void)(state)
        })
      }
      if (event === 'exit' && lastExit) {
        const last = lastExit
        queueMicrotask(() => (listener as (payload: AppExitEvent) => void)(last))
      }
      if (event === 'plugin-failure') {
        const failures = [...pastFailures]
        queueMicrotask(() => {
          for (const failure of failures) (listener as (payload: PluginFailure) => void)(failure)
        })
      }
      return off
    },
  }

  return handle
}

function defaultSpawn(
  command: string,
  args: string[],
  options: SpawnSupervisorOptions,
): SupervisorChild {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: options.stdio as any,
  })
  return child as unknown as SupervisorChild
}

function accessUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`
}

function exitError(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderrTail: string,
): StartAppError {
  const detail = stderrTail.trim() ? `\n${stderrTail.trim()}` : ''
  if (code === EXIT_PORT_IN_USE) {
    return new StartAppError(`端口被占用（退出码 ${EXIT_PORT_IN_USE}）。换一个 --port 或先释放端口。${detail}`, {
      kind: 'exit',
      exitCode: code,
    })
  }
  if (code === EXIT_RESTART) {
    return new StartAppError(`supervisor 在就绪前以退出码 ${EXIT_RESTART} 退出，重启语义只适用于 worker。${detail}`, {
      kind: 'exit',
      exitCode: code,
    })
  }
  if (code === 0) {
    return new StartAppError(`supervisor 在收到握手前正常退出（exit 0）。${detail}`, {
      kind: 'exit',
      exitCode: code,
    })
  }
  const reason = signal ? `signal ${signal}` : `exit ${code}`
  return new StartAppError(`supervisor 在就绪前异常退出（${reason}）。${detail}`, {
    kind: 'exit',
    ...(code === null ? {} : { exitCode: code }),
  })
}

/** 极简事件发射器：只需要 on/emit，避免 EventEmitter 的事件名类型断言。 */
class EventEmitter<Events extends { [K in keyof Events]: unknown }> {
  private readonly listeners = new Map<keyof Events, Set<(payload: never) => void>>()

  on<E extends keyof Events>(event: E, listener: (payload: Events[E]) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener as (payload: never) => void)
    this.listeners.set(event, set)
    return () => {
      set.delete(listener as (payload: never) => void)
    }
  }

  emit<E extends keyof Events>(event: E, payload: Events[E]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) (listener as (value: Events[E]) => void)(payload)
  }
}
