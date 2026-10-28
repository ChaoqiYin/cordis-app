/**
 * 插件安装。
 *
 * 安装流程（架构文档 6.5）：
 *   ① 校验插件清单
 *   ② peerDependencies 与框架白名单比对
 *   ③ 记录安装前的 node_modules 布局
 *   ④ 调用包管理器写入 node_modules
 *   ⑤ 重新读取布局，与 ③ diff
 *   ⑥ 更新 app.json / app.lock
 *   ⑦ 按 6.4 决定：直接挂载，或重启 worker
 *
 * 失败必须可回滚：第 ④ 步失败时用 app.lock 回到安装前状态——这正是保留 lock
 * 的直接收益，不需要「卸载残留」，只需按记录重装。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import semver from 'semver'
import {
  CORE_PACKAGE,
  SHARED_MODULES,
  type AppLock,
  type AppManifest,
  type InstallResult,
  type LockedPlugin,
  type PluginManifest,
} from '@cordis-app/protocol'

const execFileAsync = promisify(execFile)

/** node_modules 的布局快照：解析键 → 解析到的真实路径。 */
export type LayoutSnapshot = Map<string, string>

export interface InstallerOptions {
  instanceDir: string
  /** 框架版本，用于 peer 校验 */
  frameworkVersion: string
  /** 自带 yarn.cjs 的路径；缺失时回退到系统 npm */
  yarnPath?: string
  /** 框架共享的前端模块版本，用于 peer 交集判定 */
  sharedVersions?: Partial<Record<(typeof SHARED_MODULES)[number], string>>
  /** 覆盖执行器，测试时注入 */
  run?: (command: string, args: string[], cwd: string) => Promise<void>
}

/**
 * 框架实际提供的共享模块版本。
 *
 * CLI 与 worker 的 HTTP 接口都从这里取，避免两处各写一份导致「命令行装得上、
 * 设置页装不上」。值必须与 ui 的构建产物一致，改动它等于改动框架前端。
 */
export const DEFAULT_SHARED_VERSIONS: Partial<Record<(typeof SHARED_MODULES)[number], string>> = {
  react: '^19.0.0',
  'react-dom': '^19.0.0',
}

export class PluginInstaller {
  constructor(private readonly options: InstallerOptions) {}

  /**
   * 读目录下的 node_modules 布局。
   *
   * 键是「从实例根出发的解析路径」而不是包名，因为同一个包可以在不同层级
   * 各有一份（`node_modules/lodash` 与 `node_modules/demo/node_modules/lodash`）。
   * 只按包名记录会把这些互相覆盖，而「依赖被提升 / 被降级到嵌套目录」正是
   * 架构文档 5.5 要抓的那种搬家——漏掉它，重启判定就形同虚设。
   *
   * 递归深度到 3 层：再深的位置对已加载模块不再有影响，而全量递归会在
   * 大项目上变得很慢。
   */
  snapshot(): LayoutSnapshot {
    const layout: LayoutSnapshot = new Map()
    const root = join(this.options.instanceDir, 'node_modules')
    if (!existsSync(root)) return layout
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
   * 新增一个此前不存在的顶层包不会影响任何已加载的模块，不必重启
   * （架构文档 5.5）。会触发重启的三种情况：
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
    const before = this.snapshot()
    const wasPresent = this.isPresent(spec, before)

    await this.runPackageManager(['add', spec])

    const after = this.snapshot()

    // 从这一行起，包管理器已经改过盘了。后续任何一步失败都必须撤回，
    // 否则用户会停在「装了一半」的状态：node_modules 里有包、app.json 里没有
    // 意图记录，CLI 的 list 与设置页于是各说各话（架构文档 6.5 的可回滚要求）。
    let name: string | undefined
    try {
      const moved = PluginInstaller.layoutChanged(before, after)

      // 装进来的包名不能从 spec 里猜：`file:../x`、tarball URL、`@scope/name@1`
      // 三种写法各自能推出什么不一样，而 npm 最终决定的是 patch 到的那个目录名。
      // 用布局 diff 找出「这次新增或改动的包」，是唯一可靠的来源。
      name = this.resolveInstalledName(spec, before, after)
      const manifest = this.readPluginManifest(name)
      this.validateManifest(manifest)
      this.checkPeer(name)

      // 已进入 require.cache 的插件才需要重启；新插件直接挂载即可。
      const restarted = wasPresent || moved.length > 0
      const installed = this.readInstalledVersion(name)
      await this.updateLock()
      this.recordIntent(name, versionRangeOf(spec) ?? `^${installed}`)

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
      const note = await this.rollback(spec, name, wasPresent, before, after)
      if (note) {
        // 回滚也失败了：真正的失败原因仍然要保留，磁盘状态的不一致也必须说出来
        throw new Error(`${(error as Error).message}；${note}`)
      }
      throw error
    }
  }

