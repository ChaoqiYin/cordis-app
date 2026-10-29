/**
 * 插件安装。
 *
 * 安装流程：
 *   ① 校验插件清单
 *   ② peerDependencies 与框架白名单比对
 *   ③ 记录安装前的 node_modules 布局
 *   ④ 调用包管理器写入 node_modules
 *   ⑤ 重新读取布局，与 ③ diff
 *   ⑥ 把插件 id 写进 app.json 的启用列表
 *   ⑦ 按 6.4 决定：直接挂载，或重启 worker
 *
 * 事实源是项目根：`package.json`（包管理器读写）、项目 lockfile、`app.json`。
 * 不再维护 app.lock：版本与完整性信息本来就属于项目的 lockfile，框架再存一份
 * 只会产生第三个需要同步的真相。
 *
 * 失败必须可回滚。进程内失败与进程死亡走同一条路径：事务开始前把三个事实文件
 * 与 node_modules 布局写进 `.cordis/install-journal.json`，恢复时按日志还原。
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'
import {
  CORE_PACKAGE,
  SHARED_MODULES,
  SHARED_PEER_RANGES,
  type AppManifest,
  type InstallResult,
  type PluginManifest,
} from '@cordis-app/protocol'

const execFileAsync = promisify(execFile)

/** 事务日志放在项目的运行时目录里，不属于用户源码。 */
const JOURNAL_PATH = join('.cordis', 'install-journal.json')

/** 包管理器可能写出的 lockfile。恢复时要逐个还原，不能只认一种。 */
const LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const

/** node_modules 的布局快照：解析键 → 解析到的真实路径。 */
export type LayoutSnapshot = Map<string, string>

/** 一次安装事务开始前的磁盘状态。恢复时据此把项目整体还原。 */
interface JournalState {
  /** 快照的 JSON 形式（Map 不能直接落盘） */
  snapshot: Record<string, string>
  /** 顶层包名 → 版本；恢复时用来装回被删掉/降级的包 */
  versions: Record<string, string>
  /** 事务前的 package.json 原文；不存在时为 null */
  packageJson: string | null
  /** 事务前每个 lockfile 的原文；不存在的记 null */
  lockfiles: Record<string, string | null>
  /** 事务前的 app.json 原文；不存在时为 null */
  appJson: string | null
}

interface InstallJournal {
  version: 2
  action: 'install' | 'remove'
  spec: string
  startedAt: string
  before: JournalState
}

/** recover() 的报告：它撤销了哪一次未完成的事务。 */
export interface RecoveryResult {
  action: 'install' | 'remove'
  spec: string
}

export interface InstallerOptions {
  /** 项目根。所有路径都从它推导，不再有实例目录。 */
  projectRoot: string
  /** 框架版本，用于 peer 校验 */
  frameworkVersion: string
  /** 自带 yarn.cjs 的路径；缺失时回退到系统 npm */
  yarnPath?: string
  /** 覆盖执行器，测试时注入 */
  run?: (command: string, args: string[], cwd: string) => Promise<void>
}

export class PluginInstaller {
  constructor(private readonly options: InstallerOptions) {}

  /**
   * 读项目 node_modules 的布局。
   *
   * 键是「从项目根出发的解析路径」而不是包名，因为同一个包可以在不同层级
   * 各有一份（`node_modules/lodash` 与 `node_modules/demo/node_modules/lodash`）。
   * 只按包名记录会把这些互相覆盖，而「依赖被提升 / 被降级到嵌套目录」正是
   * 布局比对要抓的那种搬家——漏掉它，重启判定就形同虚设。
   *
   * 递归深度到 3 层：再深的位置对已加载模块不再有影响，而全量递归会在
   * 大项目上变得很慢。
   */
  snapshot(): LayoutSnapshot {
    const layout: LayoutSnapshot = new Map()
    const root = this.options.projectRoot ? join(this.options.projectRoot, 'node_modules') : ''
    if (!root || !existsSync(root)) return layout
    // 前缀为空：顶层包的键就是包名，嵌套包的键是 `demo/node_modules/lodash`
    this.walk(root, '', 0, layout)
    return layout
  }

