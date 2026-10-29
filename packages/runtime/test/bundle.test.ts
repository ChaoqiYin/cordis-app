/**
 * bundle 安装来源的契约测试。
 *
 * 测试只通过公开入口观察磁盘结果：`BundleInstallSource.install/remove` 与
 * `PluginInstaller`。归档由测试自己按文档格式构造，不依赖真实 npm、网络或
 * 市场服务。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BundleInstallSource } from '../lib/plugin/bundle-source.js'
import {
  BUNDLE_FILE,
  bundleSignaturePayload,
  computeBundleHash,
} from '../lib/plugin/bundle-format.js'
import { createTarGz } from '../lib/plugin/tar.js'
import { PluginInstaller } from '../lib/plugin/installer.js'

interface BundleSpec {
  id?: string
  version?: string
  peer?: Record<string, string>
  ui?: Record<string, unknown>
  pluginUi?: Record<string, unknown>
  /** 在签名完成后篡改内容 */
  tamper?: boolean
  /** 用另一把私钥签名 */
  signWith?: KeyObject
  omitBundle?: boolean
  extraFiles?: Record<string, string>
}

interface Env {
  userDataDir: string
  pluginsDir: string
  installedJson: string
  publicKeyPem: string
  privateKey: KeyObject
  source: BundleInstallSource
}

