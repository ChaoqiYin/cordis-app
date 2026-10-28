/**
 * WebSocket 连接与重连。
 *
 * 架构文档 6.3 的链路：
 *   worker 关闭监听 → 广播 server:reconnect → 前端进入等待态 → 轮询 /__health
 *   → 服务恢复后重连
 *
 * 轮询而不是等 WS 自己重连，是因为旧连接随旧进程一起消失了，此刻前端处于
 * 「不知道什么时候好」的盲区。轮询 /__health 是唯一不依赖 token 的探测手段。
 */

import { HEALTH_PATH, RECONNECT_EVENT, WS_PATH } from '@cordis-app/protocol/client'
import type { ClientRuntime } from 'cordis-app/client'

export type ConnectionState = 'connecting' | 'ready' | 'reconnecting' | 'failed'

export interface Connection {
  close(): void
  onStateChange(listener: (state: ConnectionState) => void): () => void
  /** 服务恢复后触发；监听者在这里重新拉清单并重放插件加载。 */
  onReconnected(listener: () => void | Promise<void>): () => void
}

/** 指数退避：重启通常 1~3 秒，前几次探测要密，后面放宽避免空转。 */
const RETRY_DELAYS = [200, 400, 800, 1600, 3200]
const MAX_WAIT_MS = 30_000

export function connect(runtime: ClientRuntime): Connection {
  let state: ConnectionState = 'connecting'
  let socket: WebSocket | null = null
  let closed = false

  const stateListeners = new Set<(state: ConnectionState) => void>()
  const reconnectedListeners = new Set<() => void | Promise<void>>()

  const setState = (next: ConnectionState) => {
    if (state === next) return
    state = next
    for (const listener of stateListeners) listener(next)
  }

  const url = () => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // 浏览器的 WebSocket 构造器不能设请求头，token 只能走查询串
    return `${protocol}//${window.location.host}${WS_PATH}?channel=default&token=${encodeURIComponent(runtime.token)}`
  }

  /**
   * 轮询 /__health 直到服务恢复。
   *
   * 恢复后先通知监听者重新加载清单，再重连 WebSocket——顺序反了会让插件在新
   * 清单到达前就收到推送，出现「有事件但页面还没注册」的空窗。
   */
  const waitForRecovery = async () => {
    const deadline = Date.now() + MAX_WAIT_MS
    let attempt = 0
    while (!closed && Date.now() < deadline) {
      try {
        const res = await fetch(HEALTH_PATH, { cache: 'no-store' })
        if (res.ok) {
          setState('connecting')
          for (const listener of reconnectedListeners) await listener()
          open()
          return
        }
      } catch {
        // 服务还没起来，继续等
      }
      const delay = RETRY_DELAYS[Math.min(attempt++, RETRY_DELAYS.length - 1)]!
      await sleep(delay)
    }
    if (!closed) setState('failed')
  }

  const onDrop = () => {
    socket = null
    if (closed || state === 'reconnecting') return
    setState('reconnecting')
    void waitForRecovery()
  }

  const open = () => {
    if (closed) return
    socket = new WebSocket(url())

    socket.addEventListener('open', () => setState('ready'))

    socket.addEventListener('message', (event) => {
      let payload: { type?: string }
      try {
        payload = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (payload.type !== RECONNECT_EVENT) return
      // 服务端即将关闭：主动断开，把重连交给轮询，避免撞上正在关闭的进程
      setState('reconnecting')
      const pending = socket
      socket = null
      pending?.close()
      void waitForRecovery()
    })

    // error 之后必然跟着 close，重连逻辑只写在 close 里，避免双触发
    socket.addEventListener('close', onDrop)
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
