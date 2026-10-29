/**
 * WebSocket 连接与重连。
 *
 * 重连链路：
 *   worker 关闭监听 → 广播 server:reconnect → 前端进入等待态 → 轮询 /__health
 *   → 服务恢复后重连
 *
 * 轮询而不是等 WS 自己重连，是因为旧连接随旧进程一起消失了，此刻前端处于
 * 「不知道什么时候好」的盲区。轮询 /__health 是唯一不依赖 token 的探测手段。
 *
 * 与浏览器绑定的能力（WebSocket、fetch、时钟、定时器）全部收在 `Transport`
 * 端口后面。状态机本身因此可以在 Node 里用假传输完整测试——重连是整条链路里
 * 最难手工复现、也最容易悄悄回归的部分，不能只靠「重启一次看看」。
 */

import { HEALTH_PATH, RECONNECT_EVENT, WS_PATH } from '@cordis-app/protocol/client'
import type { ClientRuntime } from './runtime.js'

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'failed'

export interface Connection {
  close(): void
  onStateChange(listener: (state: ConnectionState) => void): () => void
  /** 服务恢复后触发；监听者在这里重新拉清单并重放插件加载。 */
  onReconnected(listener: () => void | Promise<void>): () => void
}

/** 一条 WebSocket 连接的四个观察点。适配器负责把它映射到真实的 WebSocket。 */
export interface TransportSocket {
  onOpen(listener: () => void): void
  onMessage(listener: (data: string) => void): void
  onClose(listener: () => void): void
  close(): void
}

/**
 * 连接状态机的全部外部依赖。
 *
 * 接口只描述状态机需要知道的事实：怎么开连接、怎么探测健康、怎么等待、现在几点。
 * URL 怎么拼、token 放哪里，都是适配器的内部细节。
 */
export interface Transport {
  open(token: string): TransportSocket
  /** 探测服务是否已恢复到可服务状态。实现应当自行吞掉网络错误并返回 false。 */
  probe(): Promise<boolean>
  wait(ms: number): Promise<void>
  /** 单调时钟，用于计算轮询截止时间。 */
  now(): number
}

/** 指数退避：重启通常 1~3 秒，前几次探测要密，后面放宽避免空转。 */
const RETRY_DELAYS = [200, 400, 800, 1600, 3200]
const MAX_WAIT_MS = 30_000

/** 浏览器适配器：同源 WebSocket + `/__health` 探测。 */
export function browserTransport(): Transport {
  return {
    open(token) {
      const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      // 浏览器的 WebSocket 构造器不能设请求头，token 只能走查询串
      const socket = new WebSocket(
        `${scheme}//${window.location.host}${WS_PATH}?channel=default&token=${encodeURIComponent(token)}`,
      )
      return {
        onOpen: (listener) => socket.addEventListener('open', () => listener()),
        onMessage: (listener) =>
          socket.addEventListener('message', (event) => listener(String(event.data))),
        onClose: (listener) => socket.addEventListener('close', () => listener()),
        close: () => socket.close(),
      }
    },
    async probe() {
      try {
        const res = await fetch(HEALTH_PATH, { cache: 'no-store' })
        return res.ok
      } catch {
        // 服务还没起来，继续等
        return false
      }
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
}

export function connect(runtime: ClientRuntime, transport: Transport = browserTransport()): Connection {
  let state: ConnectionState = 'connecting'
  let socket: TransportSocket | null = null
  let closed = false

  const stateListeners = new Set<(state: ConnectionState) => void>()
  const reconnectedListeners = new Set<() => void | Promise<void>>()

  const setState = (next: ConnectionState) => {
    if (state === next) return
    state = next
    for (const listener of stateListeners) listener(next)
  }

  /**
   * 轮询 /__health 直到服务恢复。
   *
   * 恢复后先通知监听者重新加载清单，再重连 WebSocket——顺序反了会让插件在新
   * 清单到达前就收到推送，出现「有事件但页面还没注册」的空窗。
   */
  const waitForRecovery = async () => {
    const deadline = transport.now() + MAX_WAIT_MS
    let attempt = 0
    while (!closed && transport.now() < deadline) {
      let healthy = false
      try {
        healthy = await transport.probe()
      } catch {
        // 适配器原则上不该抛；抛了也按「还没好」处理，不能让重连整个停摆
        healthy = false
      }
      if (closed) return
      if (healthy) {
        setState('connecting')
        for (const listener of reconnectedListeners) await listener()
        open()
        return
      }
      const delay = RETRY_DELAYS[Math.min(attempt++, RETRY_DELAYS.length - 1)]!
      await transport.wait(delay)
    }
    if (!closed) setState('failed')
  }

  /**
   * 连接掉线的唯一入口。
   *
   * `from` 是掉线的那条连接：主动关闭旧连接后，它的 close 事件仍会迟到。
   * 不比对身份的话，迟到的 close 会把刚建好的新连接置空，并再启动一轮轮询。
   */
  const onDrop = (from: TransportSocket) => {
    if (closed || from !== socket) return
    socket = null
    if (state === 'reconnecting') return
    setState('reconnecting')
    void waitForRecovery()
  }

  const onMessage = (from: TransportSocket, data: string) => {
    if (closed || from !== socket) return
    let payload: { type?: string }
    try {
      payload = JSON.parse(data) as { type?: string }
    } catch {
      return
    }
    if (payload.type !== RECONNECT_EVENT) return
    // 服务端即将关闭：主动断开，把重连交给轮询，避免撞上正在关闭的进程
    setState('reconnecting')
    socket = null
    from.close()
    void waitForRecovery()
  }

  const open = () => {
    if (closed) return
    // current 固定住这条连接的身份：所有回调都带着它回来，迟到的旧连接事件因此可被忽略
    const current = transport.open(runtime.token)
    socket = current
    current.onOpen(() => {
      if (!closed && current === socket) setState('ready')
    })
    current.onMessage((data) => onMessage(current, data))
    current.onClose(() => onDrop(current))
  }

  open()

  return {
    close() {
      closed = true
      socket?.close()
      socket = null
    },
    onStateChange(listener) {
      stateListeners.add(listener)
      return () => {
        stateListeners.delete(listener)
      }
    },
    onReconnected(listener) {
      reconnectedListeners.add(listener)
      return () => {
        reconnectedListeners.delete(listener)
      }
    },
  }
}