  private walk(dir: string, prefix: string, depth: number, layout: LayoutSnapshot): void {
    if (depth > 3) return
    const keyOf = (name: string) => (prefix ? `${prefix}/${name}` : name)
    for (const entry of readdirSafe(dir)) {
      // 跳过 .bin、.pnpm、.package-lock.json 之类的框架文件
      if (entry.startsWith('.')) continue
      if (entry.startsWith('@')) {
        for (const scoped of readdirSafe(join(dir, entry))) {
          this.recordPackage(join(dir, entry, scoped), keyOf(`${entry}/${scoped}`), depth, layout)
        }
      } else {
        this.recordPackage(join(dir, entry), keyOf(entry), depth, layout)
      }
    }
  }

  private recordPackage(
    packageDir: string,
    key: string,
    depth: number,
    layout: LayoutSnapshot,
  ): void {
    if (!existsSync(join(packageDir, 'package.json'))) return
    let resolved = packageDir
    try {
      // realpath 会跟随 pnpm 的符号链接，这正是我们想比较的东西
      resolved = realpathSync(packageDir)
    } catch {
      // 链接断了也照样记录：断链本身就是「布局变了」的信号
    }
    layout.set(key, resolve(resolved))
    this.walk(join(packageDir, 'node_modules'), `${key}/node_modules`, depth + 1, layout)
  }

  /**
   * 判定布局是否变化。
   *
   * diff 的对象是「已加载模块的依赖是否换了落点」，不是「装了哪些新包」——
   * 新增一个此前不存在的顶层包不会影响任何已加载的模块，不必重启。
   *
   * 会触发重启的三种情况：
   *
   *   1. 原有包的路径变了（重新提升 / 降到别处）
   *   2. 原有包消失了（卸载或被降级到嵌套目录）
   *   3. 某个已有包下**新增**了嵌套依赖（依赖被 un-hoist，原来那份顶层副本
   *      可能还在，但解析结果已经不同）
   *
   * 返回值是给人看的原因，因此按包名去重。
   */
  static layoutChanged(before: LayoutSnapshot, after: LayoutSnapshot): string[] {
    const moved = new Set<string>()

    for (const [key, path] of before) {
      const now = after.get(key)
      if (now === path) continue
      // 路径变了，或者这个位置的包没了
      moved.add(packageNameFromKey(key))
    }

    for (const key of after.keys()) {
      if (before.has(key)) continue
      // 顶层新增不算：新插件的代码还没进 require.cache
      const parent = parentKeyOf(key)
      if (parent === undefined) continue
      // 已有包下新增了嵌套依赖：它的解析结果变了，那份被加载过的代码必须重来
      if (before.has(parent)) moved.add(packageNameFromKey(key))
    }

    return [...moved]
  }

  async install(spec: string): Promise<InstallResult> {
    // 上一次事务若没走完（进程被杀、机器断电），先还原再叠加新的改动。
    await this.recover()
    const before = this.snapshot()
    const wasPresent = this.isPresent(spec, before)
    this.writeJournal({
      version: 2,
      action: 'install',
      spec,
      startedAt: new Date().toISOString(),
      before: this.captureState(before),
    })

    try {
      await this.runPackageManager(['add', spec])

      const after = this.snapshot()

      // 从这一行起，包管理器已经改过盘了。后续任何一步失败都必须撤回，
      // 否则用户会停在「装了一半」的状态：node_modules 里有包、app.json 里没有
      // 意图记录，CLI 的 list 与设置页于是各说各话。
      const moved = PluginInstaller.layoutChanged(before, after)

      // 装进来的包名不能从 spec 里猜：`file:../x`、tarball URL、`@scope/name@1`
      // 三种写法各自能推出什么不一样，而 npm 最终决定的是 patch 到的那个目录名。
      // 用布局 diff 找出「这次新增或改动的包」，是唯一可靠的来源。
      const name = this.resolveInstalledName(spec, before, after)
      const manifest = this.readPluginManifest(name)
      this.validateManifest(manifest)
      this.checkPeer(name)

      // 已进入 require.cache 的插件才需要重启；新插件直接挂载即可。
      const restarted = wasPresent || moved.length > 0
      this.addEnabledPlugin(manifest.id)
      this.clearJournal()

      return {
        id: manifest.id,
        restarted,
        reason: moved.length
          ? `依赖布局发生变化（${moved.join(', ')}）`
          : wasPresent
            ? '升级已加载插件'
            : '安装新插件，可直接挂载',
      }
    } catch (error) {
      const note = await this.rollbackJournal()
      if (note) {
        // 回滚也失败了：真正的失败原因仍然要保留，磁盘状态的不一致也必须说出来
        throw new Error(`${(error as Error).message}；${note}`)
      }
      throw error
    }
  }

