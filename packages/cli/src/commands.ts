/**
 * 子命令的实现。
 *
 * 所有命令都返回退出码而不是直接调用 `process.exit()`：这样 `cli.ts` 是唯一
 * 决定进程何时退出、以什么状态退出的地方，测试也能直接调用命令函数拿到结果。
 *
 * 命令一律是 async 的——安装与重启都是异步动作，用同步 API 包装它们只会
 * 在事件循环上绕远路。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { FRAMEWORK_VERSION, waitForReady } from '@cordis-app/protocol'
import { PluginInstaller, Supervisor, readPluginId } from '@cordis-app/runtime'
import type { ParsedArgs } from './args.js'
import { UsageError } from './args.js'
import {
  accessUrl,
  createProject,
  expandPath,
  findResourcesDir,
  isDirectoryNonEmpty,
  openWorkspace,
  readAppManifest,
  readProjectPackage,
  readRuntimeFile,
  type Workspace,
} from './workspace.js'

/** 脚手架写入的框架依赖；它们不是插件，不参与 list 的插件表格。 */
const FRAMEWORK_DEPENDENCIES = new Set(['cordis-app', 'react', 'react-dom'])

/** 命令执行的依赖注入点。测试据此替换掉进程、网络、浏览器、包管理器。 */
export interface CommandIO {
  out(line: string): void
  err(line: string): void
  /** 框架版本，写进新项目的 package.json 并用于 peer 校验 */
  frameworkVersion: string
  /** 打开浏览器的实现，测试时替换 */
  openBrowser?(url: string): void
  /** 覆盖 UI 产物目录探测 */
  resourcesDir?: string
  /** 执行包管理器，测试时替换；默认在项目根执行 npm */
  packageManager?(command: string, args: string[], cwd: string): Promise<void>
}

export const defaultIO: CommandIO = {
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => process.stderr.write(line + '\n'),
  frameworkVersion: FRAMEWORK_VERSION,
  openBrowser(url) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try {
      // 打不开浏览器不是错误：地址已经打印出来了，用户可以自己粘贴
      spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
    } catch {
      // 同上
    }
  },
}

function requireApp(workspace: Workspace, io: CommandIO): boolean {
  if (existsSync(workspace.appJsonPath)) return true
  io.err(`找不到应用定义：${workspace.appJsonPath}`)
  io.err('先执行 cordis-app new <名字>，或用 --project 指向已有的项目根。')
  return false
}

// ---------------------------------------------------------------- new

export async function commandNew(args: ParsedArgs, io: CommandIO): Promise<number> {
  const name = args.positionals[0]
  if (!name) throw new UsageError('用法：cordis-app new <名字>')

  // `--project` 指定项目根时直接建在那里；否则在当前目录下建一个同名目录。
  const root = args.projectDir ? expandPath(args.projectDir) : expandPath(name)
  if (isDirectoryNonEmpty(root)) {
    io.err(`目标目录非空：${root}`)
    io.err('换一个目录，或先清空它。')
    return 1
  }

  const created = createProject({ name, root, frameworkVersion: io.frameworkVersion })
  io.out(`已创建项目「${name}」`)
  io.out(`  项目根    ${created.projectRoot}`)
  io.out(`  应用定义  ${created.appJsonPath}`)
  io.out(`  后端入口  ${created.serverEntry}`)
  io.out('')
  io.out('下一步：')
  io.out(`  cordis-app add <插件包名> --project ${created.projectRoot}`)
  io.out(`  cordis-app run --project ${created.projectRoot}`)
  return 0
}

// ---------------------------------------------------------------- run

export async function commandRun(args: ParsedArgs, io: CommandIO): Promise<number> {
  const workspace = openWorkspace(args.projectDir)
  if (!requireApp(workspace, io)) return 1

  // 已经在跑：直接把地址交出去，而不是再起一个抢端口的实例
  const running = readRuntimeFile(workspace.runtimeJsonPath)
  if (running) {
    io.err(`项目已在运行（pid ${running.pid}）`)
    io.out(accessUrl(running.port, running.token))
    return 0
  }

  const resourcesDir = io.resourcesDir ?? findResourcesDir(workspace.projectRoot)
  if (!resourcesDir) {
    io.err('找不到 UI 产物目录，页面将无法打开。')
    io.err('请先构建前端（pnpm build:ui），或用 --resources <目录> 指定。')
  }

  return startSupervisor(workspace, resourcesDir, io, args)
}

