/**
 * 命令行参数解析。
 *
 * 刻意不引 commander / yargs：这里只有六个子命令、十来个开关，手写解析的
 * 代码量远小于「理解一个框架的错误信息」，也不会为了一段 --help 的排版
 * 引入一份运行时依赖。
 */

export type CommandName = 'new' | 'add' | 'remove' | 'run' | 'restart' | 'list' | 'help'

export interface ParsedArgs {
  command: CommandName
  /** 位置参数，例如 `add foo` 的 foo */
  positionals: string[]
  /** `--project <dir>`；`--data <dir>` 是兼容别名，含义同样是项目根 */
  projectDir?: string
  /** `--resources <dir>` */
  resourcesDir?: string
  /** `--port <n>`：仅 run 用，强制指定端口 */
  port?: number
  /** `--no-open`：run 不尝试打开浏览器 */
  open: boolean
  /** `--json`：list 输出机器可读格式 */
  json: boolean
  /** `--version` / `-v` */
  showVersion: boolean
}

const COMMANDS: readonly CommandName[] = ['new', 'add', 'remove', 'run', 'restart', 'list', 'help']

export class UsageError extends Error {}

/**
 * 解析 argv（不含 node 与脚本路径）。
 *
 * 未知开关直接报错而不是忽略：命令行里多打一个字母时，静默忽略会让人以为
 * 「参数生效了」，实际却跑在默认配置上——这类错误在部署脚本里极难发现。
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: 'help',
    positionals: [],
    open: true,
    json: false,
    showVersion: false,
  }

  let commandSeen = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    if (arg === '--help' || arg === '-h') return { ...parsed, command: 'help' }
    if (arg === '--version' || arg === '-v') return { ...parsed, showVersion: true }

    if (arg.startsWith('--')) {
      const [flag, inline] = splitFlag(arg)
      const take = (): string => {
        if (inline !== undefined) return inline
        const next = argv[++i]
        if (next === undefined) throw new UsageError(`${flag} 需要一个值`)
        return next
      }
      switch (flag) {
        case '--project':
        case '--data':
          parsed.projectDir = take()
          break
        case '--resources':
          parsed.resourcesDir = take()
          break
        case '--port': {
          const raw = take()
          const port = Number(raw)
          if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            throw new UsageError(`--port 需要一个 1-65535 的整数，收到 ${raw}`)
          }
          parsed.port = port
          break
        }
        case '--no-open':
          parsed.open = false
          break
        case '--json':
          parsed.json = true
          break
        default:
          throw new UsageError(`未知选项 ${flag}`)
      }
      continue
    }

    if (!commandSeen) {
      if (!COMMANDS.includes(arg as CommandName)) throw new UsageError(`未知命令 ${arg}`)
      parsed.command = arg as CommandName
      commandSeen = true
      continue
    }

    parsed.positionals.push(arg)
  }

  return parsed
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  return eq === -1 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)]
}

export const HELP_TEXT = `cordis-app —— 应用与插件的命令行

用法：
  cordis-app new <名字>                     创建一个新项目
  cordis-app add <包名[@版本]>              安装插件
  cordis-app remove <包名>                  卸载插件
  cordis-app run                            启动项目并打印访问地址
  cordis-app restart                        重启正在运行的项目
  cordis-app list [--json]                  列出项目依赖中的插件

通用选项：
  --project <目录>     项目根（默认当前目录，可用 CORDIS_APP_PROJECT 覆盖）
  --data <目录>        --project 的兼容别名
  --resources <目录>   UI 产物目录（默认自动探测）
  --port <端口>        仅 run：强制使用指定端口
  --no-open            仅 run：不尝试打开浏览器
  --json               仅 list：输出 JSON
  -v, --version        显示版本
  -h, --help           显示这段帮助
`
