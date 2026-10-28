/** HTTP 层的小工具：JSON 响应、错误响应、MIME 判定、路径穿越防护。 */

import { extname, resolve, sep } from 'node:path'
import type { ServerResponse } from 'node:http'
import type { ErrorPayload } from '@cordis-app/protocol'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

export function mimeType(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // 本地 API 不应被任何中间层缓存
    'cache-control': 'no-store',
  })
  res.end(payload)
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const payload: ErrorPayload = { code, message }
  sendJson(res, status, payload)
}

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 把 URL 路径安全地解析到 base 目录内部。
 *
 * 返回 undefined 表示路径越界（例如 `../../etc/passwd`），调用方应回 404
 * 而不是 403——不泄露「这里有什么」。
 *
 * 这里采取严格策略：只要出现 `..` 段就直接拒绝。仅靠归一化后比对前缀虽然
 * 也能守住边界（越界段会被压回根），但 `..` 出现在插件资源路径里本身就不是
 * 正常请求，显式拒绝更容易审计。
 */
export function safeJoin(base: string, urlPath: string): string | undefined {
  const decoded = safeDecode(urlPath)
  if (decoded === undefined) return undefined

  const segments = decoded.split(/[\\/]+/).filter((part) => part !== '' && part !== '.')
  if (segments.some((part) => part === '..')) return undefined

  const root = resolve(base)
  const target = resolve(root, ...segments)
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

function safeDecode(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value)
    // NUL 字节会让底层 API 抛错或截断路径
    if (decoded.includes('\0')) return undefined
    return decoded
  } catch {
    return undefined
  }
}

/** 读取请求体，带上限避免被撑爆内存。 */
export async function readBody(req: NodeJS.ReadableStream, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > limit) throw new Error('request body too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

export function parseJson<T = unknown>(body: Buffer): T | undefined {
  if (!body.length) return undefined
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    return undefined
  }
}
