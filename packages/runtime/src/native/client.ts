/**
 * 原生能力的 worker 侧 HTTP client。
 *
 * 只和外壳的回环 native server 说话：`GET /info` 在启动时读取一次并缓存，
 * `POST /invoke` 把命令映射成 HTTP 请求。业务结果（包括用户取消）一律在
 * envelope 里，HTTP 4xx/5xx 只表示 transport 或鉴权失败。
 *
 * 没有端点、`/info` 不可达或契约版本不匹配时 client 保持不可用状态；
 * 调用方拿到 `unsupported`，而不是启动失败。
 */

import {
  NATIVE_CONTRACT_VERSION,
  NATIVE_ERROR_CODES,
  type NativeCommand,
  type NativeErrorCode,
  type NativeInfo,
  type NativeInput,
  type NativeOutput,
  type NativeResult,
} from '@cordis-app/protocol'
import type { Logger } from '@cordis-app/kernel'

/** 非交互命令的默认 RPC 超时。 */
export const NATIVE_DEFAULT_TIMEOUT_MS = 5000

/** 启动时读取 `/info` 的上限；回环连接不该等太久。 */
export const NATIVE_CONNECT_TIMEOUT_MS = 5000

export interface NativeClientOptions {
  /** 外壳回环端点，例如 `http://127.0.0.1:4321`。 */
  url: string
  /** 原生 token；只存在于 worker 进程内。 */
  token: string
  /** 非交互命令的 RPC 超时（毫秒）；缺省 5 秒。 */
  timeoutMs?: number
}

/** 路径选择是交互命令：用户可能盯着对话框很久，不能按 RPC 超时打断。 */
function isInteractive(command: NativeCommand): boolean {
  return command.startsWith('path.choose')
}

export class NativeClient {
  private readonly base: string
  private readonly token: string
  private readonly timeoutMs: number
  private info: NativeInfo | undefined

  constructor(options: NativeClientOptions) {
    // 统一补尾斜杠，`new URL('info', base)` 才会保留端点可能已有的路径前缀。
    this.base = options.url.endsWith('/') ? options.url : `${options.url}/`
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? NATIVE_DEFAULT_TIMEOUT_MS
  }

  /** 只有 `/info` 通过契约校验后才为 true。 */
  get available(): boolean {
    return this.info !== undefined
  }

  /** 缓存的 `/info`；未连接时为 undefined。 */
  get current(): NativeInfo | undefined {
    return this.info
  }

  /** 当前平台真正可用的命令；未连接时为空。 */
  commands(): NativeCommand[] {
    return this.info ? [...this.info.commands] : []
  }

  /** 由 `connectNativeClient` 在校验通过后挂上缓存。 */
  attach(info: NativeInfo): void {
    this.info = info
  }

  /** 读取并校验 `/info`；失败时抛错，由调用方决定是否降级。 */
  async fetchInfo(): Promise<NativeInfo> {
    const response = await this.request('info', { method: 'GET' }, NATIVE_CONNECT_TIMEOUT_MS)
    if (!response.ok) throw new Error(`GET /info 返回 HTTP ${response.status}`)
    const info = (await response.json()) as NativeInfo
    if (
      !info ||
      typeof info !== 'object' ||
      typeof info.contractVersion !== 'number' ||
      !Array.isArray(info.commands)
    ) {
      throw new Error('GET /info 响应格式不正确')
    }
    return info
  }

  async invoke<C extends NativeCommand>(
    command: C,
    input: NativeInput<C>,
    options: { timeoutMs?: number } = {},
  ): Promise<NativeResult<C>> {
    if (!this.info) {
      return { ok: false, code: 'unsupported', message: '当前没有可用的原生外壳' }
    }

    // 交互类命令默认不设 RPC 超时；显式传入的 timeoutMs 对所有命令生效。
    const timeoutMs = options.timeoutMs ?? (isInteractive(command) ? undefined : this.timeoutMs)
    try {
      const response = await this.request(
        'invoke',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ command, input }),
        },
        timeoutMs,
      )
      if (!response.ok) {
        return { ok: false, code: 'internal', message: `原生服务返回 HTTP ${response.status}` }
      }
      return parseEnvelope<C>(await response.json())
    } catch (error) {
      if (isAbortError(error)) {
        return { ok: false, code: 'timeout', message: `原生命令 ${command} 超时（${timeoutMs}ms）` }
      }
      return {
        ok: false,
        code: 'internal',
        message: `原生命令 ${command} 失败：${(error as Error).message}`,
      }
    }
  }

  private async request(path: string, init: RequestInit, timeoutMs: number | undefined): Promise<Response> {
    const controller = new AbortController()
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await globalThis.fetch(new URL(path, this.base), {
        ...init,
        headers: {
          // 鉴权头永远由 client 写；调用方不能覆盖。
          ...init.headers,
          authorization: `Bearer ${this.token}`,
        },
        signal: controller.signal,
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * 连接外壳原生服务。
 *
 * 任何失败（不可达、响应格式不对、契约版本不匹配）都只让 client 保持
 * 不可用并记录告警；不抛错、不阻止 worker 启动。
 */
export async function connectNativeClient(
  options: NativeClientOptions,
  logger?: Logger,
): Promise<NativeClient> {
  const client = new NativeClient(options)
  try {
    const info = await client.fetchInfo()
    if (info.contractVersion !== NATIVE_CONTRACT_VERSION) {
      logger?.warn(
        `原生能力契约版本不匹配：外壳报告 ${info.contractVersion}，worker 期望 ${NATIVE_CONTRACT_VERSION}，已关闭原生能力`,
      )
      return client
    }
    client.attach(info)
  } catch (error) {
    logger?.warn(`原生服务不可用，原生能力已关闭：${(error as Error).message}`)
  }
  return client
}

function parseEnvelope<C extends NativeCommand>(body: unknown): NativeResult<C> {
  if (body && typeof body === 'object') {
    const envelope = body as Record<string, unknown>
    if (envelope.ok === true) {
      return { ok: true, value: envelope.value as NativeOutput<C> }
    }
    if (
      envelope.ok === false &&
      typeof envelope.code === 'string' &&
      (NATIVE_ERROR_CODES as readonly string[]).includes(envelope.code)
    ) {
      return {
        ok: false,
        code: envelope.code as NativeErrorCode,
        ...(typeof envelope.message === 'string' ? { message: envelope.message } : {}),
        ...(typeof envelope.platform === 'string' ? { platform: envelope.platform } : {}),
      }
    }
  }
  return { ok: false, code: 'internal', message: '原生服务返回了无法识别的响应' }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError'
}
