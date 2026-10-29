/**
 * bundle 安装来源：打包应用使用。
 *
 * 一次安装的完整校验链：
 *   读取归档 → 计算内容 hash → 与 bundle.json 比对 → 校验 Ed25519 签名
 *   → 解压到用户数据下的临时目录 → 校验 plugin.json / package.json / peer
 *   → 把旧版本目录移入事务备份 → rename 新版本到 `<userData>/plugins/<id>@<version>/`
 *   → 更新 installed.json → 删除备份。
 *
 * 任何一步失败都回到事务前：新目录被删掉、旧版本被移回原位、installed.json
 * 由 outer 事务按快照恢复。整个过程不需要 npm，也不写公共 app.lock。
 */

import { randomUUID } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'
import { CORE_PACKAGE, type PluginManifest } from '@cordis-app/protocol'
import {
  BUNDLE_FILE,
  computeBundleHash,
  parseBundleManifest,
  readInstalledIndex,
  verifyBundleSignature,
  writeInstalledIndex,
  type BundleManifest,
  type InstalledBundleEntry,
  type PublicKeyInput,
} from './bundle-format.js'
import { isValidPluginId, validatePeer } from './catalog.js'
import {
  safeJoinWithin,
  uiCompatibilityFor,
  type InstallContext,
  type InstallSource,
  type SourceInstallResult,
} from './install-source.js'
import { readTarGz } from './tar.js'

export interface BundleSourceOptions {
  /** 可写的用户数据根：插件写 `<userDataDir>/plugins/<id>@<version>/` */
  userDataDir: string
  /** 框架版本，用于 peer 校验 */
  frameworkVersion: string
  /**
   * 可信的 Ed25519 公钥（PEM / base64 SPKI DER / KeyObject）。
   * 未配置时安装被拒绝——绝不静默跳过校验。
   */
  publicKey?: PublicKeyInput
  /**
   * 读取归档字节。默认只接受本地文件路径或 `file://` URL；远程下载必须由
   * 进程配置注入，不能来自不可信请求。
   */
  readArchive?: (spec: string) => Promise<Uint8Array>
  /** 计算 uiCompatibility 用的 app.json */
  appJsonPath?: string
  /** 临时目录根；缺省 `<userDataDir>/.cordis/tmp` */
  tempRoot?: string
  /** 时钟注入，测试用 */
  now?: () => Date
  /** 解压后大小上限 */
  maxBytes?: number
}

/** bundle 事务日志里保存的来源状态。 */
interface BundleJournalData {
  txId: string
}

interface TransactionState {
  action: 'install' | 'remove'
  id: string
  version?: string
  /** 本次安装的目标目录名；remove 时为空 */
  targetName?: string
  /** 被移入备份的目录名 */
  backups: string[]
}

export class BundleInstallSource implements InstallSource {
  readonly kind = 'bundle' as const

  /** installer.capture() 生成的事务 id，供 install/remove 复用 */
  private pendingTxId: string | undefined

  constructor(private readonly options: BundleSourceOptions) {}

  get pluginsDir(): string {
    return join(this.options.userDataDir, 'plugins')
  }

  get installedJsonPath(): string {
    return join(this.options.userDataDir, 'installed.json')
  }

  get journalPath(): string {
    return join(this.options.userDataDir, '.cordis', 'install-journal.json')
  }

  snapshotPaths(): string[] {
    return [this.installedJsonPath]
  }

  capture(): BundleJournalData {
    const txId = randomUUID()
    this.pendingTxId = txId
    return { txId }
  }