  /**
   * 把一次中断的事务还原到开始前的状态。
   *
   * 这是「事务日志」的全部意义：回滚曾经只在进程内失败时生效，进程一死
   * （重启、断电、用户 kill），node_modules 改了一半、app.json 没写，下次启动
   * 就会按残缺状态加载。现在日志先落盘，恢复只需读日志、比对布局、还原文件。
   *
   * 恢复步骤：
   *   ① 本次新增的插件包从 node_modules 撤掉
   *   ② 事务前存在、现在缺失/搬家/版本变了的顶层包，按日志里的版本装回
   *   ③ package.json、项目 lockfile、app.json 还原成事务前原文
   *   ④ 删除日志
   *
   * 任一步失败都保留日志，让下一次启动继续尝试；宁可反复报错，也不假装干净。
   */
  async recover(): Promise<RecoveryResult | undefined> {
    const journal = this.readJournal()
    if (!journal) return undefined

    const before = new Map(Object.entries(journal.before.snapshot))
    const current = this.snapshot()

    // ① 新增的插件包（带 plugin.json 的顶层包），外加 spec 直接指向的那个包。
    const added = new Set(this.addedPluginNames(before, current))
    const target = packageNameOf(journal.spec)
    if (!before.has(target) && current.has(target)) added.add(target)
    for (const name of added) {
      await this.runPackageManager(['remove', name])
    }

    // ② 事务前存在、现在不可用的顶层包：按事务前记录的版本装回。
    const afterCleanup = this.snapshot()
    for (const [key, path] of before) {
      if (key.includes('node_modules/')) continue
      const name = packageNameFromKey(key)
      const version = journal.before.versions?.[name]
      if (!version) continue
      if (afterCleanup.get(key) === path && this.versionOf(path) === version) continue
      await this.runPackageManager(['add', `${name}@${version}`])
    }

    // ③ 事实文件按原文还原，而不是重新推导——推导会把本次事务的痕迹带进来。
    this.restoreFile(this.packageJsonPath, journal.before.packageJson)
    for (const name of LOCKFILE_NAMES) {
      const content = journal.before.lockfiles?.[name] ?? null
      this.restoreFile(join(this.options.projectRoot, name), content)
    }
    this.restoreFile(this.appJsonPath, journal.before.appJson)
    this.clearJournal()
    return { action: journal.action, spec: journal.spec }
  }

  /** 回滚当前日志描述的事务；失败时返回给人看的说明。 */
  private async rollbackJournal(): Promise<string | undefined> {
    try {
      await this.recover()
      return undefined
    } catch (error) {
      return `回滚失败，node_modules 可能处于不一致状态：${(error as Error).message}`
    }
  }

  /** 本次新增的、带 plugin.json 的顶层包名。嵌套依赖不在此列。 */
  private addedPluginNames(before: LayoutSnapshot, after: LayoutSnapshot): string[] {
    return [...after.entries()]
      .filter(([key, dir]) => !before.has(key) && !key.includes('node_modules/') && existsSync(join(dir, 'plugin.json')))
      .map(([key]) => packageNameFromKey(key))
  }

  private get appJsonPath(): string {
    return join(this.options.projectRoot, 'app.json')
  }

  private get packageJsonPath(): string {
    return join(this.options.projectRoot, 'package.json')
  }

  private get journalPath(): string {
    return join(this.options.projectRoot, JOURNAL_PATH)
  }

  private captureState(snapshot: LayoutSnapshot): JournalState {
    const versions: Record<string, string> = {}
    for (const [key, path] of snapshot) {
      if (key.includes('node_modules/')) continue
      const version = this.versionOf(path)
      if (version) versions[packageNameFromKey(key)] = version
    }
    return {
      snapshot: Object.fromEntries(snapshot),
      versions,
      packageJson: readIfExists(this.packageJsonPath),
      lockfiles: Object.fromEntries(
        LOCKFILE_NAMES.map((name) => [name, readIfExists(join(this.options.projectRoot, name))]),
      ),
      appJson: readIfExists(this.appJsonPath),
    }
  }