/**
 * 启动 supervisor 并常驻到进程被终止。
 *
 * `run` 是前台命令：supervisor 活多久它就活多久。退出码按信号惯例给
 * 130 / 143，让脚本能区分「用户中断」与「启动失败」。
 */
function startSupervisor(
  workspace: Workspace,
  resourcesDir: string | undefined,
  io: CommandIO,
  args: ParsedArgs,
): Promise<number> {
  return new Promise<number>((resolve) => {
    let stopping = false
    const finish = (code: number) => {
      if (stopping) return
      stopping = true
      supervisor.stop().finally(() => resolve(code))
    }

    const supervisor = new Supervisor({
      projectRoot: workspace.projectRoot,
      resourcesDir,
      version: io.frameworkVersion,
      // --port 只在用户显式要求时生效；其余情况交给 supervisor 找空闲端口
      ...(args.port ? { port: args.port } : {}),
      // 握手的原始行是 supervisor 的对外契约，由它直接写到 stdout；
      // 这里只在同一时刻补一条人话 + 打开浏览器。
      onReady(line) {
        const url = accessUrl(line.port, line.token)
        io.out(url)
        if (line.failures.length > 0) {
          io.err(`有 ${line.failures.length} 个插件加载失败：`)
          for (const failure of line.failures) io.err(`  ${failure.id}: ${failure.reason}`)
        }
        if (args.open) io.openBrowser?.(url)
      },
    })

    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      process.on(signal, () => finish(code))
    }

    supervisor.start().then(
      // 启动后一直活着：重启由 supervisor 自己处理，命令行无需介入
      () => {},
      (error: unknown) => {
        io.err(`启动失败：${(error as Error).message}`)
        finish(1)
      },
    )
  })
}

// ---------------------------------------------------------------- add / remove

async function makeInstaller(workspace: Workspace, io: CommandIO): Promise<PluginInstaller> {
  return new PluginInstaller({
    projectRoot: workspace.projectRoot,
    frameworkVersion: io.frameworkVersion,
    ...(io.packageManager ? { run: io.packageManager } : {}),
  })
}

export async function commandAdd(args: ParsedArgs, io: CommandIO): Promise<number> {
  const spec = args.positionals[0]
  if (!spec) throw new UsageError('用法：cordis-app add <包名[@版本]>')

  const workspace = openWorkspace(args.projectDir)
  if (!requireApp(workspace, io)) return 1

  const installer = await makeInstaller(workspace, io)
  const result = await installer.install(spec)
  io.out(`已安装 ${result.id}`)
  io.out(`  ${result.reason}`)

  // 只有正在运行的项目才需要人去重启；没跑的话下次 run 自然就加载了新插件
  if (result.restarted && readRuntimeFile(workspace.runtimeJsonPath)) {
    io.out('  项目正在运行，执行 cordis-app restart 让改动生效')
  }
  return 0
}

export async function commandRemove(args: ParsedArgs, io: CommandIO): Promise<number> {
  const spec = args.positionals[0]
  if (!spec) throw new UsageError('用法：cordis-app remove <包名>')

  const workspace = openWorkspace(args.projectDir)
  if (!requireApp(workspace, io)) return 1

  const installer = await makeInstaller(workspace, io)
  const result = await installer.remove(spec)
  io.out(`已卸载 ${result.id}`)
  io.out(`  ${result.reason}`)
  if (readRuntimeFile(workspace.runtimeJsonPath)) {
    io.out('  项目正在运行，执行 cordis-app restart 让改动生效')
  }
  return 0
}

// ---------------------------------------------------------------- list

