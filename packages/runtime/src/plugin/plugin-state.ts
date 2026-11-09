/**
 * 插件两状态模型的状态存储与视图规划。
 *
 * 用户可见状态只有「已启用」与「已卸载」。状态由两部分组成：
 *   - **id 集合**：项目模式以 `app.json.uninstalledPlugins` 为真源；
 *     打包模式的 `app.json` 只读，id 集合与明细一起写用户数据目录。
 *   - **明细记录**：`installed` 保存安装元数据，`uninstalled` 保存卸载时的
 *     包名、版本与原始 spec，供后续一键重装。
 *
 * 状态文件是 `<project>/data/plugins-state.json`（项目模式）或
 * `<userData>/plugins-state.json`（打包模式）。每次读取都以磁盘为准，不在
 * 内存里缓存第二份真相；写入用临时文件 + rename，避免半截 JSON。
 *
 * 本模块只做纯逻辑：不接 HTTP、不执行包管理器、不改 worker。后续 ticket
 * 用 `read()` / `write()` 维护状态，用 `planPluginViews()` 生成两个视图。
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PluginFailure, RuntimeMode } from '@cordis-app/protocol'
import { readOptionalObjectJson } from '../json.js'
import type { InstalledPlugin, PluginRootKind, PluginScan } from './catalog.js'
import type { InstallSourceKind } from './install-source.js'

/** 安装成功后的元数据；卸载时从这里合成重装 spec。 */
export interface InstalledPluginRecord {
  /** 安装时使用的 spec，例如 `pkg@1.2.3` 或插件包路径 */
  spec?: string
  sourceKind?: InstallSourceKind
  packageName?: string
  version?: string
  installedAt: string
}

/** 一次卸载的完整记录；`sourceKind` / `packageName` / `spec` 对随包/本地可省略。 */
export interface UninstalledPluginRecord {
  id: string
  displayName?: string
  rootKind: PluginRootKind
  sourceKind?: InstallSourceKind
  packageName?: string
  version?: string
  spec?: string
  uninstalledAt: string
}

/**
 * 读取状态后的合并结果。
 *
 * `uninstalledIds` 是有效 id 集合；`uninstalled` 只包含其中存在明细记录的 id。
 * `staleUninstalledIds` 是状态文件里有、但真源已不再声明的记录——不展示，
 * 并在下一次 `write()` 时清理。
 */
export interface PluginState {
  installed: Record<string, InstalledPluginRecord>
  uninstalled: Record<string, UninstalledPluginRecord>
  uninstalledIds: string[]
  staleUninstalledIds: string[]
}

export interface PluginStateStoreOptions {
  /** 运行形态：项目模式写 app.json + 状态文件；打包模式只写状态文件。 */
  mode: RuntimeMode
  /** 项目根；项目模式的状态文件与 app.json 都从这里推导。 */
  projectRoot: string
  /** 覆盖 app.json 路径；缺省 `<projectRoot>/app.json`。 */
  appJsonPath?: string
  /** 打包模式的可写用户数据根；状态文件写在它下面。 */
  userDataDir?: string
  /** 覆盖状态文件路径，供测试与嵌入方使用。 */
  statePath?: string
}

/** 状态文件的落盘位置。纯函数，不访问磁盘。 */
export function resolvePluginStatePath(options: PluginStateStoreOptions): string {
  if (options.statePath) return options.statePath
  if (options.mode === 'packaged') {
    if (!options.userDataDir) {
      throw new Error('打包模式必须提供 userDataDir 才能定位 plugins-state.json')
    }
    return join(options.userDataDir, 'plugins-state.json')
  }
  return join(options.projectRoot, 'data', 'plugins-state.json')
}

/**
 * 插件状态存储。
 *
 * 构造时只解析路径；任何读取都重新读磁盘，避免 worker 与 CLI 各持一份
 * 过期状态。项目模式下 `write()` 会同步更新 `app.json.uninstalledPlugins`。
 */
export class PluginStateStore {
  readonly mode: RuntimeMode
  readonly statePath: string
  private readonly appJsonPath: string

  constructor(options: PluginStateStoreOptions) {
    this.mode = options.mode
    this.statePath = resolvePluginStatePath(options)
    this.appJsonPath = options.appJsonPath ?? join(options.projectRoot, 'app.json')
  }

