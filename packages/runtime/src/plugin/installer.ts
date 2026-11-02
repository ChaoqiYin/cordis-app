/**
 * 插件安装事务。
 *
 * 安装被拆成两层：
 *   - **来源**（`InstallSource`）决定这次动作在磁盘上做什么：npm 源跑项目
 *     包管理器，bundle 源校验并切换签名插件包。
 *   - **事务**（本文件）负责所有来源共有的可靠性：开始前快照事实文件、写事务
 *     日志、失败/进程死亡后还原。
 *
 * 事实源是项目根：`package.json`（包管理器读写）、项目 lockfile、`app.json`。
 * 不再维护 app.lock：版本与完整性信息本来就属于项目的 lockfile，框架再存一份
 * 只会产生第三个需要同步的真相。
 *
 * 失败必须可回滚。进程内失败与进程死亡走同一条路径：事务开始前把来源声明的
 * 文件与来源状态写进 `.cordis/install-journal.json`，恢复时先让来源撤销它自己
 * 的副作用，再按快照还原文件。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { InstallResult } from '@cordis-app/protocol'
import {
  captureFiles,
  restoreFiles,
  type InstallContext,
  type InstallSource,
  type InstallSourceKind,
  type SourceInstallResult,
} from './install-source.js'
import { NpmInstallSource, NPM_LOCKFILE_NAMES } from './npm-source.js'

export type { LayoutSnapshot } from './npm-source.js'

/** 事务日志放在项目的运行时目录里，不属于用户源码。 */
const DEFAULT_JOURNAL = join('.cordis', 'install-journal.json')

interface InstallJournal {
  version: 3
  source: InstallSourceKind
  action: 'install' | 'remove'
  spec: string
  startedAt: string
  /** 事务前的文件原文；null 表示那时不存在 */
  files: Record<string, string | null>
  /** 来源自己的事务前状态 */
  data: unknown
}

/**
 * 旧版日志（v2，只有 npm 源）。
 *
 * 升级前被中断的事务仍要能恢复，否则用户会在启动时卡在一个再也读不懂的
 * 残留文件上。
 */
interface LegacyJournal {
  version: 2
  action: 'install' | 'remove'
  spec: string
  startedAt: string
  before: {
    snapshot: Record<string, string>
    versions: Record<string, string>
    packageJson: string | null
    lockfiles: Record<string, string | null>
    appJson: string | null
  }
}

/** recover() 的报告：它撤销了哪一次未完成的事务。 */
export interface RecoveryResult {
  action: 'install' | 'remove'
  spec: string
}

export interface InstallerOptions {
  /** 项目根。npm 源的所有路径都从它推导。 */
  projectRoot: string
  /** 框架版本，用于 peer 校验 */
  frameworkVersion: string
  /**
   * 默认安装来源。缺省为项目模式下的 npm 源；打包模式由调用方注入
   * `BundleInstallSource`。来源由进程配置决定，不接受来自 HTTP 请求的任意选择。
   */
  source?: InstallSource
  /** 额外来源，用于恢复历史事务（默认 npm 源始终可用） */
  sources?: InstallSource[]
  /** 事务日志路径；缺省 `<projectRoot>/.cordis/install-journal.json` */
  journalPath?: string
  /** 以下两项转发给默认 npm 源，保持既有调用方式 */
  yarnPath?: string
  run?: (command: string, args: string[], cwd: string) => Promise<void>
}

export class PluginInstaller {
  private readonly sources = new Map<InstallSourceKind, InstallSource>()
  private readonly defaultSource: InstallSource
  private readonly journalPath: string
  private readonly projectRoot: string
  private readonly context: InstallContext

  constructor(options: InstallerOptions) {
    const npm = new NpmInstallSource({
      projectRoot: options.projectRoot,
      frameworkVersion: options.frameworkVersion,
      ...(options.yarnPath ? { yarnPath: options.yarnPath } : {}),
      ...(options.run ? { run: options.run } : {}),
    })
    this.sources.set('npm', npm)
    if (options.source) this.sources.set(options.source.kind, options.source)
    for (const source of options.sources ?? []) this.sources.set(source.kind, source)

    this.defaultSource = options.source ?? npm
    this.context = { frameworkVersion: options.frameworkVersion }
    this.projectRoot = options.projectRoot
    this.journalPath = options.journalPath ?? join(options.projectRoot, DEFAULT_JOURNAL)
  }

  /** 当前来源。UI 与 API 只据此展示，不让请求体改变来源。 */
  get sourceKind(): InstallSourceKind {
    return this.defaultSource.kind
  }

  async install(spec: string): Promise<InstallResult> {
    // 上一次事务若没走完（进程被杀、机器断电），先还原再叠加新的改动。
    await this.recover()
    return this.run('install', spec, () => this.defaultSource.install(spec, this.context))
  }

  async remove(spec: string): Promise<InstallResult> {
    await this.recover()
    return this.run('remove', spec, () => this.defaultSource.remove(spec, this.context))
  }

