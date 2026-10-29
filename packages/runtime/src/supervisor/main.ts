/**
 * supervisor 的 CLI 入口。
 *
 * 只做参数解析与信号处理，逻辑全在 Supervisor 类里，便于测试。
 */
import { readSupervisorArgs } from './args.js'
import { Supervisor } from './supervisor.js'

const options = readSupervisorArgs(process.argv.slice(2))
const supervisor = new Supervisor({ projectRoot: options.projectRoot, resourcesDir: options.resourcesDir })

const handshake = await supervisor.start()
// 握手行已经写到 stdout；这里在 stderr 记一条供人阅读的信息。
process.stderr.write(
  `[supervisor] ready at http://127.0.0.1:${handshake.port} (${handshake.failures.length} failures)\n`,
)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    supervisor.stop().finally(() => process.exit(0))
  })
}
