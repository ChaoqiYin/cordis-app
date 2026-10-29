/**
 * npm 安装来源：项目模式/开发模式使用。
 *
 * 包管理器在项目根执行，事实源是项目 `package.json`、项目 lockfile 与
 * `app.json`。事务日志由 installer 统一维护；本来源只负责：
 *   ① 运行包管理器
 *   ② 用 node_modules 布局 diff 识别实际装进来的包
 *   ③ 校验插件清单与 peer 范围
 *   ④ 把插件 id 追加/移除出 app.json 的启用列表
 *   ⑤ 暴露布局快照，供事务在进程死亡后恢复 node_modules
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'
import {
  CORE_PACKAGE,
  SHARED_MODULES,
  SHARED_PEER_RANGES,
  type AppManifest,
  type PluginManifest,
} from '@cordis-app/protocol'
import { readPluginId } from './catalog.js'
import {
  uiCompatibilityFor,
  type InstallContext,
  type InstallSource,
  type SourceInstallResult,
} from './install-source.js'

const execFileAsync = promisify(execFile)

/** 包管理器可能写出的 lockfile。事务会把实际存在与后来新建的都纳入快照。 */
export const NPM_LOCKFILE_NAMES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const

/** node_modules 的布局快照：解析键 → 解析到的真实路径。 */
export type LayoutSnapshot = Map<string, string>

export interface NpmSourceOptions {
  /** 项目根。包管理器与全部事实文件都在这里。 */
  projectRoot: string
  /** 框架版本，用于 peer 校验 */
  frameworkVersion: string
  /** app.json 路径；缺省为 `<projectRoot>/app.json` */
  appJsonPath?: string
  /** 自带 yarn.cjs 的路径；缺失时回退到系统 npm */
  yarnPath?: string
  /** 覆盖执行器，测试时注入 */
  run?: (command: string, args: string[], cwd: string) => Promise<void>
}

/** npm 事务日志里保存的来源状态。 */
interface NpmJournalData {
  snapshot: Record<string, string>
  versions: Record<string, string>
}

export class NpmInstallSource implements InstallSource {
  readonly kind = 'npm' as const

  constructor(private readonly options: NpmSourceOptions) {}

  get journalPath(): string {
    return join(this.options.projectRoot, '.cordis', 'install-journal.json')
  }

  snapshotPaths(): string[] {
    return [
      this.packageJsonPath,
      this.appJsonPath,
      ...NPM_LOCKFILE_NAMES.map((name) => join(this.options.projectRoot, name)),
    ]
  }

  capture(): NpmJournalData {
    const snapshot = this.snapshot()
    const versions: Record<string, string> = {}
    for (const [key, path] of snapshot) {
      if (key.includes('node_modules/')) continue
      const version = this.versionOf(path)
      if (version) versions[packageNameFromKey(key)] = version
    }
    return { snapshot: Object.fromEntries(snapshot), versions }
  }

  /**
   * 撤销 node_modules 里的改动。事实文件由 installer 按统一快照还原。
   *
   * 恢复步骤：
   *   ① 本次新增的插件包从 node_modules 撤掉
   *   ② 事务前存在、现在缺失/搬家/版本变了的顶层包，按日志里的版本装回
   *
   * 注意：包管理器会顺带改 package.json / lockfile，但随后 installer 会用
   * 快照把它们覆盖回事务前原文，所以这里不必（也不应该）自己写那三个文件。
   */
  async recover(data: unknown): Promise<void> {
    const journal = (data ?? {}) as Partial<NpmJournalData>
    if (!journal.snapshot) return

    const before = new Map(Object.entries(journal.snapshot))
    const current = this.snapshot()

    const added = new Set(this.addedPluginNames(before, current))
    for (const name of added) {
      await this.runPackageManager(['remove', name])
    }

    const afterCleanup = this.snapshot()
    for (const [key, path] of before) {
      if (key.includes('node_modules/')) continue
      const name = packageNameFromKey(key)
      const version = journal.versions?.[name]
      if (!version) continue
      if (afterCleanup.get(key) === path && this.versionOf(path) === version) continue
      await this.runPackageManager(['add', `${name}@${version}`])
    }
  }

  async install(spec: string, context: InstallContext): Promise<SourceInstallResult> {
    const before = this.snapshot()
    const wasPresent = this.isPresent(spec, before)

    await this.runPackageManager(['add', spec])

    const after = this.snapshot()

    // 从这一行起，包管理器已经改过盘了。后续任何一步失败都必须撤回，
    // 否则用户会停在「装了一半」的状态：node_modules 里有包、app.json 里没有
    // 意图记录，CLI 的 list 与设置页于是各说各话。
    const moved = NpmInstallSource.layoutChanged(before, after)

    // 装进来的包名不能从 spec 里猜：`file:../x`、tarball URL、`@scope/name@1`
    // 三种写法各自能推出什么不一样，而 npm 最终决定的是 patch 到的那个目录名。
    // 用布局 diff 找出「这次新增或改动的包」，是唯一可靠的来源。
    const name = this.resolveInstalledName(spec, before, after)
    const manifest = this.readPluginManifest(name)
    this.validateManifest(manifest)
    this.checkPeer(name, context.frameworkVersion)

    // 已进入 require.cache 的插件才需要重启；新插件直接挂载即可。
    const restarted = wasPresent || moved.length > 0
    this.addEnabledPlugin(manifest.id)
    const version = this.versionOf(this.packageDirOf(name))

    return {
      id: manifest.id,
      packageName: name,
      ...(version ? { version } : {}),
      restarted,
      reason: moved.length
        ? `依赖布局发生变化（${moved.join(', ')}）`
        : wasPresent
          ? '升级已加载插件'
          : '安装新插件，可直接挂载',
      uiCompatibility: uiCompatibilityFor(manifest.ui, this.appJsonPath),
    }
  }