function createEnv(options: { publicKey?: boolean; appJson?: unknown } = {}): Env {
  const userDataDir = mkdtempSync(join(tmpdir(), 'cordis-bundle-'))
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  if (options.appJson !== undefined) {
    writeFileSync(join(userDataDir, 'app.json'), JSON.stringify(options.appJson))
  }
  const source = new BundleInstallSource({
    userDataDir,
    frameworkVersion: '1.0.0',
    ...(options.publicKey === false ? {} : { publicKey: publicKeyPem }),
    appJsonPath: join(userDataDir, 'app.json'),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
  return {
    userDataDir,
    pluginsDir: join(userDataDir, 'plugins'),
    installedJson: join(userDataDir, 'installed.json'),
    publicKeyPem,
    privateKey,
    source,
  }
}

/** 按文档格式构造一个合法（或按选项故意损坏）的 `.cordis-plugin`。 */
function makeBundle(env: Env, options: BundleSpec = {}): Buffer {
  const id = options.id ?? 'demo'
  const version = options.version ?? '1.0.0'
  const peer = options.peer ?? { 'cordis-app': '^1.0.0' }
  const files = new Map<string, Buffer>()
  files.set(
    'plugin.json',
    Buffer.from(
      JSON.stringify({
        id,
        version,
        displayName: id,
        server: './server.js',
        client: './client.js',
        ...(options.pluginUi ? { ui: options.pluginUi } : {}),
      }),
    ),
  )
  files.set(
    'package.json',
    Buffer.from(
      JSON.stringify({
        name: id,
        version,
        type: 'module',
        peerDependencies: peer,
      }),
    ),
  )
  files.set('server.js', Buffer.from('export default function apply() {}\n'))
  files.set('client.js', Buffer.from('export default function activate() {}\n'))
  for (const [path, content] of Object.entries(options.extraFiles ?? {})) {
    files.set(path, Buffer.from(content))
  }

  const hash = computeBundleHash(files)
  const signer = options.signWith ?? env.privateKey
  const signature = sign(
    null,
    bundleSignaturePayload({ id, version, hash }),
    signer,
  ).toString('base64')

  if (!options.omitBundle) {
    files.set(
      BUNDLE_FILE,
      Buffer.from(
        JSON.stringify({
          id,
          version,
          hash,
          signature,
          algorithm: 'ed25519',
          peer,
          ...(options.ui ? { ui: options.ui } : {}),
          builtAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    )
  }

  if (options.tamper) files.set('server.js', Buffer.from('export default function hacked() {}\n'))
  return createTarGz(files)
}

/** 把归档写成临时文件，返回路径。默认 readArchive 只接受本地文件。 */
function writeBundle(dir: string, name: string, archive: Buffer): string {
  const path = join(dir, `${name}.cordis-plugin`)
  writeFileSync(path, archive)
  return path
}

function readInstalled(env: Env): any {
  return JSON.parse(readFileSync(env.installedJson, 'utf8'))
}

function pluginDirs(env: Env): string[] {
  if (!existsSync(env.pluginsDir)) return []
  return readdirSync(env.pluginsDir).sort()
}

/** 手工构造 tar 头，用来测试读取侧对恶意归档的拒绝。 */
function rawTarGz(entries: Array<{ name: string; type?: string; data?: Buffer; link?: string }>): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.data ?? Buffer.from('x')
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 'utf8')
    header.write('0000644\0', 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header.fill(0x20, 148, 156)
    header[156] = (entry.type ?? '0').charCodeAt(0)
    header.write('ustar\0', 257, 'ascii')
    header.write('00', 263, 'ascii')
    if (entry.link) header.write(entry.link, 157, 'utf8')
    let sum = 0
    for (let index = 0; index < 512; index += 1) {
      sum += index >= 148 && index < 156 ? 0x20 : header[index]!
    }
    header.write(sum.toString(8).padStart(6, '0'), 148, 'ascii')
    header[154] = 0
    header[155] = 0x20
    blocks.push(header)
    const remainder = data.length % 512
    blocks.push(remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder)]))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

// ---------------------------------------------------------------- 安装

test('bundle 安装写入 <id>@<version>、installed.json，且没有 app.lock', async () => {
  const env = createEnv({
    appJson: { ui: { pages: true, slots: ['header.right'], menus: [], settings: false } },
  })
  const archive = makeBundle(env, {
    ui: { pages: true, slots: ['header.right'] },
  })
  const spec = writeBundle(env.userDataDir, 'demo', archive)

  const result = await env.source.install(spec)

  assert.equal(result.id, 'demo')
  assert.equal(result.version, '1.0.0')
  assert.equal(result.restarted, true, '安装后必须重启 worker 才能发现新插件')
  assert.equal(result.uiCompatibility, 'full')
  assert.deepEqual(pluginDirs(env), ['demo@1.0.0'])
  assert.equal(existsSync(join(env.pluginsDir, 'demo@1.0.0', 'server.js')), true)
  assert.deepEqual(readInstalled(env).plugins.demo, {
    id: 'demo',
    version: '1.0.0',
    dir: 'demo@1.0.0',
    hash: readInstalled(env).plugins.demo.hash,
    installedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.match(readInstalled(env).plugins.demo.hash, /^sha256:[0-9a-f]{64}$/)
  assert.equal(existsSync(join(env.userDataDir, 'app.lock')), false, 'bundle 安装不写公共 app.lock')
})

test('UI 能力缺失只影响 uiCompatibility，不阻断安装', async () => {
  const env = createEnv({ appJson: { ui: { pages: true, slots: [], menus: [], settings: false } } })
  const archive = makeBundle(env, { ui: { slots: ['header.right'] } })
  const result = await env.source.install(writeBundle(env.userDataDir, 'demo', archive))

  assert.equal(result.uiCompatibility, 'backend-only')
  assert.equal(existsSync(join(env.pluginsDir, 'demo@1.0.0')), true, '后端安装仍应成功')
})

test('plugin.json 的 UI 需求优先于 bundle.json 的副本', async () => {
  const env = createEnv({ appJson: { ui: { pages: true, slots: [], menus: [], settings: false } } })
  // bundle.json 只声明 pages（能匹配），但已安装的 plugin.json 还需要
  // header.right——实际加载的是 plugin.json，兼容性必须以它为准。
  const archive = makeBundle(env, {
    ui: { pages: true },
    pluginUi: { pages: true, slots: ['header.right'] },
  })
  const result = await env.source.install(writeBundle(env.userDataDir, 'demo', archive))

  assert.equal(result.uiCompatibility, 'backend-only')
})

test('升级成功后旧版本目录被替换，只保留一个版本', async () => {
  const env = createEnv()
  await env.source.install(writeBundle(env.userDataDir, 'v1', makeBundle(env, { version: '1.0.0' })))
  await env.source.install(writeBundle(env.userDataDir, 'v2', makeBundle(env, { version: '2.0.0' })))

  assert.deepEqual(pluginDirs(env), ['demo@2.0.0'])
  assert.equal(readInstalled(env).plugins.demo.version, '2.0.0')
})

test('升级失败保留旧版本，installed.json 不变', async () => {
  const env = createEnv()
  await env.source.install(writeBundle(env.userDataDir, 'v1', makeBundle(env, { version: '1.0.0' })))
  const before = readFileSync(env.installedJson, 'utf8')

  const broken = makeBundle(env, {
    version: '2.0.0',
    peer: { 'cordis-app': '^1.0.0', react: '^18.0.0' },
  })
  await assert.rejects(
    () => env.source.install(writeBundle(env.userDataDir, 'v2', broken)),
    /peer 校验失败|不兼容/,
  )

  assert.deepEqual(pluginDirs(env), ['demo@1.0.0'], '旧版本必须仍然可用')
  assert.equal(readFileSync(env.installedJson, 'utf8'), before)
})

test('内容被篡改时拒绝安装', async () => {
  const env = createEnv()
  const spec = writeBundle(env.userDataDir, 'tampered', makeBundle(env, { tamper: true }))

  await assert.rejects(() => env.source.install(spec), /hash 不匹配/)
  assert.deepEqual(pluginDirs(env), [])
  assert.equal(existsSync(env.installedJson), false)
})

test('签名与内容不匹配时拒绝安装', async () => {
  const env = createEnv()
  const other = generateKeyPairSync('ed25519').privateKey
  const spec = writeBundle(env.userDataDir, 'bad-sign', makeBundle(env, { signWith: other }))

  await assert.rejects(() => env.source.install(spec), /签名校验失败/)
  assert.deepEqual(pluginDirs(env), [])
})

test('未配置签名公钥时拒绝安装，而不是跳过校验', async () => {
  const env = createEnv({ publicKey: false })
  const spec = writeBundle(env.userDataDir, 'unsigned', makeBundle(env))

  await assert.rejects(() => env.source.install(spec), /公钥/)
  assert.deepEqual(pluginDirs(env), [])
})

test('缺少 bundle.json 的归档被拒绝', async () => {
  const env = createEnv()
  const spec = writeBundle(env.userDataDir, 'no-bundle', makeBundle(env, { omitBundle: true }))

  await assert.rejects(() => env.source.install(spec), /缺少 bundle\.json/)
})

// ---------------------------------------------------------------- 路径安全

test('拒绝归档中的路径穿越、绝对路径与符号链接', async () => {
  const env = createEnv()
  const cases = [
    { name: '../evil', pattern: /逃出/ },
    { name: '/etc/passwd', pattern: /绝对路径/ },
    { name: 'demo/../../evil', pattern: /逃出/ },
    { name: 'link', type: '2', link: '../../etc/passwd', pattern: /符号链接/ },
  ]

  for (const [index, item] of cases.entries()) {
    const archive = rawTarGz([
      { name: item.name, ...(item.type ? { type: item.type } : {}), ...(item.link ? { link: item.link } : {}) },
    ])
    const spec = writeBundle(env.userDataDir, `evil-${index}`, archive)
    await assert.rejects(() => env.source.install(spec), item.pattern, item.name)
  }
  assert.deepEqual(pluginDirs(env), [])
})

// ---------------------------------------------------------------- 卸载

test('卸载只移除该插件，不影响其他 bundle', async () => {
  const env = createEnv()
  await env.source.install(writeBundle(env.userDataDir, 'demo', makeBundle(env, { id: 'demo' })))
  await env.source.install(writeBundle(env.userDataDir, 'other', makeBundle(env, { id: 'other' })))

  const result = await env.source.remove('demo')
  assert.equal(result.id, 'demo')
  assert.equal(result.restarted, true)
  assert.deepEqual(pluginDirs(env), ['other@1.0.0'])
  assert.deepEqual(Object.keys(readInstalled(env).plugins), ['other'])
})

test('卸载不存在的插件是空操作', async () => {
  const env = createEnv()
  const result = await env.source.remove('never')
  assert.equal(result.restarted, false)
  assert.deepEqual(pluginDirs(env), [])
})

test('installed.json 损坏时给出明确错误，不静默清空', async () => {
  const env = createEnv()
  writeFileSync(env.installedJson, '{ not json')
  const spec = writeBundle(env.userDataDir, 'demo', makeBundle(env))

  await assert.rejects(() => env.source.install(spec), /installed\.json 损坏/)
  assert.equal(readFileSync(env.installedJson, 'utf8'), '{ not json')
  assert.deepEqual(pluginDirs(env), [])
})

// ---------------------------------------------------------------- 无 npm / 事务

test('没有 npm 也能安装：bundle 来源不调用包管理器', async () => {
  const env = createEnv()
  const spec = writeBundle(env.userDataDir, 'demo', makeBundle(env))
  let packageManagerCalls = 0

  const installer = new PluginInstaller({
    projectRoot: env.userDataDir,
    frameworkVersion: '1.0.0',
    source: env.source,
    async run() {
      packageManagerCalls += 1
      throw new Error('bundle 安装不应调用包管理器')
    },
  })

  const result = await installer.install(spec)
  assert.equal(result.id, 'demo')
  assert.equal(packageManagerCalls, 0, 'PATH 中没有 npm 也必须能安装')
  assert.equal(existsSync(join(env.pluginsDir, 'demo@1.0.0', 'server.js')), true)
})

test('bundle 安装失败时事务不留下待恢复日志', async () => {
  const env = createEnv()
  const spec = writeBundle(env.userDataDir, 'bad', makeBundle(env, { tamper: true }))
  const installer = new PluginInstaller({
    projectRoot: env.userDataDir,
    frameworkVersion: '1.0.0',
    source: env.source,
  })

  await assert.rejects(() => installer.install(spec), /hash 不匹配/)
  assert.equal(await installer.recover(), undefined)
})

test('bundle 升级失败后事务恢复 installed.json 且旧版本可用', async () => {
  const env = createEnv()
  await env.source.install(writeBundle(env.userDataDir, 'v1', makeBundle(env, { version: '1.0.0' })))
  const before = readFileSync(env.installedJson, 'utf8')

  const installer = new PluginInstaller({
    projectRoot: env.userDataDir,
    frameworkVersion: '1.0.0',
    source: env.source,
  })
  const broken = writeBundle(
    env.userDataDir,
    'v2',
    makeBundle(env, { version: '2.0.0', peer: { 'cordis-app': '^2.0.0' } }),
  )

  await assert.rejects(() => installer.install(broken), /框架版本|不兼容/)
  assert.equal(readFileSync(env.installedJson, 'utf8'), before)
  assert.deepEqual(pluginDirs(env), ['demo@1.0.0'])
})