  /**
   * 撤销一次失败的安装。
   *
   * 新装：把本次新增的插件包从 node_modules 里删掉。
   * 升级：按 app.lock 里记录的版本装回去——此刻 lock 还没被这次失败覆盖，
   * 正好是安装前的真相。
   *
   * 只回滚到包管理器层面：传递依赖可能留下，但没有任何 plugin.json 会指向它们，
   * 下次安装会自然复用或清理。相比把用户停在半安装状态，这个代价可以接受。
   *
   * 返回值是「回滚失败」的说明；成功时返回 undefined。
   */
  private async rollback(
    spec: string,
    name: string | undefined,
    wasPresent: boolean,
    before: LayoutSnapshot,
    after: LayoutSnapshot,
  ): Promise<string | undefined> {
    try {
      if (!wasPresent) {
        const targets = new Set(this.addedPluginNames(before, after))
        if (name) targets.add(name)
        for (const target of targets) {
          await this.runPackageManager(['remove', target])
        }
        return undefined
      }

      const target = name ?? packageNameOf(spec)
      const version = this.lockedVersion(target)
      // 找不到锁定版本就无从恢复，但也不能因此掩盖原始错误
      if (!version) return undefined
      await this.runPackageManager(['add', `${target}@${version}`])
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

  /** app.lock 里记录的版本。失败安装期间它仍是安装前的快照。 */
  private lockedVersion(name: string): string | undefined {
    try {
      const lock = JSON.parse(
        readFileSync(join(this.options.instanceDir, 'app.lock'), 'utf8'),
      ) as AppLock
      return lock.plugins?.[name]?.version
    } catch {
      return undefined
    }
  }

  async remove(spec: string): Promise<InstallResult> {
    const name = packageNameOf(spec)
    const manifest = this.findManifest(name)
    await this.runPackageManager(['remove', name])
    await this.updateLock()
    this.recordIntent(name, undefined)
    return {
      id: manifest?.id ?? name,
      restarted: true,
      reason: '卸载插件需重启 worker',
    }
  }

  /**
   * 判断这个包是否已经在 node_modules 里。
   *
   * 「已存在」意味着它可能已经被 worker 加载过、代码进了 require.cache，
   * 因此安装后必须重启（架构文档 6.4）。
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
      await run(process.execPath, [this.options.yarnPath, ...args], this.options.instanceDir)
      return
    }
    await run('npm', args, this.options.instanceDir)
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
   * peer 冲突在安装阶段硬失败（架构文档 5.6）。
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
      const provided = this.options.sharedVersions?.[shared]
      if (!provided) {
        throw new Error(`插件要求 ${shared}@${range}，但框架不共享该模块`)
      }
      if (!semver.intersects(range, provided, { includePrerelease: true })) {
        throw new Error(`插件要求 ${shared}@${range}，框架提供 ${provided}，两者不兼容`)
      }
    }
  }

  private packageDirOf(spec: string): string {
    const name = packageNameOf(spec)
    return join(this.options.instanceDir, 'node_modules', name)
  }

  /**
   * 用当前 node_modules 布局重建 app.lock，并同步 app.json。
   *
   * 必须是「重建」而不是「累加」：卸载一个包之后，累加式写法会把它的条目
   * 永久留在 lock 里，于是 syncAppJson 永远认为它还在、永远不会从 app.json
   * 删掉——用户卸载了插件，`app.json` 却还写着它，下次启动又会尝试安装。
   */
  private async updateLock(): Promise<void> {
    const lockPath = join(this.options.instanceDir, 'app.lock')
    const previous: AppLock = existsSync(lockPath)
      ? JSON.parse(readFileSync(lockPath, 'utf8'))
      : { lockfileVersion: 1, plugins: {} }

    const plugins: Record<string, LockedPlugin> = {}
    for (const [name, dir] of this.snapshot()) {
      const pkgPath = join(dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        version?: string
        dependencies?: Record<string, string>
      }
      if (!pkg.version) continue
      const existing = previous.plugins[name]
      plugins[name] = {
        version: pkg.version,
        resolved:
          existing?.resolved ??
          `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${pkg.version}.tgz`,
        ...(existing?.integrity ? { integrity: existing.integrity } : {}),
        ...(pkg.dependencies ? { dependencies: pkg.dependencies } : {}),
      }
    }

    const lock: AppLock = { lockfileVersion: 1, plugins }
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
    this.syncAppJson(lock)
  }

  /** app.json 只列直接依赖；这里不臆造意图，只保证被删掉的包也离开清单。 */
  private syncAppJson(lock: AppLock): void {
    const appPath = join(this.options.instanceDir, 'app.json')
    if (!existsSync(appPath)) return
    const app: AppManifest = JSON.parse(readFileSync(appPath, 'utf8'))
    const plugins = { ...app.plugins }
    for (const name of Object.keys(plugins)) {
      if (!(name in lock.plugins)) delete plugins[name]
    }
    app.plugins = plugins
    writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n')
  }

  /**
   * 把一次安装 / 卸载写回 app.json 的意图清单。
   *
   * `syncAppJson` 只负责「删掉已经不在 node_modules 里的」，它无法区分
   * 「用户想要这个插件」与「这是某个插件的传递依赖」，所以新增必须由这里
   * 显式记录。撤销时传 undefined。
   */
  private recordIntent(name: string, range: string | undefined): void {
    const appPath = join(this.options.instanceDir, 'app.json')
    if (!existsSync(appPath)) return
    const app: AppManifest = JSON.parse(readFileSync(appPath, 'utf8'))
    const plugins = { ...app.plugins }
    if (range === undefined) delete plugins[name]
    else plugins[name] = range
    app.plugins = plugins
    writeFileSync(appPath, JSON.stringify(app, null, 2) + '\n')
  }

  /** 已装包的版本号；缺失时返回 '0.0.0'，让 `^0.0.0` 至少是个合法范围。 */
  private readInstalledVersion(name: string): string {
    try {
      const pkg = JSON.parse(
        readFileSync(join(this.options.instanceDir, 'node_modules', name, 'package.json'), 'utf8'),
      ) as { version?: string }
      return pkg.version ?? '0.0.0'
    } catch {
      return '0.0.0'
    }
  }

  /** 卸载前读一次清单，好让结果里报出 plugin.json 的 id 而不是包名。 */
  private findManifest(name: string): PluginManifest | undefined {
    try {
      return JSON.parse(
        readFileSync(join(this.options.instanceDir, 'node_modules', name, 'plugin.json'), 'utf8'),
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

/** 从 spec 中取出作者写的版本范围；没写则返回 undefined，交给调用方推导。 */
function versionRangeOf(spec: string): string | undefined {
  const name = packageNameOf(spec)
  if (name === spec) return undefined
  const range = spec.slice(name.length + 1)
  return range || undefined
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
