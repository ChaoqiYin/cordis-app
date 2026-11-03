/**
 * `ctx.native` 服务。
 *
 * 把 client 包成项目与插件作者看到的接口，并在每次调用后写一条审计日志：
 * 调用方、命令、结果码、耗时。没有外壳时 client 缺省不可用，所有调用返回
 * `unsupported`，但审计仍然照写，便于确认降级是否按预期发生。
 *
 * 项目 server 使用根 ctx 上的全量服务；插件拿到的是 `forPlugin` 生成的受限
 * 视图：`commands()` 只列出已声明且平台可用的命令，`invoke` 在调用 client
 * 之前再校验一次，未声明时返回 `denied`，请求不会到达外壳。
 */

import type { Logger, NativeInvokeOptions, NativeService } from '@cordis-app/kernel'
import type {
  NativeCommand,
  NativeInput,
  NativeResult,
  PluginCapability,
} from '@cordis-app/protocol'
import { connectNativeClient, type NativeClient, type NativeClientOptions } from './client.js'
import { nativeCapabilityCommands } from './permissions.js'

/** 一个 worker 内共享同一 client 的服务集合。 */
export interface NativeServices {
  /** 项目 server 与根 ctx 使用的全量服务。 */
  project: NativeService
  /** 某个插件的受限视图；权限来自它自己的 `plugin.json.capabilities`。 */
  forPlugin(pluginId: string, capabilities: readonly PluginCapability[] | undefined): NativeService
}

/**
 * 为一个 worker 创建共享 client 的服务集合。
 *
 * 插件视图不能各自 `GET /info`：外壳连接只建立一次，权限差异只体现在
 * 允许的命令集合上。
 */
export async function createNativeServices(options: {
  client?: NativeClientOptions
  logger: Logger
}): Promise<NativeServices> {
  const client = await connect(options)

  return {
    project: buildNativeService(options.logger, 'project', client),
    forPlugin(pluginId, capabilities) {
      return buildNativeService(
        options.logger,
        pluginId,
        client,
        nativeCapabilityCommands(capabilities),
      )
    },
  }
}

async function connect(options: {
  client?: NativeClientOptions
  logger: Logger
}): Promise<NativeClient | undefined> {
  return options.client
    ? await connectNativeClient(options.client, options.logger)
    : undefined
}

function buildNativeService(
  logger: Logger,
  caller: string,
  client: NativeClient | undefined,
  allowed?: ReadonlySet<NativeCommand>,
): NativeService {
  return {
    get available() {
      return client?.available ?? false
    },
    commands() {
      const commands = client?.commands() ?? []
      // 受限视图只暴露声明过的命令，插件据此决定 UI 分支时不会看到越权能力。
      return allowed ? commands.filter((command) => allowed.has(command)) : commands
    },
    async invoke<C extends NativeCommand>(
      command: C,
      input: NativeInput<C>,
      invokeOptions?: NativeInvokeOptions,
    ): Promise<NativeResult<C>> {
      const startedAt = performance.now()
      let result: NativeResult<C>
      if (allowed && !allowed.has(command)) {
        // 校验发生在 client 之前：未声明的命令不会产生任何原生请求。
        result = {
          ok: false,
          code: 'denied',
          message: `插件 ${caller} 未声明原生命令 ${command}`,
        }
      } else {
        result = client
          ? await client.invoke(command, input, invokeOptions)
          : { ok: false, code: 'unsupported', message: '当前没有可用的原生外壳' }
      }
      const code = result.ok ? 'ok' : result.code
      const line = `native caller=${caller} command=${command} code=${code} durationMs=${Math.round(performance.now() - startedAt)}`
      // 成功是常规事件；denied / unsupported 与其它失败码需要进入 warn，
      // 才能在不提高全局日志级别的情况下看到权限拒绝与降级。
      if (result.ok) logger.info(line)
      else logger.warn(line)
      return result
    },
  }
}
