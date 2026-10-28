/**
 * 前端 HTTP 封装（基于 axios 的一层薄壳）。
 *
 * token 的注入点只有这一个：插件不必自己拼 Authorization 头，
 * 未来加固时也不需要改每个插件（架构文档 5.2）。
 *
 * 另外承担重启期间的等待：`/__health` 不通时自动重试，而不是把 503 抛给插件。
 */

import axios, { type AxiosInstance } from 'axios'
import { HEALTH_PATH, TOKEN_FRAGMENT_KEY } from '@cordis-app/protocol/client'
import type { HttpClient, RequestConfig } from './types.js'

const TOKEN_STORAGE_KEY = 'cordis-app/token'

/** token 从 URL fragment 读一次，存入 sessionStorage，然后从地址栏抹掉。 */
export function bootstrapToken(): string {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  const fromHash = new URLSearchParams(hash).get(TOKEN_FRAGMENT_KEY)
  if (fromHash) {
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, fromHash)
    } catch {
      // 隐私模式下 sessionStorage 可能不可用；退回内存
      memoryToken = fromHash
    }
    // fragment 不会进入服务端日志，也不随 Referer 外泄；读完即抹掉
    history.replaceState(null, '', window.location.pathname + window.location.search)
    return fromHash
  }

  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? memoryToken ?? ''
  } catch {
    return memoryToken ?? ''
  }
}

let memoryToken: string | undefined

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export function createHttp(token: string): HttpClient {
  const instance: AxiosInstance = axios.create({
    // 同源请求：页面和后端在同一个 origin，不需要 baseURL
    timeout: 30_000,
  })

  instance.interceptors.request.use((config) => {
    config.headers.set('authorization', `Bearer ${token}`)
    return config
  })

  instance.interceptors.response.use(
    (response) => response,
    async (error) => {
      const status = error.response?.status
      const payload = error.response?.data
      if (status) {
        throw new HttpError(payload?.message ?? error.message, status, payload?.code ?? 'http_error')
      }
      throw new HttpError(error.message, 0, 'network_error')
    },
  )

  const call = async <T>(method: 'get' | 'post' | 'put' | 'delete', url: string, data?: unknown, config?: RequestConfig): Promise<T> => {
    const retries = config?.retries ?? 0
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await instance.request<T>({
          method,
          url,
          ...(method === 'get' || method === 'delete' ? { params: data } : { data }),
          ...(config?.timeout ? { timeout: config.timeout } : {}),
          ...(config?.signal ? { signal: config.signal } : {}),
        })
        return response.data
      } catch (error) {
        lastError = error
        // 只对网络错误与 5xx 重试；4xx 是确定性失败，重试没有意义
        const status = error instanceof HttpError ? error.status : 0
        if (attempt < retries && (status === 0 || status >= 500)) {
          await new Promise((r) => setTimeout(r, 200 * (attempt + 1)))
          continue
        }
        throw error
      }
    }
    throw lastError
  }

  return {
    get: (url, config) => call('get', url, undefined, config),
    post: (url, data, config) => call('post', url, data, config),
    put: (url, data, config) => call('put', url, data, config),
    delete: (url, config) => call('delete', url, undefined, config),
  }
}

/**
 * 轮询 /__health 直到服务恢复。
 *
 * 重启期间旧 WebSocket 连接随旧进程一起消失，前端此刻处于「不知道什么时候好」
 * 的盲区，所以用轮询而不是等重连（架构文档 6.3）。间隔 200ms，上限 30 秒。
 */
export async function waitForHealthy(options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const interval = options.intervalMs ?? 200
  const deadline = Date.now() + (options.timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_PATH, { cache: 'no-store' })
      if (res.ok) return true
    } catch {
      // 服务还没起来，继续等
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}
