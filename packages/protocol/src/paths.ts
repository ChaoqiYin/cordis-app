import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { ENV_DATA } from './constants.js'

/** 平台 -> 默认数据目录。与文档 3.2 的顺序表一致。 */
export function defaultDataDir(): string {
  const plat = platform()
  if (plat === 'win32') {
    const base = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    return join(base, 'cordis-app')
  }
  if (plat === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'cordis-app')
  }
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdg, 'cordis-app')
}

/**
 * 按文档 3.2 的顺序解析数据目录，先命中者生效：
 * 1. `CORDIS_APP_DATA` 环境变量
 * 2. 命令行 `--data <dir>`
 * 3. 平台标准目录
 *
 * 注意优先级：环境变量高于命令行，与文档顺序一致。
 */
export function resolveDataDir(cliFlag?: string, env?: NodeJS.ProcessEnv): string {
  const fromEnv = (env ?? process.env)[ENV_DATA]
  if (fromEnv) return fromEnv
  if (cliFlag) return cliFlag
  return defaultDataDir()
}

/** 实例名固定为 default。`instances/` 这一层为将来多实例预留。 */
export const DEFAULT_INSTANCE = 'default'

/**
 * 数据目录的完整布局。
 *
 * 这是「数据目录长什么样」的唯一出处：supervisor、worker、CLI 都从这里取路径，
 * 不再各自 `join(dataDir, 'instances', 'default', ...)`。少一处手写，就少一处
 * 「CLI 装的插件 worker 看不到」式的漂移。
 */
export interface DataLayout {
  /** 数据根目录（`--data` / `CORDIS_APP_DATA` / 平台默认） */
  dataDir: string
  /** 实例根目录：`instances/<name>` */
  instanceDir: string
  appJson: string
  appLock: string
  packageJson: string
  config: string
  /** 插件运行期数据的根目录（storage 内置插件按插件 id 分目录） */
  pluginDataDir: string
  nodeModulesDir: string
  /** 正在运行的实例快照（supervisor 写入，CLI / 外壳拉取） */
  runtimeFile: string
  tmpDir: string
}

/** 按数据目录推导整套路径。纯函数：不读环境变量、不碰磁盘。 */
export function resolveLayout(dataDir: string, name = DEFAULT_INSTANCE): DataLayout {
  const instanceDir = join(dataDir, 'instances', name)
  return {
    dataDir,
    instanceDir,
    appJson: join(instanceDir, 'app.json'),
    appLock: join(instanceDir, 'app.lock'),
    packageJson: join(instanceDir, 'package.json'),
    config: join(instanceDir, 'config.json'),
    pluginDataDir: join(instanceDir, 'data'),
    nodeModulesDir: join(instanceDir, 'node_modules'),
    runtimeFile: join(dataDir, 'runtime.json'),
    tmpDir: join(dataDir, 'tmp'),
  }
}