export async function commandList(args: ParsedArgs, io: CommandIO): Promise<number> {
  const workspace = openWorkspace(args.projectDir)
  const manifest = readAppManifest(workspace.appJsonPath)
  if (!manifest) {
    io.err(`找不到应用定义：${workspace.appJsonPath}`)
    return 1
  }

  const pkg = readProjectPackage(workspace.packageJsonPath)
  if (!pkg) {
    io.err(`找不到项目依赖清单：${workspace.packageJsonPath}`)
    return 1
  }

  // package.json 是依赖的事实源；app.json 不再维护第二份版本清单。
  // 框架与 React 是项目的运行底座，不是可安装/卸载的插件，列表里不展示。
  const rows = Object.entries(pkg.dependencies ?? {})
    .filter(([name]) => !FRAMEWORK_DEPENDENCIES.has(name))
    .map(([name, range]) => {
    const installed = readInstalledPackage(workspace.nodeModulesDir, name)
    const id = readPluginId(workspace.nodeModulesDir, name) ?? null
    return {
      name,
      range,
      version: installed?.version ?? '（未安装）',
      id,
      enabled: installed !== undefined && id !== null,
    }
  })

  if (args.json) {
    io.out(
      JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          plugins: rows.map(({ name, version, id, enabled }) => ({ name, version, id, enabled })),
        },
        null,
        2,
      ),
    )
    return 0
  }

  io.out(`${manifest.name} ${manifest.version}`)
  if (rows.length === 0) {
    io.out('（尚未安装任何插件）')
    return 0
  }

  const nameWidth = Math.max(...rows.map((row) => row.name.length), 4)
  const versionWidth = Math.max(...rows.map((row) => row.version.length), 4)
  const idWidth = Math.max(...rows.map((row) => (row.id ?? '-').length), 2)
  io.out(`  ${'包名'.padEnd(nameWidth)}  ${'版本'.padEnd(versionWidth)}  ${'插件 id'.padEnd(idWidth)}  状态`)
  for (const row of rows) {
    io.out(
      `  ${row.name.padEnd(nameWidth)}  ${row.version.padEnd(versionWidth)}  ${(row.id ?? '-').padEnd(idWidth)}  ${row.enabled ? '已启用' : '未启用'}`,
    )
  }
  return 0
}

/** 读已安装包的版本；包不存在或 package.json 损坏时返回 undefined。 */
function readInstalledPackage(nodeModulesDir: string, name: string): { version: string } | undefined {
  try {
    const pkg = JSON.parse(
      // 直接 join：作用域包名 `@scope/name` 正好是两层目录
      readFileSync(join(nodeModulesDir, name, 'package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ? { version: pkg.version } : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- restart

/**
 * 重启正在运行的项目。
 *
 * 走 HTTP 而不是信号：supervisor 的 pid 在 runtime.json 里，但向它发信号是
 * 「终止整个应用」的意思。真正该被重启的是 worker，而只有 supervisor 知道
 * 什么时候重新 fork 它——所以请求发给 worker 的 `/api/restart`，由它走
 * 「关监听 → 通知客户端 → exit(75)」那条既有路径。
 */
export async function commandRestart(args: ParsedArgs, io: CommandIO): Promise<number> {
  const workspace = openWorkspace(args.projectDir)
  const running = readRuntimeFile(workspace.runtimeJsonPath)
  if (!running) {
    io.err('项目没有在运行。用 cordis-app run 启动。')
    return 1
  }

  const url = `http://127.0.0.1:${running.port}/api/restart`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${running.token}` },
    })
    if (!response.ok) {
      io.err(`重启请求失败：HTTP ${response.status}`)
      return 1
    }
  } catch (error) {
    io.err(`连接不上正在运行的项目：${(error as Error).message}`)
    return 1
  }

  const healthy = await waitForRestart(running.port)
  if (!healthy) {
    io.err('重启后 30 秒内没有恢复健康检查。')
    return 1
  }

  io.out('已重启')
  io.out('  ' + accessUrl(running.port, running.token))
  return 0
}

/**
 * 等待「旧进程已下线、新进程已就绪」。
 *
 * 两段式观察的规则由 protocol 的 waitForReady 统一实现：先等健康检查失败，
 * 再等它重新变成 200。这里只提供探测手段。
 */
async function waitForRestart(port: number, timeoutMs = 30_000): Promise<boolean> {
  return waitForReady({
    requireDownFirst: true,
    timeoutMs,
    probe: async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/__health`, {
          signal: AbortSignal.timeout(1000),
        })
        return response.ok
      } catch {
        // 重启窗口内连接会被拒绝，这是预期状态
        return false
      }
    },
  })
}

/** 命令名 → 实现。`cli.ts` 只按这张表分发。 */
export const COMMAND_HANDLERS = {
  new: commandNew,
  add: commandAdd,
  remove: commandRemove,
  run: commandRun,
  restart: commandRestart,
  list: commandList,
} as const
