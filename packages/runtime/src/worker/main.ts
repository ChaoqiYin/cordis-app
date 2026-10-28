/**
 * worker 的进程入口。
 *
 * 这里只做两件事：读环境变量、把 fatal 错误变成明确的退出码。
 * 其余全部在 startWorker 里，便于测试直接调用而不 fork。
 */

import { startWorker, readWorkerOptions } from './worker.js'

async function main() {
  const options = readWorkerOptions()
  await startWorker(options)
}

main().catch((error) => {
  process.stderr.write(`[worker] 启动失败: ${(error as Error).stack ?? error}\n`)
  process.exit(1)
})
