/**
 * 原生能力契约的类型面。
 *
 * 这是编译期测试：`node --test` 只负责执行它，真正的断言由 `tsc` 在
 * `pnpm typecheck` 时检查。它钉住调用方依赖的三件事——命令名恰好 15 条、
 * 输入输出按命令名映射、`PluginCapability` 接受 `native:` 前缀。
 */

import type {
  NativeCommand,
  NativeCommandMap,
  NativeFailure,
  NativeInfo,
  NativeInvokeRequest,
  NativeInvokeResponse,
  NativeInput,
  NativeOutput,
  NativeSuccess,
  NativeErrorCode,
} from '../src/native.js'
import type { PluginCapability } from '../src/types.js'

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type Assert<T extends true> = T

type ExpectedCommand =
  | 'path.chooseOpen'
  | 'path.chooseDirectory'
  | 'path.chooseSave'
  | 'window.setTitle'
  | 'window.setSize'
  | 'window.minimize'
  | 'window.maximize'
  | 'window.restore'
  | 'window.focus'
  | 'window.close'
  | 'window.state'
  | 'notification.show'
  | 'shell.openExternal'
  | 'shell.showItemInFolder'
  | 'system.info'

type ExpectedErrorCode =
  | 'cancelled'
  | 'unsupported'
  | 'denied'
  | 'busy'
  | 'invalid'
  | 'timeout'
  | 'internal'

// NativeCommand 恰好覆盖 ADR 0003 的 15 条命令，命令映射没有多余键。
type _Commands = Assert<Equals<NativeCommand, ExpectedCommand>>
type _MapKeys = Assert<Equals<keyof NativeCommandMap, NativeCommand>>
type _ErrorCodes = Assert<Equals<NativeErrorCode, ExpectedErrorCode>>

// 输入与输出按命令名索引：调用方拿到的就是对应命令的形状。
const chooseSaveInput: NativeInput<'path.chooseSave'> = {
  filters: [{ name: 'CSV', extensions: ['csv'] }],
  defaultName: 'export.csv',
}
const chooseSaveOutput: NativeOutput<'path.chooseSave'> = { path: '/tmp/export.csv' }
const windowState: NativeOutput<'window.state'> = {
  maximized: false,
  minimized: false,
  focused: true,
  size: { width: 800, height: 600 },
}

// /invoke 的请求是判别联合，command 决定 input 类型。
const request: NativeInvokeRequest = {
  command: 'path.chooseOpen',
  input: { multiple: true, filters: [{ name: '图片', extensions: ['png', 'jpg'] }] },
}

// @ts-expect-error 未知命令不属于 v1 契约
const unknownCommand: NativeCommand = 'window.nope'

// @ts-expect-error window.setSize 的输入必须是 width / height
const mismatchedInput: NativeInvokeRequest = { command: 'window.setSize', input: { title: 'x' } }

// 成功与失败共用同一个 envelope；失败一律携带固定错误码。
const success: NativeSuccess<{ paths: string[] }> = { ok: true, value: { paths: ['/tmp/a.csv'] } }
const cancelled: NativeInvokeResponse = { ok: false, code: 'cancelled' }
const unsupported: NativeFailure = {
  ok: false,
  code: 'unsupported',
  platform: 'linux',
  message: '未找到 zenity/kdialog',
}

const info: NativeInfo = {
  contractVersion: 1,
  platform: 'darwin',
  arch: 'arm64',
  hasWindow: true,
  commands: ['system.info'],
}

// 插件能力：具体命令与通配都接受，原有能力保持可用。
const nativeCommandCapability: PluginCapability = 'native:window.state'
const nativeWildcardCapability: PluginCapability = 'native:window.*'
const existingCapability: PluginCapability = 'fs:read'

// @ts-expect-error native 能力必须带前缀
const missingPrefix: PluginCapability = 'window.state'

void [
  chooseSaveInput,
  chooseSaveOutput,
  windowState,
  request,
  unknownCommand,
  mismatchedInput,
  success,
  cancelled,
  unsupported,
  info,
  nativeCommandCapability,
  nativeWildcardCapability,
  existingCapability,
  missingPrefix,
]
