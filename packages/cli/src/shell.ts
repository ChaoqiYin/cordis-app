/**
 * `cordis-app dev --shell` 的进程侧实现。
 *
 * 命令行只负责编排：分配端口、起 Vite、调用这里启动外壳。这里负责
 * 「spawn 外壳 → 等 worker 健康 → 取会话 token」这一段，并把结果收敛成
 * 一个与浏览器模式同形的后端句柄。
 *
 * 外壳自己会拉起 supervisor 与 worker，所以 token 不在 CLI 手里生成，
 * 只能等 supervisor 写进 runtime.json 后读取。这正是打包形态的同一条链路：
 * 外壳靠握手拿 token，CLI 靠 runtime.json 拿 token。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForReady } from '@cordis-app/protocol'

/** 启动外壳所需的全部输入。路径由 CLI 算好，外壳不解析配置。 */
export interface ShellDevOptions {
  shellPath: string
  projectRoot: string
  resourcesDir?: string
  /** CLI 预留给 Vite 代理的固定 worker 端口 */
  workerPort: number
  /** Vite 地址；外壳会在后面拼上握手 token 作为窗口入口 */
  devUrl: string
  serverEntry: string
  localPluginsDir: string
  /** supervisor 写入的运行时文件，用于取会话 token */
  runtimeJsonPath: string
}

/** 外壳模式下的后端句柄，形状与 AppHandle 的最小生命周期一致。 */
export interface ShellDevBackend {
  restartWorker(): Promise<void>
  onExit(listener: (code: number | null) => void): () => void
  stop(): Promise<void>
}

/** 外壳定位结果。错误用返回值而不是抛异常，方便命令直接打印并返回退出码。 */
export type ShellLocation =
  | { path: string }
  | {
      error: string
      /** 默认产物路径缺失时为 true：CLI 可以尝试编译一次。 */
      canBuild: boolean
    }

/** 外壳编译结果。失败信息直接展示给用户，不再包一层异常。 */
export type ShellBuildResult = { ok: true } | { ok: false; error: string }

/**
 * 外壳在就绪前以 76 退出：它拿到了 worker 端口但监听失败。
 * 这类冲突在分配端口与真正监听之间必然存在一个窗口，CLI 负责换端口重试。
 */
export class ShellPortUnavailableError extends Error {}

/** 端口冲突时 supervisor 的退出码，与 runtime 的约定一致。 */
const PORT_UNAVAILABLE_EXIT_CODE = 76

const STARTUP_TIMEOUT_MS = 60_000
const TOKEN_TIMEOUT_MS = 3_000
const STOP_GRACE_MS = 5_000
/** 首次编译可能要下载 Go 依赖，给足时间，但避免无提示地永久挂起。 */
const SHELL_BUILD_TIMEOUT_MS = 300_000

/**
 * 找外壳可执行文件。
 *
 * 优先用 CORDIS_APP_SHELL；否则从 CLI 产物位置推仓库根，取 `dist` 下的
 * 构建产物。不猜当前工作目录：用户在哪个目录敲命令与外壳在哪无关。
 * 显式覆盖指向不存在的文件时不让 CLI 自动编译，避免把用户的配置错误
 * 静默改成「用别处的产物」。
 */
export function locateShell(): ShellLocation {
  const override = process.env.CORDIS_APP_SHELL
  if (override) {
    return existsSync(override)
      ? { path: override }
      : { error: `CORDIS_APP_SHELL 指向的文件不存在：${override}`, canBuild: false }
  }

  const here = dirname(fileURLToPath(import.meta.url))
  // lib/ → packages/cli → packages → 仓库根
  const repoRoot = join(here, '..', '..', '..')
  const exe = process.platform === 'win32' ? 'cordis-app.exe' : 'cordis-app'
  const candidate = join(repoRoot, 'dist', exe)
  return existsSync(candidate)
    ? { path: candidate }
    : {
        error: `找不到桌面外壳：${candidate}`,
        canBuild: true,
      }
}

/**
 * 编译外壳二进制，等价于根目录的 `pnpm build:shell`。
 *
 * 只编译 Go，不构建前端资源：开发形态的前端由 Vite 提供。Go 工具链或
 * 源码不可用时返回可展示的错误，由命令决定是提示手动构建还是直接退出。
 */
