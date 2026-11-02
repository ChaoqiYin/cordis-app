import { parseRuntimeMode, resolveProjectRoot, type RuntimeMode } from '@cordis-app/protocol'
import type { SupervisorOptions } from './supervisor.js'

export interface SupervisorArgs {
  projectRoot: string
  resourcesDir?: string
  serverEntry?: string
  appJson?: string
  localPluginsDir?: string
  userPluginsDir?: string
  mode?: RuntimeMode
  /**
   * 覆盖 worker 入口。
   *
   * 桌面安装包把打包后的 worker 放在 `bin/cordis-app-worker.mjs`，入口不由
   * 模块相对路径推导，必须显式传入。
   */
  workerPath?: string
  dev: boolean
}

/** 解析 supervisor 的命令行参数。项目根优先级由 protocol 统一决定。 */
export function readSupervisorArgs(argv: string[]): SupervisorArgs {
  let projectFlag: string | undefined
  let resourcesDir: string | undefined
  let serverEntry: string | undefined
  let appJson: string | undefined
  let localPluginsDir: string | undefined
  let userPluginsDir: string | undefined
  let mode: RuntimeMode | undefined
  let workerPath: string | undefined
  let dev = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // --data 是 --project 的兼容别名：两者都是项目根，不再有独立的数据目录。
    if (arg === '--project' || arg === '--data') projectFlag = argv[++i]
    else if (arg === '--resources') resourcesDir = argv[++i]
    else if (arg === '--server-entry') serverEntry = argv[++i]
    else if (arg === '--app-json') appJson = argv[++i]
    else if (arg === '--local-plugins') localPluginsDir = argv[++i]
    else if (arg === '--user-plugins') userPluginsDir = argv[++i]
    else if (arg === '--mode') mode = parseRuntimeMode(argv[++i])
    else if (arg === '--worker') workerPath = argv[++i]
    else if (arg === '--dev') dev = true
  }

  return {
    projectRoot: resolveProjectRoot(projectFlag),
    ...(resourcesDir ? { resourcesDir } : {}),
    ...(serverEntry ? { serverEntry } : {}),
    ...(appJson ? { appJson } : {}),
    ...(localPluginsDir ? { localPluginsDir } : {}),
    ...(userPluginsDir ? { userPluginsDir } : {}),
    ...(mode ? { mode } : {}),
    ...(workerPath ? { workerPath } : {}),
    dev,
  }
}

/**
 * 把解析后的参数映射成 Supervisor 的构造选项。
 *
 * 入口只调用这一处，避免字段被手工挑拣时静默丢弃（`--app-json` 曾经如此）。
 * 纯函数，便于直接测试每个字段的存活情况。
 */
export function toSupervisorOptions(args: SupervisorArgs): SupervisorOptions {
  return {
    projectRoot: args.projectRoot,
    ...(args.resourcesDir ? { resourcesDir: args.resourcesDir } : {}),
    ...(args.serverEntry ? { serverEntry: args.serverEntry } : {}),
    ...(args.appJson ? { appJson: args.appJson } : {}),
    ...(args.localPluginsDir ? { localPluginsDir: args.localPluginsDir } : {}),
    ...(args.userPluginsDir ? { userPluginsDir: args.userPluginsDir } : {}),
    ...(args.mode ? { mode: args.mode } : {}),
    ...(args.workerPath ? { workerPath: args.workerPath } : {}),
    ...(args.dev ? { dev: true } : {}),
  }
}
