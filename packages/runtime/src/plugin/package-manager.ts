/**
 * 项目包管理器检测。
 *
 * 只读项目根下的文件，不执行任何命令。检测顺序按产品决策固定：
 *   ① 显式 yarnPath
 *   ② `package.json#packageManager`
 *   ③ lockfile
 *   ④ `node_modules` 证据（仅在多 lockfile 冲突或没有 lockfile 时使用）
 *   ⑤ 没有任何信号时回退 npm
 *
 * 冲突且无法消歧时抛错，绝不静默回退——静默回退会让 pnpm 项目凭空多出一个
 * `package-lock.json`，而用户没有任何提示。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PackageManagerName = 'npm' | 'pnpm' | 'yarn' | 'bun'

const SUPPORTED: readonly PackageManagerName[] = ['npm', 'pnpm', 'yarn', 'bun']

/** 包管理器可能写出的 lockfile → 管理器。 */
export const LOCKFILE_MANAGERS: Readonly<Record<string, PackageManagerName>> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
}

/** `node_modules` 里的管理器证据 → 管理器。bun 没有列在这里，因此无法用它消歧。 */
const NODE_MODULES_EVIDENCE: ReadonlyArray<{
  path: string
  name: PackageManagerName
}> = [
  { path: join('node_modules', '.pnpm'), name: 'pnpm' },
  { path: join('node_modules', '.package-lock.json'), name: 'npm' },
  { path: join('node_modules', '.yarn-integrity'), name: 'yarn' },
]

export interface DetectedPackageManager {
  name: PackageManagerName
  /** 要执行的命令名；显式 yarnPath 时是当前 Node 可执行文件。 */
  command: string
  /** 命令前缀参数；显式 yarnPath 时为 [yarnPath]。 */
  argsPrefix: string[]
}

export interface DetectPackageManagerOptions {
  projectRoot: string
  /**
   * 显式 yarnPath。存在即视为最高优先级的信号，不再看 package.json 或
   * lockfile——这是调用方明确告诉框架「用这个 yarn」。
   */
  yarnPath?: string
}

export class PackageManagerDetectionError extends Error {
  constructor(
    message: string,
    readonly signals: string[],
    readonly candidates: PackageManagerName[],
  ) {
    super(message)
    this.name = 'PackageManagerDetectionError'
  }
}

/** 按名字解析执行器；恢复事务时据此复用日志里的管理器。 */
export function packageManagerByName(
  name: PackageManagerName,
  options: { yarnPath?: string } = {},
): DetectedPackageManager {
  if (name === 'yarn' && options.yarnPath !== undefined) {
    return { name: 'yarn', command: process.execPath, argsPrefix: [options.yarnPath] }
  }
  return { name, command: name, argsPrefix: [] }
}

export function detectPackageManager(
  options: DetectPackageManagerOptions,
): DetectedPackageManager {
  if (options.yarnPath !== undefined) return packageManagerByName('yarn', options)

  const declared = readDeclaredManager(options.projectRoot)
  if (declared) return packageManagerByName(declared, options)

  const lockfiles = detectLockfiles(options.projectRoot)
  const lockManagers = [...new Set(lockfiles.map((lock) => lock.name))]

  if (lockManagers.length === 1) return packageManagerByName(lockManagers[0]!, options)

  const evidence = detectEvidence(options.projectRoot)
  const evidenceManagers = [...new Set(evidence.map((item) => item.name))]

  // 多个 lockfile 指向不同管理器：证据必须唯一命中候选之一。
  if (lockManagers.length > 1) {
    if (evidenceManagers.length === 1 && lockManagers.includes(evidenceManagers[0]!)) {
      return packageManagerByName(evidenceManagers[0]!, options)
    }
    throw conflictError(lockfiles, evidence, lockManagers)
  }

  // 没有 lockfile：证据唯一才采用。
  if (evidenceManagers.length === 1) return packageManagerByName(evidenceManagers[0]!, options)
  if (evidenceManagers.length > 1) throw conflictError(lockfiles, evidence, evidenceManagers)

  // 没有任何信号。
  return packageManagerByName('npm', options)
}

function readDeclaredManager(projectRoot: string): PackageManagerName | undefined {
  const path = join(projectRoot, 'package.json')
  if (!existsSync(path)) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // package.json 损坏时不把它当成信号；后续 lockfile 检测仍然可用。
    return undefined
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined

  const raw = (parsed as { packageManager?: unknown }).packageManager
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') {
    throw new PackageManagerDetectionError(
      `package.json#packageManager 必须是字符串，当前是 ${typeof raw}`,
      [`package.json#packageManager=${JSON.stringify(raw)}`],
      [...SUPPORTED],
    )
  }

  const name = raw.split('@', 1)[0]
  if (!SUPPORTED.includes(name as PackageManagerName)) {
    throw new PackageManagerDetectionError(
      `package.json#packageManager 声明了不支持的包管理器 "${raw}"；` +
        `只支持 ${SUPPORTED.join('、')}。请修正 packageManager，或删除该字段后依赖 lockfile 检测。`,
      [`package.json#packageManager=${raw}`],
      [...SUPPORTED],
    )
  }
  return name as PackageManagerName
}

function detectLockfiles(
  projectRoot: string,
): Array<{ file: string; name: PackageManagerName }> {
  return Object.entries(LOCKFILE_MANAGERS)
    .filter(([file]) => existsSync(join(projectRoot, file)))
    .map(([file, name]) => ({ file, name }))
}

function detectEvidence(
  projectRoot: string,
): Array<{ path: string; name: PackageManagerName }> {
  return NODE_MODULES_EVIDENCE.filter((item) => existsSync(join(projectRoot, item.path)))
}

function conflictError(
  lockfiles: Array<{ file: string; name: PackageManagerName }>,
  evidence: Array<{ path: string; name: PackageManagerName }>,
  candidates: PackageManagerName[],
): PackageManagerDetectionError {
  const signals: string[] = []
  if (lockfiles.length > 0) {
    signals.push(
      `lockfile：${lockfiles.map((lock) => `${lock.file} → ${lock.name}`).join('、')}`,
    )
  }
  if (evidence.length > 0) {
    signals.push(
      `node_modules 证据：${evidence.map((item) => `${item.path} → ${item.name}`).join('、')}`,
    )
  } else {
    signals.push('node_modules 证据：未找到 .pnpm / .package-lock.json / .yarn-integrity')
  }

  const message =
    `检测到包管理器信号冲突（歧义），无法确定唯一包管理器：${signals.join('；')}。` +
    `候选包管理器：${candidates.join('、')}。` +
    '请删除多余的 lockfile、在 package.json 的 packageManager 字段中显式声明，' +
    '或清理 node_modules 后重试。'
  return new PackageManagerDetectionError(message, signals, candidates)
}