  async remove(spec: string): Promise<SourceInstallResult> {
    const name = this.resolveRemoveName(spec)
    const manifest = this.findManifest(name)
    await this.runPackageManager(['remove', name])
    this.removeEnabledPlugin(manifest?.id ?? name)
    return {
      id: manifest?.id ?? name,
      packageName: name,
      restarted: true,
      reason: '卸载插件需重启 worker',
    }
  }

  /**
   * 读项目 node_modules 的布局。
   *
   * 键是「从项目根出发的解析路径」而不是包名，因为同一个包可以在不同层级
   * 各有一份（`node_modules/lodash` 与 `node_modules/demo/node_modules/lodash`）。
   * 只按包名记录会把这些互相覆盖，而「依赖被提升 / 被降级到嵌套目录」正是
   * 布局比对要抓的那种搬家——漏掉它，重启判定就形同虚设。
   */
  snapshot(): LayoutSnapshot {
    const layout: LayoutSnapshot = new Map()
    const root = join(this.options.projectRoot, 'node_modules')
    if (!existsSync(root)) return layout
    this.walk(root, '', 0, layout)
    return layout
  }

  private walk(dir: string, prefix: string, depth: number, layout: LayoutSnapshot): void {
    if (depth > 3) return
    const keyOf = (name: string) => (prefix ? `${prefix}/${name}` : name)
    for (const entry of readdirSafe(dir)) {
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
   * 会触发重启的三种情况：
   *   1. 原有包的路径变了（重新提升 / 降到别处）
   *   2. 原有包消失了（卸载或被降级到嵌套目录）
   *   3. 某个已有包下**新增**了嵌套依赖（依赖被 un-hoist）
   */
  static layoutChanged(before: LayoutSnapshot, after: LayoutSnapshot): string[] {
    const moved = new Set<string>()

    for (const [key, path] of before) {
      const now = after.get(key)
      if (now === path) continue
      moved.add(packageNameFromKey(key))
    }

    for (const key of after.keys()) {
      if (before.has(key)) continue
      const parent = parentKeyOf(key)
      if (parent === undefined) continue
      if (before.has(parent)) moved.add(packageNameFromKey(key))
    }

    return [...moved]
  }

  /** 本次新增的、带 plugin.json 的顶层包名。嵌套依赖不在此列。 */
  private addedPluginNames(before: LayoutSnapshot, after: LayoutSnapshot): string[] {
    return [...after.entries()]
      .filter(([key, dir]) => !before.has(key) && !key.includes('node_modules/') && existsSync(join(dir, 'plugin.json')))
      .map(([key]) => packageNameFromKey(key))
  }

  private get packageJsonPath(): string {
    return join(this.options.projectRoot, 'package.json')
  }

  private get appJsonPath(): string {
    return this.options.appJsonPath ?? join(this.options.projectRoot, 'app.json')
  }

  private versionOf(packageDir: string): string | undefined {
    try {
      return (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as { version?: string }).version
    } catch {
      return undefined
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
   * 优先用 spec 推出的包名；推不出来（`file:` 路径、tarball URL）或推出的
   * 名字不在新布局里时，退回「本次新增且带 plugin.json 的包」。安装动作只
   * 可能引入少数几个，恰好一个才是可判定的情形；其余情况如实报错。
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

  /**
   * 卸载入口同时接受包名与插件 id。
   *
   * 设置页按插件 id 卸载（它不知道 npm 包名），CLI 按包名卸载。两种身份都在
   * 这里归一，调用方不必自己转换。
   */
  private resolveRemoveName(spec: string): string {
    const name = packageNameOf(spec)
    if (existsSync(join(this.packageDirOf(name), 'plugin.json'))) return name
    if (!existsSync(join(this.options.projectRoot, 'node_modules'))) return name
    for (const candidate of topLevelPackageNames(join(this.options.projectRoot, 'node_modules'))) {
      if (readPluginId(join(this.options.projectRoot, 'node_modules'), candidate) === spec) return candidate
    }
    return name
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
    const path = join(this.packageDirOf(name), 'plugin.json')
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
   * 校验对象是「插件声明的 peer 范围」与「框架实际提供的范围」是否有交集：
   * 没有交集就说明无论怎么装都跑不起来。
   */
  private checkPeer(name: string, frameworkVersion: string): void {
    const dir = this.packageDirOf(name)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      peerDependencies?: Record<string, string>
    }
    const peers = pkg.peerDependencies ?? {}

    const coreRange = peers[CORE_PACKAGE]
    if (!coreRange) {
      throw new Error(`插件必须把 ${CORE_PACKAGE} 声明为 peerDependencies`)
    }
    if (!semver.satisfies(frameworkVersion, coreRange, { includePrerelease: true })) {
      throw new Error(`插件要求 ${CORE_PACKAGE}@${coreRange}，当前框架版本是 ${frameworkVersion}`)
    }

    for (const shared of SHARED_MODULES) {
      const range = peers[shared]
      if (!range) continue
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

/** node_modules 顶层的包名列表，含作用域包的完整名字。 */
function topLevelPackageNames(nodeModulesDir: string): string[] {
  const names: string[] = []
  for (const entry of readdirSafe(nodeModulesDir)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      for (const scoped of readdirSafe(join(nodeModulesDir, entry))) {
        if (!scoped.startsWith('.')) names.push(`${entry}/${scoped}`)
      }
    } else {
      names.push(entry)
    }
  }
  return names
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