  /** 读取并合并 app.json 与状态文件；磁盘是唯一真相。 */
  read(): PluginState {
    const file = readStateFile(this.statePath)

    // 打包模式的 app.json 是只读产物：id 集合与明细都只能来自状态文件。
    if (this.mode === 'packaged') {
      return {
        installed: file.installed,
        uninstalled: file.uninstalled,
        uninstalledIds: Object.keys(file.uninstalled),
        staleUninstalledIds: [],
      }
    }

    const app = readOptionalObjectJson<{ uninstalledPlugins?: unknown }>(this.appJsonPath)
    // app.json 缺失（或无法解析）时，状态文件是唯一真源。
    const uninstalledIds =
      app === undefined ? Object.keys(file.uninstalled) : stringArray(app.uninstalledPlugins)

    const effective = new Set(uninstalledIds)
    const uninstalled: Record<string, UninstalledPluginRecord> = {}
    for (const id of uninstalledIds) {
      const record = file.uninstalled[id]
      if (record) uninstalled[id] = record
    }
    const staleUninstalledIds = Object.keys(file.uninstalled).filter((id) => !effective.has(id))

    return {
      installed: file.installed,
      uninstalled,
      uninstalledIds,
      staleUninstalledIds,
    }
  }

  /**
   * 整体写回状态。
   *
   * 项目模式下 `uninstalledIds` 是真源：状态文件里不在集合内的记录会被清理，
   * `app.json.uninstalledPlugins` 同步改写。打包模式忽略 `uninstalledIds`，
   * 由 `uninstalled` 记录的键定义 id 集合。
   */
  write(state: PluginState): void {
    if (this.mode === 'packaged') {
      writeStateFile(this.statePath, {
        version: 1,
        installed: state.installed,
        uninstalled: state.uninstalled,
      })
      return
    }

    this.writeProjectState(state)
  }

  /**
   * 记录一次卸载：移出 installed、写入 uninstalled，并把 id 从
   * `app.json.plugins` 的启用顺序里移除。
   */
  markUninstalled(record: UninstalledPluginRecord): PluginState {
    const state = this.read()
    const installed = { ...state.installed }
    delete installed[record.id]

    const uninstalledIds = state.uninstalledIds.filter((id) => id !== record.id)
    uninstalledIds.push(record.id)

    const next: PluginState = {
      installed,
      uninstalled: { ...state.uninstalled, [record.id]: record },
      uninstalledIds,
      staleUninstalledIds: [],
    }
    if (this.mode === 'packaged') this.write(next)
    else this.writeProjectState(next, { removeEnabledId: record.id })
    return next
  }

  /**
   * 清除已卸载状态并把 id 追加到启用顺序末尾。
   *
   * 与 `clearUninstalled` 的区别：启用是一个用户动作，必须让插件重新进入
   * `app.json.plugins`（数组存在时）；`clearUninstalled` 只用于内部清理，
   * 不改变启用顺序。打包模式的 app.json 只读，只写状态文件。
   */
  markEnabled(id: string): PluginState {
    const state = this.read()
    const uninstalled = { ...state.uninstalled }
    delete uninstalled[id]
    const next: PluginState = {
      installed: state.installed,
      uninstalled,
      uninstalledIds: state.uninstalledIds.filter((candidate) => candidate !== id),
      staleUninstalledIds: [],
    }
    if (this.mode === 'packaged') this.write(next)
    else this.writeProjectState(next, { appendEnabledId: id })
    return next
  }

  /** 清除一个 id 的已卸载状态；不触碰 app.json.plugins 的启用顺序。 */
  clearUninstalled(id: string): PluginState {
    const state = this.read()
    const uninstalled = { ...state.uninstalled }
    delete uninstalled[id]
    const next: PluginState = {
      installed: state.installed,
      uninstalled,
      uninstalledIds: state.uninstalledIds.filter((candidate) => candidate !== id),
      staleUninstalledIds: [],
    }
    this.write(next)
    return next
  }

  /** 记录安装元数据；同一 id 的已卸载状态一并清除（安装即启用）。 */
  setInstalled(id: string, record: InstalledPluginRecord): PluginState {
    const state = this.read()
    const uninstalled = { ...state.uninstalled }
    delete uninstalled[id]
    const next: PluginState = {
      installed: { ...state.installed, [id]: record },
      uninstalled,
      uninstalledIds: state.uninstalledIds.filter((candidate) => candidate !== id),
      staleUninstalledIds: [],
    }
    this.write(next)
    return next
  }

  /** 删除安装元数据；已卸载记录与 app.json 不变。 */
  removeInstalled(id: string): PluginState {
    const state = this.read()
    const installed = { ...state.installed }
    delete installed[id]
    const next: PluginState = { ...state, installed }
    this.write(next)
    return next
  }

  /** 项目模式：状态文件 + `app.json` 一起写；可同时调整启用顺序。 */
  private writeProjectState(
    state: PluginState,
    options: { removeEnabledId?: string; appendEnabledId?: string } = {},
  ): void {
    const ids = uniqueStrings(state.uninstalledIds)
    const uninstalled: Record<string, UninstalledPluginRecord> = {}
    for (const id of ids) {
      const record = state.uninstalled[id]
      if (record) uninstalled[id] = record
    }

    writeStateFile(this.statePath, { version: 1, installed: state.installed, uninstalled })
    this.writeAppJson(ids, options)
  }

