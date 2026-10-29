/**
 * ws 内置插件：WebSocket 推送。
 *
 * 连接在 URL 中携带 token（`?token=`），因为浏览器的 WebSocket 构造器
 * 无法设置自定义请求头。
 *
 * 「即将重连」通知是重启链路的一部分：worker 关闭监听后先广播它，
 * 前端随即进入等待态并轮询 /__health。
 */

import { WebSocketServer, type WebSocket } from 'ws'
import type { KernelContext, WebSocketService, BroadcastMessage } from '@cordis-app/kernel'
import type { Server } from 'node:http'

interface Client {
  socket: WebSocket
  channel: string
}

// 依赖声明：cordis 在服务就绪前不会执行 apply，避免读到 undefined。
apply.inject = ['server', 'auth', 'logger']

export function apply(ctx: KernelContext) {
  const clients = new Set<Client>()
  const handlers = new Map<string, Set<(message: BroadcastMessage) => void>>()

  const wss = new WebSocketServer({ noServer: true })

  const send = (client: Client, message: BroadcastMessage) => {
    try {
      client.socket.send(JSON.stringify(message))
    } catch {
      clients.delete(client)
    }
  }

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const channel = url.searchParams.get('channel') ?? 'default'
    const client: Client = { socket, channel }
    clients.add(client)

    socket.on('close', () => clients.delete(client))
    socket.on('message', (raw) => {
      let message: BroadcastMessage
      try {
        message = JSON.parse(raw.toString())
      } catch {
        return
      }
      // 上行消息只交给本频道的监听者，不自动广播——避免无意中的回环
      for (const handler of handlers.get(channel) ?? []) handler(message)
    })
  })

  const server: Server = ctx.server.server
  const onUpgrade = (request: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (!ctx.auth.verify(url.searchParams.get('token') ?? undefined)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  }
  server.on('upgrade', onUpgrade)

  const service: WebSocketService = {
    broadcast(channel, message) {
      for (const client of clients) {
        if (client.channel === channel) send(client, message)
      }
    },
    broadcastAll(message) {
      for (const client of clients) send(client, message)
    },
    on(channel, handler) {
      let set = handlers.get(channel)
      if (!set) handlers.set(channel, (set = new Set()))
      set.add(handler)
      return () => {
        set!.delete(handler)
      }
    },
    get size() {
      return clients.size
    },
  }
  ctx.set('ws', service)

  ctx.effect(() => () => {
    server.off('upgrade', onUpgrade)
    // 升级过的 socket 不在 HTTP 服务器的连接表里，`closeAllConnections()` 管不到。
    // 不主动断开，`server.close()` 的回调永远不会触发，重启就会卡在「关闭监听」，
    // 前端一直停在等待态。必须先发 close 帧，再终止残留连接。
    for (const client of clients) {
      try {
        client.socket.close(1001, 'server restarting')
      } catch {
        // 已经断开
      }
    }
    wss.clients.forEach((socket) => socket.terminate())
    wss.close()
    clients.clear()
  })
}
