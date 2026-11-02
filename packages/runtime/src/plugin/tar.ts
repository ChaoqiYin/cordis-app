/**
 * 最小 tar.gz 读写。
 *
 * 插件包格式定为 `.cordis-plugin`（tar.gz），这里只用 Node 内置的 `zlib`
 * 与纯 JS 解析，不引入归档库——打包应用要在没有 npm 的环境里安装插件，
 * 依赖越少越好。
 *
 * 读取侧是安全边界：
 *   - 只接受普通文件与目录；
 *   - 拒绝绝对路径、`..`、反斜杠、NUL、重复路径；
 *   - 拒绝符号链接、硬链接、设备与 FIFO，避免解压后逃出目标目录；
 *   - 限制解压后总大小，防止压缩炸弹。
 */

import { gunzipSync, gzipSync } from 'node:zlib'

const BLOCK = 512

/** 解压后允许的最大字节数。插件包通常只有几 MB，256MB 足够宽裕。 */
export const DEFAULT_MAX_BUNDLE_BYTES = 256 * 1024 * 1024

export interface TarReadOptions {
  /** 解压后总大小上限 */
  maxBytes?: number
}

/**
 * 读取 tar.gz，返回「归档内路径 → 文件内容」。
 *
 * 目录条目不进入结果；路径已归一化为 POSIX 风格。
 */
export function readTarGz(input: Uint8Array, options: TarReadOptions = {}): Map<string, Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES
  let tar: Buffer
  try {
    tar = gunzipSync(input, { maxOutputLength: maxBytes })
  } catch (error) {
    throw new Error(`插件包不是合法的 tar.gz 或解压后超过大小上限：${(error as Error).message}`)
  }
  return readTar(tar, maxBytes)
}

/** 读取未压缩的 tar。 */
export function readTar(tar: Buffer, maxBytes = DEFAULT_MAX_BUNDLE_BYTES): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  let total = 0
  let longName: string | undefined
  let paxPath: string | undefined

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (isZeroBlock(header)) break

    verifyChecksum(header, offset)

    // typeflag 0 与 NUL 都表示普通文件
    const rawType = header[156]!
    const type = rawType === 0 ? '0' : String.fromCharCode(rawType)
    const size = parseNumeric(header, 124, 12)
    if (size < 0) throw new Error('插件包包含负数的条目大小')

    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error('插件包条目被截断')
    const data = tar.subarray(dataStart, dataEnd)

    const rawName = joinTarName(readString(header, 0, 100), readString(header, 345, 155))

    if (type === 'L') {
      // GNU 长文件名：内容就是完整的路径
      longName = readCString(data)
    } else if (type === 'x') {
      // PAX 扩展头只取 path；其余属性与安装无关
      paxPath = parsePaxPath(data) ?? paxPath
    } else if (type === 'g') {
      // 全局扩展头：忽略
    } else if (type === '5') {
      // 目录条目：路径仍要校验，避免后续同名文件借目录绕过
      normalizeEntryPath(longName ?? paxPath ?? rawName)
      longName = undefined
      paxPath = undefined
    } else if (type === '0') {
      const path = normalizeEntryPath(longName ?? paxPath ?? rawName)
      if (files.has(path)) throw new Error(`插件包包含重复路径：${path}`)
      total += data.length
      if (total > maxBytes) throw new Error(`插件包解压后超过大小上限（${maxBytes} 字节）`)
      files.set(path, Buffer.from(data))
      longName = undefined
      paxPath = undefined
    } else {
      const kind = SYMLINK_TYPES[type] ?? `类型 ${JSON.stringify(type)}`
      throw new Error(`插件包包含不允许的归档条目（${kind}）：${normalizeEntryPath(longName ?? paxPath ?? rawName)}`)
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  return files
}

/** 把「路径 → 内容」写成 tar.gz。路径会先经过与读取侧相同的安全校验。 */
export function createTarGz(files: ReadonlyMap<string, Uint8Array>): Buffer {
  return gzipSync(createTar(files))
}

/** 把「路径 → 内容」写成未压缩的 tar。 */
export function createTar(files: ReadonlyMap<string, Uint8Array>): Buffer {
  const chunks: Buffer[] = []
  for (const [rawPath, rawData] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = normalizeEntryPath(rawPath)
    const data = Buffer.from(rawData)
    writeEntry(chunks, path, data)
  }
  chunks.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(chunks)
}