  /**
   * 更新 `app.json` 的 `uninstalledPlugins`，并按需调整 `plugins` 启用顺序。
   *
   * `plugins` 缺省时保持缺省（发现即启用）；只有数组存在时才追加/移除，
   * 这样不会把「未声明顺序」的项目悄悄变成「显式白名单」。
   */
  private writeAppJson(
    ids: string[],
    options: { removeEnabledId?: string; appendEnabledId?: string },
  ): void {
    const app = readOptionalObjectJson<Record<string, unknown>>(this.appJsonPath)
    // app.json 不存在（打包布局或纯后端项目）时没有可写的 id 真源；
    // 状态文件仍保存明细，后续读取会退回状态文件。
    if (app === undefined) return
    app.uninstalledPlugins = ids

    if (Array.isArray(app.plugins)) {
      let plugins = app.plugins.filter((entry): entry is string => typeof entry === 'string')
      if (options.removeEnabledId !== undefined) {
        plugins = plugins.filter((id) => id !== options.removeEnabledId)
      }
      if (options.appendEnabledId !== undefined && !plugins.includes(options.appendEnabledId)) {
        plugins = [...plugins, options.appendEnabledId]
      }
      app.plugins = plugins
    }

    mkdirSync(dirname(this.appJsonPath), { recursive: true })
    writeFileSync(this.appJsonPath, JSON.stringify(app, null, 2) + '\n')
  }
}

/** 插件来源对用户展示的三分类。 */
export type PluginOrigin = 'builtin' | 'local' | 'external'

/** 完整扫描视图里的一个插件；`enabled` 决定它是否进入启用视图。 */
export interface PluginView {
  plugin: InstalledPlugin
  id: string
  packageName: string
  displayName: string
  version?: string
  rootKind: PluginRootKind
  origin: PluginOrigin
  enabled: boolean
  /** 已卸载时能否通过「启用」恢复；手工写 app.json 的条目没有记录，为 false。 */
  reinstallable: boolean
}

/** 已卸载列表里的条目：扫描结果里找不到、但有卸载记录或 app.json 声明。 */
export interface UninstalledPluginView {
  id: string
  displayName?: string
  version?: string
  rootKind: PluginRootKind
  origin: PluginOrigin
  sourceKind?: InstallSourceKind
  packageName?: string
  spec?: string
  reinstallable: boolean
  uninstalledAt?: string
}

/** 视图规划的完整输出：`enabledScan` 给 loader，`plugins` / `uninstalled` / `failures` 组装 API。 */
export interface PluginViews {
  /** 完整扫描视图，含 enabled / origin / reinstallable 标注。 */
  plugins: PluginView[]
  /** 启用视图：loader、前端清单与静态资源只看这一份。 */
  enabled: PluginView[]
  /** 启用视图的扫描形态，可直接传给 `loadPlugins()`。 */
  enabledScan: PluginScan
  /** 已卸载列表：只含扫描不到、但有卸载记录的插件，避免与 plugins 重复。 */
  uninstalled: UninstalledPluginView[]
  /** 已卸载 id 集合。 */
  uninstalledIds: Set<string>
  /** 启用视图的 id→包根映射；静态资源按它分发。 */
  enabledRoots: Map<string, string>
  /** 只属于启用中插件的失败记录。 */
  failures: PluginFailure[]
}

/**
 * 把完整扫描结果与状态合并成两个视图。
 *
 * 物理存在但被卸载的插件留在 `plugins` 里（`enabled: false`），不重复进
 * `uninstalled`；`uninstalled` 只放扫描不到、但仍被记录为已卸载的插件。
 */
