/**
 * 安装来源的公共契约。
 *
 * 安装器拆成两层：
 *   - **来源**（本文件定义）负责「一次安装/卸载在磁盘上到底要做什么」：npm 源
 *     跑项目包管理器，bundle 源校验并切换签名插件包。
 *   - **事务**（installer.ts）负责在改动前后快照事实文件、写事务日志、失败时
 *     还原，并调用来源自己的恢复钩子。
 *
 * 来源不写事务日志：它只声明「哪些文件需要被事务快照」和「哪些副作用需要自己
 * 撤销」。这样 npm 与 bundle 的原子性策略可以完全不同，而恢复逻辑只有一份。
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { matchUiCapabilities } from '@cordis-app/protocol'
import type {
  PluginUiRequirements,
  UiCapabilities,
  UiCompatibility,
} from '@cordis-app/protocol'
import { readOptionalObjectJson } from '../json.js'

export type InstallSourceKind = 'npm' | 'bundle'

/** 一次安装/卸载的外部结果，与协议层的 `InstallResult` 对齐。 */
export interface SourceInstallResult {
  id: string
  /** npm 包名；bundle 源使用插件 id 作为目录身份，通常不填 */
  packageName?: string
  version?: string
  /** 是否需要重启 worker 才能让改动生效 */
  restarted: boolean
  reason: string
  /** 插件 UI 需求与当前 body 能力的匹配结果 */
  uiCompatibility?: UiCompatibility
}

export interface InstallContext {
  frameworkVersion: string
}

export interface InstallSource {
  readonly kind: InstallSourceKind
  /**
   * 事务开始前要快照的文件。文件不存在时快照为 null，回滚会把它删掉——
   * 这样「包管理器新建了一个 lockfile」也能被撤回。
   */
  snapshotPaths(): string[]
  /**
   * 额外的事务前状态，原样存进事务日志。来源恢复时读回自己那一份，
   * 例如 npm 源的 node_modules 布局、bundle 源的临时事务目录。
   */
  capture(): unknown
  install(spec: string, context: InstallContext): Promise<SourceInstallResult>
  remove(spec: string, context: InstallContext): Promise<SourceInstallResult>
  /**
   * 撤销文件快照覆盖不到的副作用（node_modules 里的包、目录切换）。
   * 事务先调用它，再还原快照文件。
   */
  recover?(data: unknown): Promise<void>
}

/** 读取一组文件的原样内容；不存在记录为 null。 */
export function captureFiles(paths: readonly string[]): Record<string, string | null> {
  const captured: Record<string, string | null> = {}
  for (const path of paths) captured[path] = readIfExists(path)
  return captured
}

/** 按快照还原；null 表示事务前不存在，回滚时就该继续不存在。 */
export function restoreFiles(files: Record<string, string | null>): void {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(path, { force: true })
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

/**
 * 计算插件的 UI 兼容级别。
 *
 * 缺失 UI 只影响前端出口，不影响后端安装，因此这里从不抛错；调用方把结果
 * 放进 `InstallResult.uiCompatibility`，由设置页/市场决定怎么展示。
 */
export function uiCompatibilityFor(
  requirements: PluginUiRequirements | undefined,
  appJsonPath: string | undefined,
): UiCompatibility {
  return matchUiCapabilities(requirements, readAppUi(appJsonPath)).compatibility
}

/** 读取 app.json 的 UI 能力；文件缺失或损坏按「没有声明能力」处理。 */
export function readAppUi(path: string | undefined): UiCapabilities | undefined {
  if (!path) return undefined
  return readOptionalObjectJson<{ ui?: UiCapabilities }>(path)?.ui
}

/**
 * 把插件包内的相对路径解析到解压根内。
 *
 * 拒绝绝对路径、NUL、反斜杠与 `..` 逃逸。返回 undefined 的调用方必须视为
 * 非法包并拒绝，不能退化成 `join`。
 */
export function safeJoinWithin(root: string, entryPath: string): string | undefined {
  if (!entryPath || entryPath.includes('\0') || entryPath.includes('\\')) return undefined
  if (isAbsolute(entryPath)) return undefined
  const rootPath = resolve(root)
  const target = resolve(rootPath, entryPath)
  const rel = relative(rootPath, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return target
}

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
