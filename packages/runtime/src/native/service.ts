/**
 * `ctx.native` 服务。
 *
 * 把 client 包成项目与插件作者看到的接口，并在每次调用后写一条审计日志：
 * 调用方、命令、结果码、耗时。没有外壳时 client 缺省不可用，所有调用返回
 * `unsupported`，但审计仍然照写，便于确认降级是否按预期发生。
 */

import type { Logger, NativeInvokeOptions, NativeService } from '@cordis-app/kernel'
import type { NativeCommand, NativeInput, NativeResult } from '@cordis-app/protocol'
import { connectNativeClient, type NativeClient, type NativeClientOptions } from './client.js'

export interface NativeServiceOptions {
  /** 外壳端点；缺省表示没有外壳（浏览器模式、`cordis-app run`）。 */
  client?: NativeClientOptions
  logger: Logger
  /** 审计日志里的调用方；项目 server 记为 `project`。 */
  caller: string
}

export async function createNativeService(options: NativeServiceOptions): Promise<NativeService> {
  const client: NativeClient | undefined = options.client
    ? await connectNativeClient(options.client, options.logger)
    : undefined

  return {
    get available() {
      return client?.available ?? false
    },
    commands() {
      return client?.commands() ?? []
    },
    async invoke<C extends NativeCommand>(
      command: C,
      input: NativeInput<C>,
      invokeOptions?: NativeInvokeOptions,
    ): Promise<NativeResult<C>> {
      const startedAt = performance.now()
      const result: NativeResult<C> = client
        ? await client.invoke(command, input, invokeOptions)
        : { ok: false, code: 'unsupported', message: '当前没有可用的原生外壳' }
      const code = result.ok ? 'ok' : result.code
      options.logger.info(
        `native caller=${options.caller} command=${command} code=${code} durationMs=${Math.round(performance.now() - startedAt)}`,
      )
      return result
    },
  }
}
