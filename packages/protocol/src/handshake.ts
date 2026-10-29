import { HANDSHAKE_PREFIX } from './constants.js'
import type { HandshakeLine } from './types.js'

/** 把握手载荷编码成一行文本（不含换行）。 */
export function encodeHandshake(payload: HandshakeLine): string {
  return HANDSHAKE_PREFIX + JSON.stringify(payload)
}

/** 尝试把一行文本解析为握手载荷。非握手行返回 undefined。 */
export function decodeHandshake(line: string): HandshakeLine | undefined {
  const trimmed = line.trim()
  if (!trimmed.startsWith(HANDSHAKE_PREFIX)) return undefined
  try {
    const payload = JSON.parse(trimmed.slice(HANDSHAKE_PREFIX.length))
    if (payload && payload.ready === true && typeof payload.port === 'number') {
      return payload as HandshakeLine
    }
  } catch {
    // 半行 / 脏数据：交给调用方继续读下一行
  }
  return undefined
}
