/**
 * 签名插件包的格式定义与校验。
 *
 * 归档（`.cordis-plugin`，tar.gz）根目录至少包含：
 *   - `plugin.json`   插件身份与入口
 *   - `package.json`  peer 依赖
 *   - `bundle.json`   版本、内容 hash、Ed25519 签名、peer 范围、UI 需求
 *   - 服务端/前端产物（路径由 plugin.json 指向）
 *
 * 内容 hash 的规范化规则：
 *   取归档内全部普通文件（排除 `bundle.json`），按 POSIX 路径排序，
 *   对每个文件依次喂入 `路径\0长度\0内容\0`，输出 `sha256:<hex>`。
 *   这样 tar 的条目顺序、时间戳与压缩参数都不影响 hash。
 *
 * 签名载荷：
 *   `cordis-plugin-bundle-v1\n<id>\n<version>\n<hash>\n`
 *   用 Ed25519 对这段 UTF-8 字节签名，`signature` 为 base64。
 */

import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginUiRequirements } from '@cordis-app/protocol'

export const BUNDLE_FILE = 'bundle.json'
export const INSTALLED_FILE = 'installed.json'
export const BUNDLE_FORMAT_VERSION = 1
export const BUNDLE_SIGNATURE_CONTEXT = 'cordis-plugin-bundle-v1'

export interface BundleManifest {
  /** 插件 id，必须与 plugin.json.id 一致 */
  id: string
  /** 语义化版本；同时用于 <id>@<version> 目录名 */
  version: string
  /** 规范化内容 hash，形如 `sha256:<hex>` */
  hash: string
  /** Ed25519 签名（base64），覆盖规范化载荷 */
  signature: string
  algorithm?: 'ed25519'
  /** 插件声明的 peerDependencies；必须包含 cordis-app */
  peer: Record<string, string>
  /** 插件声明的 UI 出口需求 */
  ui?: PluginUiRequirements
  builtAt?: string
}

export type PublicKeyInput = string | Buffer | KeyObject

export interface InstalledBundleEntry {
  id: string
  version: string
  /** 相对 `<userData>/plugins` 的目录名：`<id>@<version>` */
  dir: string
  /** 安装时的内容 hash，供升级/审计比对 */
  hash: string
  installedAt: string
}

export interface InstalledIndex {
  version: 1
  plugins: Record<string, InstalledBundleEntry>
}