  async install(spec: string, _context: InstallContext): Promise<SourceInstallResult> {
    const txId = this.takeTxId()
    const extractRoot = join(this.tempDir, `extract-${txId}`)

    try {
      const files = readTarGz(await this.readArchive(spec), {
        ...(this.options.maxBytes ? { maxBytes: this.options.maxBytes } : {}),
      })
      const bundle = this.verifyArchive(files)
      const hash = computeBundleHash(files)

      // 解压与校验在临时目录完成；此时用户插件根还没有任何改动。
      this.extract(files, extractRoot)
      const manifest = this.validateExtracted(extractRoot, bundle)
      // 以实际会被加载的 plugin.json 为准；bundle.json 的 ui 只是打包时的
      // 声明副本，供市场/安装前预览使用。
      const uiCompatibility = uiCompatibilityFor(
        manifest.ui ?? bundle.ui,
        this.options.appJsonPath,
      )

      this.commitInstall(txId, extractRoot, bundle, hash)

      return {
        id: bundle.id,
        packageName: bundle.id,
        version: bundle.version,
        // 安装时 worker 的扫描结果已经定型，必须重启才能发现新插件。
        restarted: true,
        reason: '安装插件包需重启 worker',
        uiCompatibility,
      }
    } catch (error) {
      rmSync(extractRoot, { recursive: true, force: true })
      throw error
    }
  }

  async remove(spec: string, _context: InstallContext): Promise<SourceInstallResult> {
    const txId = this.takeTxId()
    const index = readInstalledIndex(this.installedJsonPath)
    const id = this.resolveInstalledId(spec, index.plugins)
    const dirs = this.dirsForId(id)

    if (!index.plugins[id] && dirs.length === 0) {
      return {
        id,
        restarted: false,
        reason: '用户插件目录中没有该插件',
      }
    }

    this.commitRemove(txId, id, dirs)
    return {
      id,
      version: index.plugins[id]?.version,
      restarted: true,
      reason: '卸载插件包需重启 worker',
    }
  }

  /**
   * 撤销一次被中断的目录切换。
   *
   * 状态文件在移动任何目录之前写入，因此即使进程在 rename 中途死亡，也能
   * 根据 `backups` 把旧版本移回原位。恢复是幂等的：目标不存在时删除是空操作。
   */
  async recover(data: unknown): Promise<void> {
    const txId = (data as Partial<BundleJournalData> | undefined)?.txId
    if (!txId) return
    const txDir = this.txDir(txId)
    if (!existsSync(txDir)) return
    const note = this.revertTx(txDir)
    if (note) throw new Error(note)
  }

  // ------------------------------------------------------------ 校验

  private verifyArchive(files: ReadonlyMap<string, Buffer>): BundleManifest {
    const raw = files.get(BUNDLE_FILE)
    if (!raw) throw new Error(`插件包缺少 ${BUNDLE_FILE}`)

    const bundle = parseBundleManifest(raw)
    if (!isValidPluginId(bundle.id)) {
      throw new Error(`bundle.json 的 id 必须是 URL 安全段（不能为空、不能含 / 或 ..）：${bundle.id}`)
    }
    if (!semver.valid(bundle.version)) {
      throw new Error(`bundle.json 的 version 不是合法语义化版本：${bundle.version}`)
    }
    if (typeof bundle.peer[CORE_PACKAGE] !== 'string') {
      throw new Error(`bundle.json 的 peer 必须声明 ${CORE_PACKAGE} 范围`)
    }
    let peerOk: boolean
    try {
      peerOk = semver.satisfies(this.options.frameworkVersion, bundle.peer[CORE_PACKAGE]!, {
        includePrerelease: true,
      })
    } catch {
      throw new Error(`bundle.json 的 ${CORE_PACKAGE} peer 范围无法解析：${bundle.peer[CORE_PACKAGE]}`)
    }
    if (!peerOk) {
      throw new Error(
        `插件包要求 ${CORE_PACKAGE}@${bundle.peer[CORE_PACKAGE]}，当前框架版本是 ${this.options.frameworkVersion}`,
      )
    }

    // 先比 hash 再验签名：内容被篡改时给出更直接的原因。
    const actual = computeBundleHash(files)
    if (bundle.hash !== actual) {
      throw new Error(`插件包内容 hash 不匹配：bundle.json 声明 ${bundle.hash}，实际 ${actual}`)
    }
    verifyBundleSignature(bundle, this.options.publicKey)
    return bundle
  }

  private extract(files: ReadonlyMap<string, Buffer>, root: string): void {
    mkdirSync(root, { recursive: true })
    for (const [path, content] of files) {
      const target = safeJoinWithin(root, path)
      if (!target) throw new Error(`插件包包含非法路径：${path}`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, { mode: 0o644 })
    }
  }

