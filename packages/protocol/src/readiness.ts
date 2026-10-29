/**
 * 「实例是否可用」的统一模型。
 *
 * 同一件事有三种载体：
 *   - supervisor → stdout 的握手行（推送）
 *   - supervisor → `runtime.json`（拉取）
 *   - worker 的 `/__health`（探测）
 *
 * 三方各自判断「ready」曾经演化出三套略有差异的逻辑：CLI 重启要等旧进程先
 * 下线，前端只需要等新进程起来，握手与 runtime.json 各校验一半字段。这里把
 * 「什么算就绪」与「怎么等」收敛到 protocol，消费者只提供探测手段。
 */

import type { HandshakeLine, PluginFailure, RuntimeFile } from './types.js'

/** 一个实例的可用状态。握手行与 runtime.json 都能归一到它。 */
export interface Readiness {
  port: number
  token: string
  version: string
  failures: PluginFailure[]
}

/** 握手行 → 就绪描述。握手只在完全就绪后发出，因此无需再判 ready。 */
export function handshakeOf(line: HandshakeLine): Readiness {
  return {
    port: line.port,
    token: line.token,
    version: line.version,
    failures: line.failures ?? [],
  }
}

/** runtime.json → 就绪描述。它是派生文件，不含加载失败列表。 */
export function runtimeFileOf(file: RuntimeFile): Readiness {
  return {
    port: file.port,
    token: file.token,
    version: file.version,
    failures: [],
  }
}

/**
 * 校验一个未知对象是否足以描述运行中的实例。
 *
 * `runtime.json` 被强杀后会残留，字段缺失或类型不对的文件必须当作「没在运行」，
 * 而不是带着 undefined 继续拼 URL。
 */
export function isRuntimeFile(value: unknown): value is RuntimeFile {
  if (!value || typeof value !== 'object') return false
  const file = value as Partial<RuntimeFile>
  return (
    typeof file.port === 'number' &&
    Number.isInteger(file.port) &&
    file.port > 0 &&
    typeof file.token === 'string' &&
    file.token.length > 0 &&
    typeof file.pid === 'number' &&
    typeof file.version === 'string' &&
    typeof file.startedAt === 'string'
  )
}

export interface WaitForReadyOptions {
  /** 探测一次：服务可用返回 true；连接被拒、超时等一律返回 false。 */
  probe(): Promise<boolean>
  /** 两次探测的间隔，默认 200ms */
  intervalMs?: number
  /** 总超时，默认 30 秒 */
  timeoutMs?: number
  /**
   * 是否先等一次「不可用」。
   *
   * 重启场景必须为 true：旧 worker 在关闭监听前仍会返回 200，直接把它当成
   * 「重启完成」会立刻返回一个假成功。首次启动则不需要。
   */
  requireDownFirst?: boolean
  /** 等待旧进程下线的上限，默认 10 秒 */
  downTimeoutMs?: number
  /** 注入时钟，测试用 */
  now?(): number
  /** 注入等待，测试用 */
  sleep?(ms: number): Promise<void>
}

/**
 * 轮询直到实例就绪（或超时）。
 *
 * 只关心「可用 / 不可用」这一个布尔量，不掺入 HTTP 细节——探测手段由调用方
 * 决定，CLI 用 fetch，测试用数组。两段式等待（先下线、再上线）也只写一次。
 */
export async function waitForReady(options: WaitForReadyOptions): Promise<boolean> {
  const interval = options.intervalMs ?? 200
  const timeoutMs = options.timeoutMs ?? 30_000
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs

  if (options.requireDownFirst) {
    const downDeadline = Math.min(deadline, now() + (options.downTimeoutMs ?? 10_000))
    while (now() < downDeadline) {
      if (!(await options.probe())) break
      await sleep(interval)
    }
  }

  while (now() < deadline) {
    if (await options.probe()) return true
    await sleep(interval)
  }
  return false
}
