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

/** 实例根目录。实例名固定为 default，`instances/` 这一层为目录整体迁移而保留。 */
export function instanceDir(dataDir: string, name = 'default'): string {
  return join(dataDir, 'instances', name)
}
