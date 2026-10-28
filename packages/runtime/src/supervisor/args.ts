import { resolveDataDir } from '@cordis-app/protocol'

export interface SupervisorArgs {
  dataDir: string
  resourcesDir?: string
}

/** 解析 supervisor 的命令行参数。数据目录优先级由 protocol 统一决定。 */
export function readSupervisorArgs(argv: string[]): SupervisorArgs {
  let dataFlag: string | undefined
  let resourcesDir: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--data') dataFlag = argv[++i]
    else if (arg === '--resources') resourcesDir = argv[++i]
  }

  return { dataDir: resolveDataDir(dataFlag), resourcesDir }
}