  private writeJournal(journal: InstallJournal): void {
    mkdirSync(join(this.options.projectRoot, '.cordis'), { recursive: true })
    writeFileSync(this.journalPath, JSON.stringify(journal, null, 2) + '\n')
  }

  private readJournal(): InstallJournal | undefined {
    try {
      const journal = JSON.parse(readFileSync(this.journalPath, 'utf8')) as InstallJournal
      if (journal?.version !== 2 || !journal.before?.snapshot) return undefined
      return journal
    } catch {
      return undefined
    }
  }

  private clearJournal(): void {
    rmSync(this.journalPath, { force: true })
  }

  private restoreFile(path: string, content: string | null): void {
    if (content === null) rmSync(path, { force: true })
    else writeFileSync(path, content)
  }

  private versionOf(packageDir: string): string | undefined {
    try {
      return (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: string }).version
    } catch {
      return undefined
    }
  }

  async remove(spec: string): Promise<InstallResult> {
    await this.recover()
    const name = packageNameOf(spec)
    const manifest = this.findManifest(name)
    this.writeJournal({
      version: 2,
      action: 'remove',
      spec: name,
      startedAt: new Date().toISOString(),
      before: this.captureState(this.snapshot()),
    })

    try {
      await this.runPackageManager(['remove', name])
      this.removeEnabledPlugin(manifest?.id ?? name)
      this.clearJournal()
      return {
        id: manifest?.id ?? name,
        restarted: true,
        reason: '卸载插件需重启 worker',
      }
    } catch (error) {
      const note = await this.rollbackJournal()
      if (note) throw new Error(`${(error as Error).message}；${note}`)
      throw error
    }
  }

  /**
   * 判断这个包是否已经在 node_modules 里。
   *
   * 「已存在」意味着它可能已经被 worker 加载过、代码进了 require.cache，
   * 因此安装后必须重启。
   */
  private isPresent(spec: string, layout: LayoutSnapshot): boolean {
    const name = packageNameOf(spec)
    return [...layout.keys()].some((key) => packageNameFromKey(key) === name)
  }

  /**
   * 确定这次装进来的包名。
   *
   * 优先用 spec 推出的包名——`name@1.2.3` 这类最常见的写法不必扫描。
   * 推不出来（`file:` 路径、tarball URL）或推出的名字不在新布局里时，
   * 退回「本次新增且带 plugin.json 的包」。安装动作只可能引入少数几个，
   * 恰好一个才是可判定的情形；其余情况如实报错，而不是拿猜出来的名字继续跑。
   */
  private resolveInstalledName(spec: string, before: LayoutSnapshot, after: LayoutSnapshot): string {
    const guessed = packageNameOf(spec)
    if (this.isPresent(guessed, after)) return guessed

    const added = [...after.entries()].filter(([key]) => !before.has(key))
    const withManifest = added
      .filter(([, dir]) => existsSync(join(dir, 'plugin.json')))
      .map(([key]) => packageNameFromKey(key))

    if (withManifest.length === 1) return withManifest[0]!

    if (withManifest.length === 0) {
      throw new Error(`安装 ${spec} 后没有找到任何带 plugin.json 的新包`)
    }
    throw new Error(
      `安装 ${spec} 引入了多个插件（${withManifest.join(', ')}），请改用包名安装以指明要挂载哪一个`,
    )
  }

  private async runPackageManager(args: string[]): Promise<void> {
    const run = this.options.run ?? defaultRun
    if (this.options.yarnPath && existsSync(this.options.yarnPath)) {
      // 单文件 CLI（yarn.cjs）可以直接随包分发，不需要用户机器上有全局安装
      await run(process.execPath, [this.options.yarnPath, ...args], this.options.projectRoot)
      return
    }
    await run('npm', args, this.options.projectRoot)
  }

  private readPluginManifest(name: string): PluginManifest {
    const dir = this.packageDirOf(name)
    const path = join(dir, 'plugin.json')
    if (!existsSync(path)) {
      throw new Error(`${name} 不是 cordis-app 插件：缺少 plugin.json`)
    }
    const manifest: PluginManifest = JSON.parse(readFileSync(path, 'utf8'))
    if (!manifest.id) throw new Error('plugin.json 缺少 id')
    return manifest
  }

  /** ① + ②：清单校验与 peer 比对。 */
  private validateManifest(manifest: PluginManifest): void {
    if (!manifest.server && !manifest.client) {
      throw new Error('plugin.json 既没有 server 也没有 client 入口')
    }
  }

  /**
   * peer 冲突在安装阶段硬失败。
   *
   * 框架前端的 React 只有一份，第二个实例必然导致 hooks 崩溃；把问题推迟到
   * 运行时，用户看到的是玄学故障而不是一句明确提示。
   *
   * 校验对象是「插件声明的 peer 范围」与「框架实际提供的范围」是否有交集：
   * 没有交集就说明无论怎么装都跑不起来。
   *
   * 参数是安装后的包名（由布局 diff 确定），不是 spec，也不是 plugin.json
   * 的 id——id 与包名按设计是分离的，拿 id 去找目录会直接 ENOENT。
   */
  private checkPeer(name: string): void {
    const dir = this.packageDirOf(name)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
    }
    const peers = pkg.peerDependencies ?? {}

    const coreRange = peers[CORE_PACKAGE]
    if (!coreRange) {
      throw new Error(`插件必须把 ${CORE_PACKAGE} 声明为 peerDependencies`)
    }
    if (!semver.satisfies(this.options.frameworkVersion, coreRange, { includePrerelease: true })) {
      throw new Error(`插件要求 ${CORE_PACKAGE}@${coreRange}，当前框架版本是 ${this.options.frameworkVersion}`)
    }

    for (const shared of SHARED_MODULES) {
      const range = peers[shared]
      if (!range) continue
      // 框架版本范围与协议层的共享模块表同源。省略范围的模块（如
      // react-dom/client）由框架直接提供，没有可比较的版本承诺。
      const provided = SHARED_PEER_RANGES[shared]
      if (!provided) continue
      if (!semver.intersects(range, provided, { includePrerelease: true })) {
        throw new Error(`插件要求 ${shared}@${range}，框架提供 ${provided}，两者不兼容`)
      }
    }
  }

  private packageDirOf(name: string): string {
    return join(this.options.projectRoot, 'node_modules', name)
  }

  /** 把插件 id 追加到 app.json 的启用列表；已在列表里则保持原位。 */
  private addEnabledPlugin(id: string): void {
    this.mutateEnabledPlugins((plugins) => (plugins.includes(id) ? plugins : [...plugins, id]))
  }

  private removeEnabledPlugin(id: string): void {
    this.mutateEnabledPlugins((plugins) => plugins.filter((plugin) => plugin !== id))
  }

  /**
   * app.json.plugins 是启用顺序，不是依赖清单。
   *
   * 依赖与版本只写在 package.json；这里只记「用户想启用哪些插件、按什么顺序」。
   * 因此 add 是追加 id，remove 是按 id 过滤，绝不动包名与版本。
   */
  private mutateEnabledPlugins(mutate: (plugins: string[]) => string[]): void {
    const path = this.appJsonPath
    if (!existsSync(path)) return
    const app = JSON.parse(readFileSync(path, 'utf8')) as AppManifest
    const plugins = Array.isArray(app.plugins) ? app.plugins : []
    app.plugins = mutate(plugins)
    writeFileSync(path, JSON.stringify(app, null, 2) + '\n')
  }

  /** 卸载前读一次清单，好让结果里报出 plugin.json 的 id 而不是包名。 */
  private findManifest(name: string): PluginManifest | undefined {
    try {
      return JSON.parse(
        readFileSync(join(this.options.projectRoot, 'node_modules', name, 'plugin.json'), 'utf8'),
      ) as PluginManifest
    } catch {
      return undefined
    }
  }
}

function packageNameOf(spec: string): string {
  // @scope/name@1.2.3 → @scope/name；name@1.2.3 → name
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  if (at > 0) return spec.slice(0, at)
  return spec
}

/** 快照键 → 包名。`demo/node_modules/@s/b` → `@s/b`。 */
function packageNameFromKey(key: string): string {
  const marker = 'node_modules/'
  const index = key.lastIndexOf(marker)
  return index === -1 ? key : key.slice(index + marker.length)
}

/** 嵌套键所属的包。顶层键（没有 node_modules 分隔）返回 undefined。 */
function parentKeyOf(key: string): string | undefined {
  const marker = 'node_modules/'
  const index = key.lastIndexOf(marker)
  return index === -1 ? undefined : key.slice(0, index - 1)
}

async function defaultRun(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd, env: process.env, windowsHide: true })
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
