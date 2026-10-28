/** CLI 的公共导出。bin 入口在 `cli.js`，这里供测试与其他包调用。 */

export { parseArgs, UsageError, HELP_TEXT, type ParsedArgs, type CommandName } from './args.js'
export {
  COMMAND_HANDLERS,
  commandAdd,
  commandList,
  commandNew,
  commandRemove,
  commandRestart,
  commandRun,
  defaultIO,
  type CommandIO,
} from './commands.js'
export {
  accessUrl,
  createApp,
  expandPath,
  findResourcesDir,
  openWorkspace,
  readAppLock,
  readAppManifest,
  readRuntimeFile,
  isProcessAlive,
  type Workspace,
} from './workspace.js'
export { main } from './cli.js'
