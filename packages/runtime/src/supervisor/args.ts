import { resolveProjectRoot } from '@cordis-app/protocol'

export interface SupervisorArgs {
  projectRoot: string
  resourcesDir?: string
}

/** 解析 supervisor 的命令行参数。项目根优先级由 protocol 统一决定。 */
export function readSupervisorArgs(argv: string[]): SupervisorArgs {
  let projectFlag: string | undefined
  let resourcesDir: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // --data 是 --project 的兼容别名：两者都是项目根，不再有独立的数据目录。
    if (arg === '--project' || arg === '--data') projectFlag = argv[++i]
    else if (arg === '--resources') resourcesDir = argv[++i]
  }

  return { projectRoot: resolveProjectRoot(projectFlag), resourcesDir }
}