  /**
   * 校验解压后的插件清单。
   *
   * `server`/`client` 路径以解压根为界做 safeJoin，并确认最终是普通文件；
   * 归档读取阶段已经拒绝符号链接，这里再做一次 realpath 检查，防止实现回归。
   */
  private validateExtracted(root: string, bundle: BundleManifest): PluginManifest {
    const manifest = this.readJson<PluginManifest>(join(root, 'plugin.json'), 'plugin.json')
    if (manifest.id !== bundle.id) {
      throw new Error(`plugin.json 的 id（${manifest.id}）与 bundle.json（${bundle.id}）不一致`)
    }
    if (manifest.version && manifest.version !== bundle.version) {
      throw new Error(`plugin.json 的 version（${manifest.version}）与 bundle.json（${bundle.version}）不一致`)
    }
    if (!manifest.server && !manifest.client) {
      throw new Error('plugin.json 既没有 server 也没有 client 入口')
    }

    const pkg = this.readJson<{ peerDependencies?: Record<string, string> }>(
      join(root, 'package.json'),
      'package.json',
    )
    const reason = validatePeer(pkg, this.options.frameworkVersion)
    if (reason) throw new Error(`插件包 peer 校验失败：${reason}`)

    for (const entry of [manifest.server, manifest.client]) {
      if (!entry) continue
      const target = safeJoinWithin(root, entry)
      if (!target) throw new Error(`plugin.json 的入口路径不能逃出插件根：${entry}`)
      if (!existsSync(target) || !lstatSync(target).isFile()) {
        throw new Error(`plugin.json 的入口不存在或不是普通文件：${entry}`)
      }
      const real = realpathSync(target)
      // 解压根本身也可能经过符号链接（macOS 的 /var → /private/var），
      // 两端都取 realpath 再比较前缀。
      const rootReal = realpathSync(root)
      if (!real.startsWith(rootReal + sep)) {
        throw new Error(`plugin.json 的入口通过符号链接逃出了插件根：${entry}`)
      }
    }

    return manifest
  }