export async function buildShell(): Promise<ShellBuildResult> {
  const here = dirname(fileURLToPath(import.meta.url))
  const repoRoot = join(here, '..', '..', '..')
  const shellDir = join(repoRoot, 'packages', 'shell')
  if (!existsSync(join(shellDir, 'go.mod'))) {
    return { ok: false, error: `找不到外壳源码目录：${shellDir}` }
  }

  const exe = process.platform === 'win32' ? 'cordis-app.exe' : 'cordis-app'
  const output = join(repoRoot, 'dist', exe)
  mkdirSync(dirname(output), { recursive: true })

  return new Promise<ShellBuildResult>((resolve) => {
    const child = spawn('go', ['build', '-o', output, '.'], {
      cwd: shellDir,
      stdio: 'inherit',
    })
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const finish = (result: ShellBuildResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: `编译外壳超时（${SHELL_BUILD_TIMEOUT_MS / 1000} 秒）` })
    }, SHELL_BUILD_TIMEOUT_MS)
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        error:
          error.code === 'ENOENT'
            ? '找不到 go 命令。安装 Go 1.25 后重试，或直接执行 pnpm build:shell。'
            : `无法启动 go build：${error.message}`,
      })
    })
    child.once('exit', (code) => {
      finish(
        code === 0
          ? { ok: true }
          : { ok: false, error: `go build 失败（exit ${code ?? 'null'}）` },
      )
    })
  })
}

/** 默认的外壳启动实现：spawn、等 worker 健康、读 runtime token。 */
export async function startShellDev(options: ShellDevOptions): Promise<ShellDevBackend> {
  const child = spawn(options.shellPath, shellArguments(options), {
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  // exit 与 error 都可能先发生；谁先到谁决定启动结果。
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null))
    child.once('exit', (code) => resolve(code))
  })

  const healthy = waitWorkerHealthy(options.workerPort)
  const startup = await Promise.race([
    healthy.then((ok) => ({ kind: 'probe' as const, ok })),
    exited.then((code) => ({ kind: 'exit' as const, code })),
  ])

  if (startup.kind === 'exit') {
    if (startup.code === PORT_UNAVAILABLE_EXIT_CODE) {
      throw new ShellPortUnavailableError(`外壳未能监听端口 ${options.workerPort}`)
    }
    throw new Error(
      startup.code === null
        ? '无法启动桌面外壳'
        : `桌面外壳在就绪前退出（exit ${startup.code}）`,
    )
  }
  if (!startup.ok) {
    child.kill()
    throw new Error(`等待 worker 就绪超时（端口 ${options.workerPort}）`)
  }

  // health 200 与 supervisor 写 runtime.json 几乎同时；给一点点重试余量。
  // 读不到 token 不阻止启动，只是后续 worker 重启会明确报错。
  const token = await waitRuntimeToken(options.runtimeJsonPath, options.workerPort)

  let stopping = false
  return {
    async restartWorker() {
      if (!token) throw new Error('尚未取得会话 token，无法重启 worker')
      const response = await fetch(`http://127.0.0.1:${options.workerPort}/api/restart`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      if (!response.ok) throw new Error(`重启请求失败：HTTP ${response.status}`)
    },

    onExit(listener) {
      let active = true
      void exited.then((code) => {
        if (active) listener(code)
      })
      return () => {
        active = false
      }
    },

    async stop() {
      if (stopping) return
      stopping = true
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_GRACE_MS)),
      ])
      if (timedOut) child.kill('SIGKILL')
    },
  }
}

/**
 * 外壳参数。
 *
 * `--data` 在开发形态就是项目根（壳不区分「数据目录」与「项目目录」）。
 * `--dev-ui` 不带 token：入口地址由外壳用握手 token 自己拼，token 只流动一次。
 */
export function shellArguments(options: ShellDevOptions): string[] {
  const args = ['--data', options.projectRoot]
  if (options.resourcesDir) args.push('--resources', options.resourcesDir)
  args.push(
    '--worker-port',
    String(options.workerPort),
    '--dev-ui',
    options.devUrl,
    '--server-entry',
    options.serverEntry,
    '--local-plugins',
    options.localPluginsDir,
    '--dev',
  )
  return args
}

async function waitWorkerHealthy(port: number): Promise<boolean> {
  return waitForReady({
    timeoutMs: STARTUP_TIMEOUT_MS,
    probe: async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/__health`, {
          signal: AbortSignal.timeout(1000),
        })
        return response.ok
      } catch {
        // 外壳还没把 worker 拉起来，连接被拒绝是预期状态
        return false
      }
    },
  })
}

async function waitRuntimeToken(path: string, port: number): Promise<string | undefined> {
  const deadline = Date.now() + TOKEN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const token = readRuntimeToken(path, port)
    if (token) return token
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  return undefined
}

/** 只接受端口匹配的文件：上一轮运行残留的 runtime.json 不能拿来当凭据。 */
function readRuntimeToken(path: string, port: number): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { port?: unknown; token?: unknown }
    if (parsed.port !== port) return undefined
    return typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : undefined
  } catch {
    return undefined
  }
}