export function planPluginViews(scan: PluginScan, state: PluginState): PluginViews {
  const uninstalledIds = new Set(state.uninstalledIds)

  const plugins: PluginView[] = scan.plugins.map((plugin) => {
    const enabled = !uninstalledIds.has(plugin.id)
    const version = plugin.manifest.version ?? plugin.packageJson.version
    return {
      plugin,
      id: plugin.id,
      packageName: plugin.packageName,
      displayName: plugin.manifest.displayName ?? plugin.id,
      ...(version ? { version } : {}),
      rootKind: plugin.rootKind,
      origin: originOf(plugin.rootKind),
      enabled,
      // 物理存在时，只有生命周期卸载留下的记录才能保证「启用」只是清状态；
      // 手工写进 app.json 的 id 没有记录，不提供一键启用。
      reinstallable: !enabled && state.uninstalled[plugin.id] !== undefined,
    }
  })

  const enabled = plugins.filter((plugin) => plugin.enabled)
  const scannedIds = new Set(scan.plugins.map((plugin) => plugin.id))

  const uninstalled: UninstalledPluginView[] = []
  for (const id of state.uninstalledIds) {
    if (scannedIds.has(id)) continue
    const record = state.uninstalled[id]
    uninstalled.push({
      id,
      displayName: record?.displayName ?? id,
      ...(record?.version ? { version: record.version } : {}),
      // 既扫描不到、又没有明细记录时无法得知真实来源；按外部依赖展示，
      // 且没有 spec 可供重装，用户只能重新提供插件包。
      rootKind: record?.rootKind ?? 'dependency',
      origin: originOf(record?.rootKind ?? 'dependency'),
      ...(record?.sourceKind ? { sourceKind: record.sourceKind } : {}),
      ...(record?.packageName ? { packageName: record.packageName } : {}),
      ...(record?.spec ? { spec: record.spec } : {}),
      reinstallable: record ? reinstallableWhenAbsent(record) : false,
      ...(record?.uninstalledAt ? { uninstalledAt: record.uninstalledAt } : {}),
    })
  }

  const enabledRoots = new Map(enabled.map((plugin) => [plugin.id, plugin.plugin.root]))
  // 已卸载插件不参与加载，它的失败也不该出现在启用视图里。
  const failures = scan.failures.filter((failure) => !uninstalledIds.has(failure.id))

  return {
    plugins,
    enabled,
    enabledScan: {
      plugins: enabled.map((plugin) => plugin.plugin),
      failures,
      roots: enabledRoots,
    },
    uninstalled,
    uninstalledIds,
    enabledRoots,
    failures,
  }
}

function originOf(rootKind: PluginRootKind): PluginOrigin {
  if (rootKind === 'builtin') return 'builtin'
  if (rootKind === 'local') return 'local'
  return 'external'
}

/** 物理不存在时，只有依赖/用户插件能凭记录里的 spec 重装。 */
function reinstallableWhenAbsent(record: UninstalledPluginRecord): boolean {
  if (!record.spec) return false
  return record.rootKind === 'dependency' || record.rootKind === 'user'
}

interface StateFile {
  version: 1
  installed: Record<string, InstalledPluginRecord>
  uninstalled: Record<string, UninstalledPluginRecord>
}

function readStateFile(path: string): StateFile {
  const raw = readOptionalObjectJson<Record<string, unknown>>(path)
  if (!raw) return { version: 1, installed: {}, uninstalled: {} }
  // 只认识当前版本；未知版本不猜测语义，按空状态处理，避免误删用户记录。
  if (raw.version !== undefined && raw.version !== 1) {
    return { version: 1, installed: {}, uninstalled: {} }
  }
  return {
    version: 1,
    installed: normalizeInstalled(raw.installed),
    uninstalled: normalizeUninstalled(raw.uninstalled),
  }
}

function writeStateFile(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true })
  // 临时文件与目标同目录，rename 才是原子替换；跨目录 rename 可能退化成复制。
  const temp = `${path}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n')
  renameSync(temp, path)
}

function normalizeInstalled(raw: unknown): Record<string, InstalledPluginRecord> {
  if (!isPlainObject(raw)) return {}
  const result: Record<string, InstalledPluginRecord> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) continue
    result[key] = {
      ...(typeof value.spec === 'string' ? { spec: value.spec } : {}),
      ...(isSourceKind(value.sourceKind) ? { sourceKind: value.sourceKind } : {}),
      ...(typeof value.packageName === 'string' ? { packageName: value.packageName } : {}),
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      installedAt: typeof value.installedAt === 'string' ? value.installedAt : '',
    }
  }
  return result
}

function normalizeUninstalled(raw: unknown): Record<string, UninstalledPluginRecord> {
  if (!isPlainObject(raw)) return {}
  const result: Record<string, UninstalledPluginRecord> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isPlainObject(value) || !isRootKind(value.rootKind)) continue
    result[key] = {
      id: typeof value.id === 'string' && value.id ? value.id : key,
      ...(typeof value.displayName === 'string' ? { displayName: value.displayName } : {}),
      rootKind: value.rootKind,
      ...(isSourceKind(value.sourceKind) ? { sourceKind: value.sourceKind } : {}),
      ...(typeof value.packageName === 'string' ? { packageName: value.packageName } : {}),
      ...(typeof value.version === 'string' ? { version: value.version } : {}),
      ...(typeof value.spec === 'string' ? { spec: value.spec } : {}),
      uninstalledAt: typeof value.uninstalledAt === 'string' ? value.uninstalledAt : '',
    }
  }
  return result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isRootKind(value: unknown): value is PluginRootKind {
  return value === 'builtin' || value === 'local' || value === 'dependency' || value === 'user'
}

function isSourceKind(value: unknown): value is InstallSourceKind {
  return value === 'npm' || value === 'bundle'
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return uniqueStrings(value.filter((entry): entry is string => typeof entry === 'string'))
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}
