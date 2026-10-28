/**
 * CLI 眼中的磁盘布局。
 *
 * 数据目录的解析顺序与架构文档 3.2 完全一致，且直接复用 protocol 的实现——
 * 命令行与 worker 若在这一层各写一份，`CORDIS_APP_DATA` 就会在一处生效、
 * 在另一处被忽略，症状是「CLI 装的插件在界面上看不到」。
 *
 * CLI 只碰三类文件：
 *   - `instances/default/app.json`    用户表达意图
 *   - `instances/default/app.lock`    安装事实（由 runtime 写入）
 *   - `runtime.json`                  正在运行的实例（由 supervisor 写入）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  instanceDir as instanceDirOf,
  resolveDataDir,
  type AppLock,
  type AppManifest,
  type RuntimeFile,
} from '@cordis-app/protocol'

export interface Workspace {
  dataDir: string
  instanceDir: string
  appJsonPath: string
  appLockPath: string
  runtimeJsonPath: string
}

export function openWorkspace(dataFlag?: string): Workspace {
  const dataDir = resolveDataDir(dataFlag)
  const instanceDir = instanceDirOf(dataDir)
  return {
    dataDir,
    instanceDir,
    appJsonPath: join(instanceDir, 'app.json'),
    appLockPath: join(instanceDir, 'app.lock'),
    runtimeJsonPath: join(dataDir, 'runtime.json'),
  }
}

/** 读 app.json；缺失或损坏时返回 undefined，由调用方决定是「新建」还是「报错」。 */
export function readAppManifest(path: string): AppManifest | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return undefined
    return parsed as AppManifest
  } catch {
    return undefined
  }
}

export function readAppLock(path: string): AppLock | undefined {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AppLock
  } catch {
    return undefined
  }
}

/**
 * 读 runtime.json 并确认进程还活着。
 *
 * runtime.json 是派生文件，进程被强杀时会残留。只检查文件存在会把「上一个
 * 实例留下的尸体」当成正在运行，于是 `run` 拒绝启动、`restart` 去连一个
 * 不存在的端口。pid 存活检查是让这个文件可信的唯一手段。
 */
export function readRuntimeFile(path: string): RuntimeFile | undefined {
  if (!existsSync(path)) return undefined
  let file: RuntimeFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as RuntimeFile
  } catch {
    return undefined
  }
  if (!file || typeof file.port !== 'number' || typeof file.pid !== 'number') return undefined
  if (!isProcessAlive(file.pid)) return undefined
  return file
}

export function isProcessAlive(pid: number): boolean {
  try {
    // 信号 0 只做权限与存在性探测，不会真的发出信号
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在，只是不属于当前用户
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 访问地址。token 放在 fragment 里，不会进入服务端日志，也不会随 Referer 外泄。 */
export function accessUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`
}

/**
 * 找 UI 产物目录。
 *
 * 三种部署形态都要能跑：
 *   - 随 CLI 包分发：`<cli 包>/resources/ui`
 *   - 仓库内开发：`packages/ui/dist/ui`
 *   - 安装目录：`<install>/resources/ui`
 *
 * 找不到不是错误——`new` / `add` / `remove` 完全不碰 UI，只有 `run` 需要它。
 */
export function findResourcesDir(dataDir?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // lib/ → 包根 → resources/
    join(here, '..', 'resources'),
    // 仓库内：packages/cli/lib → packages/ui/dist
    join(here, '..', '..', 'ui', 'dist'),
    join(here, '..', '..', '..', 'resources'),
    // 安装目录：外壳把 UI 释放到数据目录旁边
    ...(dataDir ? [join(dataDir, 'resources')] : []),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'ui', 'index.html')))
}

export interface CreateAppOptions {
  name: string
  root: string
  frameworkVersion: string
}

export interface CreatedApp {
  appJsonPath: string
  packageJsonPath: string
  instanceDir: string
}

/**
 * 创建一个新应用。
 *
 * 只写两份清单，不装任何插件：`cordis-app new` 的价值是「从零到能跑」，
 * 而不是「从零到有一堆示例代码」。空应用启动即得到完整的框架 UI，
 * 用户随后用 `add` 逐个装插件——这正好对应验收标准里的 5 分钟。
 */
export function createApp(options: CreateAppOptions): CreatedApp {
  const instanceDir = join(options.root, 'instances', 'default')
  mkdirSync(instanceDir, { recursive: true })

  const manifest: AppManifest = {
    name: options.name,
    version: '1.0.0',
    framework: `^${options.frameworkVersion}`,
    plugins: {},
  }
  const appJsonPath = join(instanceDir, 'app.json')
  writeFileSync(appJsonPath, JSON.stringify(manifest, null, 2) + '\n')

  // package.json 是派生物，但包管理器必须先看到它才知道往哪里装
  const packageJsonPath = join(instanceDir, 'package.json')
  writeFileSync(
    packageJsonPath,
    JSON.stringify(
      {
        name: `${options.name}-instance`,
        private: true,
        version: '1.0.0',
        type: 'module',
      },
      null,
      2,
    ) + '\n',
  )

  writeFileSync(join(instanceDir, 'app.lock'), JSON.stringify({ lockfileVersion: 1, plugins: {} }, null, 2) + '\n')

  return { appJsonPath, packageJsonPath, instanceDir }
}

/** 把相对路径（含 `~`）展开成绝对路径，命令行里手打路径的常见写法。 */
export function expandPath(input: string): string {
  const expanded = input === '~' || input.startsWith('~/') ? join(process.env.HOME ?? '', input.slice(1)) : input
  return resolve(expanded)
}