/** 解析 `bundle.json`。字段类型不对时给出明确错误，而不是让后续步骤猜。 */
export function parseBundleManifest(raw: Uint8Array): BundleManifest {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw).toString('utf8'))
  } catch (error) {
    throw new Error(`bundle.json 不是合法 JSON：${(error as Error).message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('bundle.json 必须是一个对象')
  }
  const bundle = value as Record<string, unknown>
  for (const field of ['id', 'version', 'hash', 'signature'] as const) {
    if (typeof bundle[field] !== 'string' || bundle[field] === '') {
      throw new Error(`bundle.json 缺少 ${field}`)
    }
  }
  if (typeof bundle.peer !== 'object' || bundle.peer === null || Array.isArray(bundle.peer)) {
    throw new Error('bundle.json 缺少 peer 范围')
  }
  if (bundle.algorithm !== undefined && bundle.algorithm !== 'ed25519') {
    throw new Error(`不支持的签名算法：${String(bundle.algorithm)}`)
  }
  return bundle as unknown as BundleManifest
}

/** 按格式定义计算归档内容 hash（排除 bundle.json）。 */
export function computeBundleHash(files: ReadonlyMap<string, Uint8Array>): string {
  const digest = createHash('sha256')
  for (const path of [...files.keys()].filter((name) => name !== BUNDLE_FILE).sort()) {
    const content = files.get(path)!
    digest.update(`${path}\0${content.length}\0`)
    digest.update(content)
    digest.update('\0')
  }
  return `sha256:${digest.digest('hex')}`
}

/** 签名载荷。打包器与校验器必须使用同一个函数（或同一段字面量）。 */
export function bundleSignaturePayload(bundle: Pick<BundleManifest, 'id' | 'version' | 'hash'>): Buffer {
  return Buffer.from(
    `${BUNDLE_SIGNATURE_CONTEXT}\n${bundle.id}\n${bundle.version}\n${bundle.hash}\n`,
    'utf8',
  )
}

/** 校验签名；失败抛出明确的安装错误。 */
export function verifyBundleSignature(bundle: BundleManifest, publicKey: PublicKeyInput | undefined): void {
  if (!publicKey) {
    throw new Error('未配置插件包签名公钥，拒绝安装未受信任的插件包')
  }
  if (bundle.algorithm !== undefined && bundle.algorithm !== 'ed25519') {
    throw new Error(`不支持的签名算法：${bundle.algorithm}`)
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(bundle.signature)) {
    throw new Error('插件包签名不是合法的 base64')
  }

  const key = loadPublicKey(publicKey)
  const signature = Buffer.from(bundle.signature, 'base64')
  let valid = false
  try {
    valid = verify(null, bundleSignaturePayload(bundle), key, signature)
  } catch (error) {
    throw new Error(`插件包签名校验失败：${(error as Error).message}`)
  }
  if (!valid) throw new Error('插件包签名校验失败：内容与签名不匹配')
}

/**
 * 读取可信公钥。
 *
 * 支持 PEM 字符串、base64 的 SPKI DER、以及已构造好的 KeyObject。
 */
export function loadPublicKey(input: PublicKeyInput): KeyObject {
  if (typeof input === 'object' && !Buffer.isBuffer(input)) {
    return input as KeyObject
  }
  try {
    if (Buffer.isBuffer(input)) {
      const text = input.toString('utf8')
      return text.includes('BEGIN')
        ? createPublicKey(text)
        : createPublicKey({ key: input, format: 'der', type: 'spki' })
    }
    const text = input.trim()
    if (!text) throw new Error('公钥为空')
    return text.includes('BEGIN')
      ? createPublicKey(text)
      : createPublicKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' })
  } catch (error) {
    throw new Error(`无法解析插件包签名公钥：${(error as Error).message}`)
  }
}

/**
 * 读取 `installed.json`。
 *
 * 缺失视为空；损坏则硬失败。静默清空会让用户已安装的插件在下次启动时
 * 全部消失，这比启动失败更难排查。
 */
export function readInstalledIndex(path: string): InstalledIndex {
  if (!existsSync(path)) return { version: 1, plugins: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`installed.json 损坏，拒绝覆盖已安装记录：${(error as Error).message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('installed.json 损坏：顶层必须是对象')
  }

  const record = parsed as Record<string, unknown>
  const rawPlugins = record.plugins
  const entries = normalizeEntries(rawPlugins ?? record)
  return { version: 1, plugins: entries }
}

/** 原子写入 installed.json：先写临时文件再 rename。 */
export function writeInstalledIndex(path: string, index: InstalledIndex): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(index, null, 2) + '\n')
  renameSync(temp, path)
}

function normalizeEntries(raw: unknown): Record<string, InstalledBundleEntry> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('installed.json 损坏：plugins 必须是对象或数组')
  }

  const result: Record<string, InstalledBundleEntry> = {}
  const items: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((entry, index) => {
        const id = (entry as { id?: unknown } | undefined)?.id
        return [typeof id === 'string' ? id : String(index), entry]
      })
    : Object.entries(raw as Record<string, unknown>)

  for (const [key, value] of items) {
    if (key === 'version' && typeof value === 'number') continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`installed.json 损坏：插件 ${key} 的记录不是对象`)
    }
    const entry = value as Record<string, unknown>
    const id = typeof entry.id === 'string' ? entry.id : key
    if (typeof entry.version !== 'string' || entry.version === '') {
      throw new Error(`installed.json 损坏：插件 ${id} 缺少 version`)
    }
    const dir = typeof entry.dir === 'string' && entry.dir ? entry.dir : `${id}@${entry.version}`
    result[id] = {
      id,
      version: entry.version,
      dir,
      hash: typeof entry.hash === 'string' ? entry.hash : '',
      installedAt: typeof entry.installedAt === 'string' ? entry.installedAt : '',
    }
  }
  return result
}
