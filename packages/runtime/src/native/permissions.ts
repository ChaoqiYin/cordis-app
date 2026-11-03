/**
 * 插件原生能力权限。
 *
 * `plugin.json.capabilities` 里的 `native:<命令>` 是唯一授权来源：
 *   - 具体命令按名字授权；
 *   - `native:window.*` 这类尾部通配在运行时展开成具体命令，审计日志里
 *     永远记录展开后的命令名；
 *   - 敏感原语（`window.close`、`shell.openExternal`、`shell.openPath`、`path.chooseSave`）
 *     必须单独列出，通配不会顺带授予它们。
 *
 * 未知的 `native:` 值与其它前缀一律忽略：它们无法匹配到命令表，也就不会
 * 扩大权限。项目 server 不经过这里，直接使用根 ctx 上的全量服务。
 */

import { NATIVE_COMMANDS, type NativeCommand, type PluginCapability } from '@cordis-app/protocol'

/** 需要单独授权的敏感命令；通配展开时跳过。 */
export const NATIVE_SENSITIVE_COMMANDS: ReadonlySet<NativeCommand> = new Set([
  'window.close',
  'shell.openExternal',
  'shell.openPath',
  'path.chooseSave',
])

/**
 * 把插件声明的 capabilities 展开成命令集合。
 *
 * 返回的集合只包含当前命令表里的命令，调用方可以安全地用它做白名单。
 */
export function nativeCapabilityCommands(
  capabilities: readonly PluginCapability[] | undefined,
): Set<NativeCommand> {
  const allowed = new Set<NativeCommand>()

  for (const capability of capabilities ?? []) {
    if (!capability.startsWith('native:')) continue
    const declared = capability.slice('native:'.length)

    if (declared.endsWith('*')) {
      const prefix = declared.slice(0, -1)
      // 只接受 `*` 或 `<资源>.*`；`window*` 这类写法含义含糊，直接忽略。
      if (prefix !== '' && !prefix.endsWith('.')) continue
      for (const command of NATIVE_COMMANDS) {
        if (command.startsWith(prefix) && !NATIVE_SENSITIVE_COMMANDS.has(command)) {
          allowed.add(command)
        }
      }
      continue
    }

    if (isNativeCommand(declared)) allowed.add(declared)
  }

  return allowed
}

function isNativeCommand(value: string): value is NativeCommand {
  return (NATIVE_COMMANDS as readonly string[]).includes(value)
}
