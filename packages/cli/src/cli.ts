#!/usr/bin/env node
/**
 * CLI 进程入口。
 *
 * 只做三件事：解析参数、分发命令、把结果变成退出码。任何一条命令的内部逻辑
 * 都在 commands.ts 里，因此这里可以保持「读一遍就懂」的长度。
 */

import { parseArgs, UsageError, HELP_TEXT } from './args.js'
import { COMMAND_HANDLERS, defaultIO, type CommandIO } from './commands.js'

const VERSION = '1.0.0'

export async function main(argv: string[], io: CommandIO = defaultIO): Promise<number> {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message)
      io.err('')
      io.err(HELP_TEXT)
      return 2
    }
    throw error
  }

  if (parsed.showVersion) {
    io.out(VERSION)
    return 0
  }

  if (parsed.command === 'help') {
    io.out(HELP_TEXT)
    return 0
  }

  const handler = COMMAND_HANDLERS[parsed.command]
  try {
    return await handler(parsed, io)
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(error.message)
      return 2
    }
    io.err(`执行失败：${(error as Error).message}`)
    // 安装失败需要看到完整栈才知道是哪一步（包管理器？peer 校验？写盘？）
    if (process.env.CORDIS_APP_DEBUG) io.err((error as Error).stack ?? '')
    return 1
  }
}

// 作为 bin 运行时才执行；被测试 import 时不触发
const isEntry = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isEntry || process.env.CORDIS_APP_CLI_FORCE_MAIN) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[cordis-app] 未捕获的错误：${(error as Error).stack ?? error}\n`)
      process.exit(1)
    },
  )
}
