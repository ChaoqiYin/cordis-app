/** runtime 的公共导出。 */

export {
  startApp,
  StartAppError,
  type AppEvents,
  type AppExitEvent,
  type AppHandle,
  type SpawnSupervisor,
  type SpawnSupervisorOptions,
  type StartAppOptions,
  type SupervisorChild,
} from './start-app.js'
export { Supervisor, findFreePort, generateToken, buildWorkerEnv } from './supervisor/supervisor.js'
export { startWorker, readWorkerOptions, type WorkerHandle, type WorkerOptions } from './worker/worker.js'
export {
  PluginInstaller,
  type LayoutSnapshot,
  type InstallerOptions,
  type RecoveryResult,
} from './plugin/installer.js'
export {
  scanPlugins,
  scanPluginRoots,
  findPlugin,
  readPluginId,
  pluginFileUrl,
  validatePeer,
  isValidPluginId,
  type InstalledPlugin,
  type PluginScan,
  type PluginRoot,
  type PluginRootKind,
  type PackageJsonLike,
  type ScanOptions,
} from './plugin/catalog.js'
export {
  checkProjectFramework,
  checkProjectFrameworkFile,
  type ProjectFrameworkCheck,
} from './plugin/doctor.js'
export { loadPlugins, toDefinition } from './plugin/loader.js'
export * as builtin from './builtin/index.js'
