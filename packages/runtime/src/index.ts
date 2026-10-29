/** runtime 的公共导出。 */

export { Supervisor, findFreePort, generateToken, buildWorkerEnv } from './supervisor/supervisor.js'
export { startWorker, readWorkerOptions, type WorkerHandle, type WorkerOptions } from './worker/worker.js'
export {
  PluginInstaller,
  DEFAULT_JOURNAL,
  type LayoutSnapshot,
  type InstallerOptions,
  type RecoveryResult,
} from './plugin/installer.js'
export { NpmInstallSource, NPM_LOCKFILE_NAMES, type NpmSourceOptions } from './plugin/npm-source.js'
export { BundleInstallSource, type BundleSourceOptions } from './plugin/bundle-source.js'
export {
  BUNDLE_FILE,
  INSTALLED_FILE,
  BUNDLE_FORMAT_VERSION,
  BUNDLE_SIGNATURE_CONTEXT,
  computeBundleHash,
  bundleSignaturePayload,
  parseBundleManifest,
  verifyBundleSignature,
  loadPublicKey,
  readInstalledIndex,
  writeInstalledIndex,
  type BundleManifest,
  type InstalledBundleEntry,
  type InstalledIndex,
  type PublicKeyInput,
} from './plugin/bundle-format.js'
export {
  readTarGz,
  readTar,
  createTarGz,
  createTar,
  DEFAULT_MAX_BUNDLE_BYTES,
  type TarReadOptions,
} from './plugin/tar.js'
export {
  type InstallSource,
  type InstallSourceKind,
  type InstallContext,
  type SourceInstallResult,
  uiCompatibilityFor,
  safeJoinWithin,
} from './plugin/install-source.js'
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
