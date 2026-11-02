import { join, resolve } from 'node:path'
import { ENV_PROJECT } from './constants.js'

/**
 * 解析项目根。优先级：
 *   1. `CORDIS_APP_PROJECT`（便于脚本与外壳注入）
 *   2. 命令行 `--project <dir>`（`--data` 是它的兼容别名）
 *   3. 当前工作目录
 *
 * 项目模式下没有平台默认数据目录：用户在哪个项目里执行命令，项目就是哪个。
 */
export function resolveProjectRoot(
  cliFlag?: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const fromEnv = env[ENV_PROJECT]
  if (fromEnv) return resolve(fromEnv)
  if (cliFlag) return resolve(cliFlag)
  return resolve(cwd)
}

/**
 * 打包根的选项。
 *
 * 项目模式只需要项目根；打包应用还会从只读的内置插件根与可写的用户插件根
 * 发现插件。字段可选：缺省时不产生对应路径，项目模式的布局与以前完全一致。
 */
export interface ProjectLayoutOptions {
  /** 只读的内置插件根（打包产物，通常是 `<resourcesDir>/plugins`） */
  builtinPluginsDir?: string
  /** 可写的用户插件根（打包应用用户数据，通常是 `<userData>/plugins`） */
  userPluginsDir?: string
  /**
   * 覆盖项目本地插件根。
   *
   * `cordis-app dev` 用它指向 `.cordis/dev/plugins`：开发时由 esbuild 现场
   * 产出插件前端/服务端，源码目录保持干净。缺省仍是 `<project>/plugins`。
   */
  localPluginsDir?: string
}

/**
 * 项目根的完整布局。
 *
 * 这是「项目长什么样」的唯一出处：CLI、supervisor、worker 都从这里取路径，
 * 不再各自 `join(projectRoot, ...)`。少一处手写，就少一处漂移。
 */
export interface ProjectLayout {
  /** 项目根：`package.json` 与 `app.json` 所在目录 */
  projectRoot: string
  /** 依赖唯一真源 */
  packageJson: string
  /** 应用身份、启用插件与 UI 能力 */
  appJson: string
  /** 项目源码目录 */
  srcDir: string
  /** 项目 body 入口：默认导出 React 组件 */
  bodyEntry: string
  /** 项目页面目录 */
  pagesDir: string
  /** 项目后端源码目录 */
  serverDir: string
  /** 项目后端入口：默认导出 apply(ctx)，不是插件 */
  serverEntry: string
  /** 项目本地插件根，每个子目录一个插件包 */
  localPluginsDir: string
  /** 插件数据与用户配置根 */
  dataDir: string
  /** 用户配置：`data/config.json` */
  config: string
  /** 运行时文件目录：`runtime.json`、`tmp/`、`logs/` */
  cordisDir: string
  /** supervisor 写入的运行中快照 */
  runtimeFile: string
  /** worker 的临时目录 */
  tmpDir: string
  /** 运行时日志目录 */
  logsDir: string
  /** 构建产物目录（#7 使用） */
  distDir: string
  /** 项目依赖根 */
  nodeModulesDir: string
  /** 打包只读内置插件根（打包形态由 resources/plugins 推导） */
  builtinPluginsDir?: string
  /** 打包可写用户插件根（打包形态为 `<userData>/plugins`） */
  userPluginsDir?: string
}

/** 按项目根推导整套路径。纯函数：不读环境变量、不碰磁盘。 */
export function resolveProjectLayout(
  projectRoot: string,
  options: ProjectLayoutOptions = {},
): ProjectLayout {
  const root = resolve(projectRoot)
  const srcDir = join(root, 'src')
  const serverDir = join(root, 'server')
  const dataDir = join(root, 'data')
  const cordisDir = join(root, '.cordis')

  return {
    projectRoot: root,
    packageJson: join(root, 'package.json'),
    appJson: join(root, 'app.json'),
    srcDir,
    bodyEntry: join(srcDir, 'body.tsx'),
    pagesDir: join(srcDir, 'pages'),
    serverDir,
    serverEntry: join(serverDir, 'index.js'),
    localPluginsDir: options.localPluginsDir ?? join(root, 'plugins'),
    dataDir,
    config: join(dataDir, 'config.json'),
    cordisDir,
    runtimeFile: join(cordisDir, 'runtime.json'),
    tmpDir: join(cordisDir, 'tmp'),
    logsDir: join(cordisDir, 'logs'),
    distDir: join(root, 'dist'),
    nodeModulesDir: join(root, 'node_modules'),
    ...(options.builtinPluginsDir ? { builtinPluginsDir: options.builtinPluginsDir } : {}),
    ...(options.userPluginsDir ? { userPluginsDir: options.userPluginsDir } : {}),
  }
}
