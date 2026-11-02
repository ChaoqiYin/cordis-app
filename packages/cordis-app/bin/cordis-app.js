#!/usr/bin/env node
/**
 * `cordis-app` CLI 的 bin 入口。
 *
 * 命令实现全部在 `@cordis-app/cli`；聚合包只提供稳定的可执行文件名。
 * 版本号同样来自框架唯一真源（见 packages/protocol/src/version.ts），
 * 因此 `cordis-app --version` 与握手、`/__health`、peer 校验用的是同一个值。
 */

import { main } from '@cordis-app/cli'

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`[cordis-app] 未捕获的错误：${(error && error.stack) || error}\n`)
    process.exit(1)
  },
)