  private readJson<T>(path: string, label: string): T {
    if (!existsSync(path)) throw new Error(`插件包缺少 ${label}`)
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T
    } catch (error) {
      throw new Error(`${label} 不是合法 JSON：${(error as Error).message}`)
    }
  }

  // ------------------------------------------------------------ 原子切换

  private commitInstall(
    txId: string,
    extractRoot: string,
    bundle: BundleManifest,
    hash: string,
  ): void {
    const txDir = this.txDir(txId)
    const backupDir = join(txDir, 'backup')
    const targetName = `${bundle.id}@${bundle.version}`
    const target = join(this.pluginsDir, targetName)
    const existing = this.dirsForId(bundle.id)

    mkdirSync(backupDir, { recursive: true })
    const state: TransactionState = {
      action: 'install',
      id: bundle.id,
      version: bundle.version,
      targetName,
      backups: existing.map((dir) => basename(dir)),
    }
    // 状态先落盘，再移动任何目录：这样中途进程死亡也有据可查。
    writeFileSync(join(txDir, 'state.json'), JSON.stringify(state, null, 2) + '\n')

    try {
      mkdirSync(this.pluginsDir, { recursive: true })
      for (const dir of existing) movePath(dir, join(backupDir, basename(dir)))
      movePath(extractRoot, target)

      const index = readInstalledIndex(this.installedJsonPath)
      const entry: InstalledBundleEntry = {
        id: bundle.id,
        version: bundle.version,
        dir: targetName,
        hash,
        installedAt: this.now().toISOString(),
      }
      index.plugins[bundle.id] = entry
      writeInstalledIndex(this.installedJsonPath, index)

      // 提交成功后才删除旧版本备份，失败路径永远保留可回滚的副本。
      rmSync(txDir, { recursive: true, force: true })
    } catch (error) {
      const note = this.revertTx(txDir)
      if (note) throw new Error(`${(error as Error).message}；${note}`)
      throw error
    }
  }

  private commitRemove(txId: string, id: string, dirs: string[]): void {
    const txDir = this.txDir(txId)
    const backupDir = join(txDir, 'backup')
    mkdirSync(backupDir, { recursive: true })

    const state: TransactionState = {
      action: 'remove',
      id,
      backups: dirs.map((dir) => basename(dir)),
    }
    writeFileSync(join(txDir, 'state.json'), JSON.stringify(state, null, 2) + '\n')

    try {
      for (const dir of dirs) movePath(dir, join(backupDir, basename(dir)))
      const index = readInstalledIndex(this.installedJsonPath)
      delete index.plugins[id]
      writeInstalledIndex(this.installedJsonPath, index)
      rmSync(txDir, { recursive: true, force: true })
    } catch (error) {
      const note = this.revertTx(txDir)
      if (note) throw new Error(`${(error as Error).message}；${note}`)
      throw error
    }
  }

  /** 把事务目录里的备份移回插件根，并删掉本次新建的目标目录。 */
  private revertTx(txDir: string): string | undefined {
    try {
      let state: TransactionState | undefined
      try {
        state = JSON.parse(readFileSync(join(txDir, 'state.json'), 'utf8')) as TransactionState
      } catch {
        // 还没写状态就失败了：没有目录被动过
        rmSync(txDir, { recursive: true, force: true })
        return undefined
      }

      if (state.action === 'install' && state.targetName) {
        rmSync(join(this.pluginsDir, state.targetName), { recursive: true, force: true })
      }
      for (const name of state.backups) {
        const backup = join(txDir, 'backup', name)
        if (!existsSync(backup)) continue
        const destination = join(this.pluginsDir, name)
        rmSync(destination, { recursive: true, force: true })
        mkdirSync(dirname(destination), { recursive: true })
        movePath(backup, destination)
      }
      rmSync(txDir, { recursive: true, force: true })
      return undefined
    } catch (error) {
      return `回滚用户插件目录失败：${(error as Error).message}`
    }
  }

  // ------------------------------------------------------------ 路径与 IO

  /** 用户插件根里属于这个 id 的目录；不跟随符号链接。 */
  private dirsForId(id: string): string[] {
    if (!existsSync(this.pluginsDir)) return []
    const prefix = `${id}@`
    const found: string[] = []
    for (const name of readdirSafe(this.pluginsDir)) {
      if (name !== id && !name.startsWith(prefix)) continue
      const path = join(this.pluginsDir, name)
      try {
        // lstat 不跟随链接：符号链接不会被当成可替换的插件目录
        if (lstatSync(path).isDirectory()) found.push(path)
      } catch {
        // 断链等异常目录跳过
      }
    }
    return found
  }

  private resolveInstalledId(spec: string, installed: Record<string, InstalledBundleEntry>): string {
    if (installed[spec]) return spec
    // 兼容 remove('id@version') 的写法；插件 id 本身不允许含 @。
    const base = spec.split('@')[0]!
    if (installed[base]) return base
    return base
  }

  private takeTxId(): string {
    const txId = this.pendingTxId ?? randomUUID()
    this.pendingTxId = undefined
    return txId
  }

  private get tempDir(): string {
    return this.options.tempRoot ?? join(this.options.userDataDir, '.cordis', 'tmp')
  }

  private txDir(txId: string): string {
    return join(this.options.userDataDir, '.cordis', 'tx', txId)
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date()
  }

  private async readArchive(spec: string): Promise<Uint8Array> {
    if (this.options.readArchive) return this.options.readArchive(spec)
    const path = spec.startsWith('file://') ? fileURLToPath(spec) : spec
    try {
      if (existsSync(path) && lstatSync(path).isFile()) return readFileSync(path)
    } catch {
      // 落到下面的统一错误
    }
    throw new Error(`无法获取插件包 ${spec}：未配置下载器，且本地文件不存在`)
  }
}

/** rename 跨设备时回退到复制 + 删除。 */
function movePath(source: string, destination: string): void {
  try {
    renameSync(source, destination)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  cpSync(source, destination, { recursive: true, dereference: false })
  rmSync(source, { recursive: true, force: true })
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