const SYMLINK_TYPES: Record<string, string> = {
  '1': '硬链接',
  '2': '符号链接',
  '3': '字符设备',
  '4': '块设备',
  '6': 'FIFO',
}

function writeEntry(chunks: Buffer[], path: string, data: Buffer): void {
  const split = splitName(path)
  if (!split) {
    // 超过 ustar 的 name/prefix 容量：用 GNU 长文件名条目携带完整路径
    const name = Buffer.from(path + '\0', 'utf8')
    chunks.push(buildHeader('././@LongLink', name.length, 'L'))
    chunks.push(pad(name))
    chunks.push(buildHeader(Buffer.from(path).subarray(0, 100).toString('utf8'), data.length, '0'))
  } else {
    chunks.push(buildHeader(split.name, data.length, '0', split.prefix))
  }
  chunks.push(pad(data))
}

function buildHeader(name: string, size: number, type: string, prefix = ''): Buffer {
  const header = Buffer.alloc(BLOCK)
  writeString(header, 0, 100, name)
  writeOctal(header, 100, 8, 0o644)
  writeOctal(header, 108, 8, 0)
  writeOctal(header, 116, 8, 0)
  writeOctal(header, 124, 12, size)
  // mtime 固定为 0：同样的内容总能得到同样的归档，便于缓存与比对
  writeOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = type.charCodeAt(0)
  writeString(header, 257, 6, 'ustar\0')
  writeString(header, 263, 2, '00')
  writeString(header, 345, 155, prefix)

  const checksum = headerChecksum(header)
  const text = checksum.toString(8).padStart(6, '0')
  header.write(text, 148, 'ascii')
  header[154] = 0
  header[155] = 0x20
  return header
}

function splitName(path: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  for (let index = path.length - 1; index > 0; index -= 1) {
    if (path[index] !== '/') continue
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) {
      return { name, prefix }
    }
  }
  return undefined
}

function joinTarName(name: string, prefix: string): string {
  return prefix ? `${prefix}/${name}` : name
}

/**
 * 归一化并校验归档路径。
 *
 * 归一化结果就是解压时的相对路径；任何可能逃出解压根的写法都在这里拒绝，
 * 后续步骤只处理已经干净的路径。
 */
function normalizeEntryPath(raw: string): string {
  if (!raw) throw new Error('插件包包含空路径条目')
  if (raw.includes('\0')) throw new Error('插件包路径包含 NUL 字节')
  if (raw.includes('\\')) throw new Error(`插件包路径不能包含反斜杠：${raw}`)
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    throw new Error(`插件包路径不能是绝对路径：${raw}`)
  }
  const segments = raw.split('/')
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`插件包路径不能逃出解压根：${raw}`)
  }
  const path = segments.filter((segment) => segment !== '' && segment !== '.').join('/')
  if (!path) throw new Error(`插件包路径无效：${raw}`)
  return path
}

function parsePaxPath(data: Buffer): string | undefined {
  let offset = 0
  let path: string | undefined
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.toString('ascii', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0 && record.slice(0, equals) === 'path') path = record.slice(equals + 1)
    offset += length
  }
  return path
}

function verifyChecksum(header: Buffer, offset: number): void {
  const stored = parseNumeric(header, 148, 8)
  if (stored !== headerChecksum(header)) {
    throw new Error(`插件包 tar 头校验失败（偏移 ${offset}）`)
  }
}

function headerChecksum(header: Buffer): number {
  let sum = 0
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!
  }
  return sum
}

function parseNumeric(buffer: Buffer, offset: number, length: number): number {
  // GNU base-256 编码：最高位置 1 时，其余位是大端整数
  if ((buffer[offset]! & 0x80) !== 0) {
    let value = 0
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = value * 256 + buffer[index]!
    }
    return value
  }
  const text = readString(buffer, offset, length).trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)
  return Number.isNaN(value) ? 0 : value
}

function readString(buffer: Buffer, offset: number, length: number): string {
  let end = offset
  while (end < offset + length && buffer[end] !== 0) end += 1
  return buffer.toString('utf8', offset, end)
}

function readCString(buffer: Buffer): string {
  const end = buffer.indexOf(0)
  return buffer.toString('utf8', 0, end === -1 ? buffer.length : end)
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8').subarray(0, length)
  bytes.copy(buffer, offset)
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, '0')
  buffer.write(text.slice(0, length - 1), offset, 'ascii')
  buffer[offset + length - 1] = 0
}

function pad(data: Buffer): Buffer {
  const remainder = data.length % BLOCK
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - remainder)])
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false
  return true
}