  /**
   * 执行一次带日志的事务。
   *
   * 日志必须在来源动手之前落盘，且包含来源的声明式快照。来源不写日志，
   * 事务也不理解任何来源的内部细节。
   */
  private async run(
    action: 'install' | 'remove',
    spec: string,
    apply: () => Promise<SourceInstallResult>,
  ): Promise<InstallResult> {
    const source = this.defaultSource
    const journal: InstallJournal = {
      version: 3,
      source: source.kind,
      action,
      spec,
      startedAt: new Date().toISOString(),
      files: captureFiles(source.snapshotPaths()),
      data: source.capture(),
    }
    this.writeJournal(journal)

    try {
      const result = await apply()
      this.clearJournal()
      return toInstallResult(result)
    } catch (error) {
      const note = await this.rollback(journal)
      if (note) {
        throw new Error(`${(error as Error).message}；${note}`)
      }
      throw error
    }
  }

  /**
   * 把一次中断的事务还原到开始前的状态。
   *
   * 恢复步骤：
   *   ① 来源撤销文件快照覆盖不到的副作用（node_modules / 用户插件目录）
   *   ② 事实文件按事务前原文还原
   *   ③ 删除日志
   *
   * 任一步失败都保留日志，让下一次启动继续尝试；宁可反复报错，也不假装干净。
   */
  async recover(): Promise<RecoveryResult | undefined> {
    const journal = this.readJournal()
    if (!journal) return undefined

    const source = this.sources.get(journal.source)
    if (!source) {
      throw new Error(`事务日志来自 ${journal.source} 安装来源，但当前进程未配置它，无法安全恢复`)
    }
    await source.recover?.(journal.data)
    restoreFiles(journal.files)
    this.clearJournal()
    return { action: journal.action, spec: journal.spec }
  }

  /** 回滚当前事务；失败时返回给人看的说明。 */
  private async rollback(journal: InstallJournal): Promise<string | undefined> {
    try {
      const source = this.sources.get(journal.source)
      if (!source) throw new Error(`未配置 ${journal.source} 来源`)
      await source.recover?.(journal.data)
      restoreFiles(journal.files)
      this.clearJournal()
      return undefined
    } catch (error) {
      return `回滚失败，磁盘可能处于不一致状态：${(error as Error).message}`
    }
  }

  private writeJournal(journal: InstallJournal): void {
    const path = this.journalPath
    mkdirSync(dirname(path), { recursive: true })
    // 先写临时文件再 rename：断电时要么是旧日志，要么是新日志，不会读到半份 JSON。
    const temp = `${path}.tmp-${process.pid}`
    writeFileSync(temp, JSON.stringify(journal, null, 2) + '\n')
    renameSync(temp, path)
  }

  private readJournal(): InstallJournal | undefined {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.journalPath, 'utf8'))
    } catch {
      return undefined
    }
    return normalizeJournal(parsed, this.projectRoot)
  }

  private clearJournal(): void {
    rmSync(this.journalPath, { force: true })
  }
}

function toInstallResult(result: SourceInstallResult): InstallResult {
  return {
    id: result.id,
    restarted: result.restarted,
    ...(result.version ? { version: result.version } : {}),
    ...(result.uiCompatibility ? { uiCompatibility: result.uiCompatibility } : {}),
    reason: result.reason,
  }
}

/**
 * 把 v2 / v3 日志归一成 v3。
 *
 * v2 只有 npm 源，且把三个事实文件拆成独立字段；这里把它们还原成统一的
 * `files` 映射。损坏的日志返回 undefined，让事务按「没有未完成事务」继续——
 * 与旧实现保持一致，不会因为一个坏文件阻断整个启动。
 */
function normalizeJournal(parsed: unknown, projectRoot: string): InstallJournal | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined
  const value = parsed as Record<string, unknown>

  if (value.version === 3) {
    const journal = value as unknown as InstallJournal
    if (!journal.files || !journal.source) return undefined
    return journal
  }

  if (value.version === 2) {
    const legacy = value as unknown as LegacyJournal
    if (!legacy.before || typeof legacy.before !== 'object') return undefined
    const files: Record<string, string | null> = {
      [join(projectRoot, 'package.json')]: legacy.before.packageJson ?? null,
      [join(projectRoot, 'app.json')]: legacy.before.appJson ?? null,
    }
    for (const name of NPM_LOCKFILE_NAMES) {
      files[join(projectRoot, name)] = legacy.before.lockfiles?.[name] ?? null
    }
    return {
      version: 3,
      source: 'npm',
      action: legacy.action,
      spec: legacy.spec,
      startedAt: legacy.startedAt,
      files,
      data: {
        snapshot: legacy.before.snapshot ?? {},
        versions: legacy.before.versions ?? {},
      },
    }
  }

  return undefined
}

/** 默认日志位置；导出给测试构造旧日志。 */
export { DEFAULT_JOURNAL }
