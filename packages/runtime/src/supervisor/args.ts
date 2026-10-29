import { resolveProjectRoot, type RuntimeMode } from '@cordis-app/protocol'

export interface SupervisorArgs {
  projectRoot: string
  resourcesDir?: string
  serverEntry?: string
  localPluginsDir?: string
  userPluginsDir?: string
  mode?: RuntimeMode
  dev: boolean
}

/** 运行形态只接受两个值；拼错参数必须立刻报错，而不是悄悄回退到项目模式。 */
function parseMode(value: string | undefined): RuntimeMode | undefined {
  if (value === undefined) return undefined
  if (value === 'project' || value === 'packaged') return value
  throw new Error(`未知运行形态：${value}（只支持 project / packaged）`)
}

/** 解析 supervisor 的命令行参数。项目根优先级由 protocol 统一决定。 */
export function readSupervisorArgs(argv: string[]): SupervisorArgs {
  let projectFlag: string | undefined
  let resourcesDir: string | undefined
  let serverEntry: string | undefined
  let localPluginsDir: string | undefined
  let userPluginsDir: string | undefined
  let mode: RuntimeMode | undefined
  let dev = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // --data 是 --project 的兼容别名：两者都是项目根，不再有独立的数据目录。
    if (arg === '--project' || arg === '--data') projectFlag = argv[++i]
    else if (arg === '--resources') resourcesDir = argv[++i]
    else if (arg === '--server-entry') serverEntry = argv[++i]
    else if (arg === '--local-plugins') localPluginsDir = argv[++i]
    else if (arg === '--user-plugins') userPluginsDir = argv[++i]
    else if (arg === '--mode') mode = parseMode(argv[++i])
    else if (arg === '--dev') dev = true
  }

  return {
    projectRoot: resolveProjectRoot(projectFlag),
    ...(resourcesDir ? { resourcesDir } : {}),
    ...(serverEntry ? { serverEntry } : {}),
    ...(localPluginsDir ? { localPluginsDir } : {}),
    ...(userPluginsDir ? { userPluginsDir } : {}),
    ...(mode ? { mode } : {}),
    dev,
  }
}
