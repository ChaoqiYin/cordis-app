/**
 * CLI 眼中的项目布局与项目文件读写。
 *
 * 路径推导全部复用 protocol 的 `resolveProjectLayout`——命令行与 worker 若在
 * 这一层各写一份，就会出现「CLI 装的插件 worker 看不到」。
 *
 * CLI 只碰这些文件：
 *   - `package.json`   依赖唯一真源（包管理器读写）
 *   - `app.json`       应用身份与启用顺序
 *   - `.cordis/runtime.json` 正在运行的项目（由 supervisor 写入）
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isRuntimeFile,
  resolveProjectLayout,
  resolveProjectRoot,
  type AppManifest,
  type ProjectLayout,
  type RuntimeFile,
} from '@cordis-app/protocol'

/** 新项目的初始版本号。框架版本由 app.json 之外的 package.json 约束。 */
const PROJECT_VERSION = '0.1.0'

export interface Workspace {
  projectRoot: string
  layout: ProjectLayout
  appJsonPath: string
  packageJsonPath: string
  runtimeJsonPath: string
  nodeModulesDir: string
  configPath: string
}

export function openWorkspace(projectFlag?: string): Workspace {
  const layout = resolveProjectLayout(resolveProjectRoot(projectFlag))
  return {
    projectRoot: layout.projectRoot,
    layout,
    appJsonPath: layout.appJson,
    packageJsonPath: layout.packageJson,
    runtimeJsonPath: layout.runtimeFile,
    nodeModulesDir: layout.nodeModulesDir,
    configPath: layout.config,
  }
}

/** 读 app.json；缺失或损坏时返回 undefined，由调用方决定是「新建」还是「报错」。 */
export function readAppManifest(path: string): AppManifest | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as AppManifest
  } catch {
    return undefined
  }
}

/** 项目 package.json 中 CLI 关心的字段。 */
export interface ProjectPackageJson {
  name?: string
  version?: string
  private?: boolean
  type?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export function readProjectPackage(path: string): ProjectPackageJson | undefined {
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return parsed as ProjectPackageJson
  } catch {
    return undefined
  }
}

/**
 * 读 runtime.json 并确认进程还活着。
 *
 * runtime.json 是派生文件，进程被强杀时会残留。只检查文件存在会把「上一个
 * 项目留下的尸体」当成正在运行。pid 存活检查是让这个文件可信的唯一手段。
 */
export function readRuntimeFile(path: string): RuntimeFile | undefined {
  if (!existsSync(path)) return undefined
  let file: RuntimeFile
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as RuntimeFile
  } catch {
    return undefined
  }
  if (!isRuntimeFile(file)) return undefined
  if (!isProcessAlive(file.pid)) return undefined
  return file
}

export function isProcessAlive(pid: number): boolean {
  try {
    // 信号 0 只做权限与存在性探测，不会真的发出信号
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 说明进程存在，只是不属于当前用户
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 访问地址。token 放在 fragment 里，不会进入服务端日志，也不会随 Referer 外泄。 */
export function accessUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/#token=${encodeURIComponent(token)}`
}

/**
 * 找 UI 产物目录。
 *
 * 三种部署形态都要能跑：
 *   - 随 CLI 包分发：`<cli 包>/resources/ui`
 *   - 仓库内开发：`packages/ui/dist/ui`
 *   - 项目构建产物：`<project>/dist/ui`
 *
 * 找不到不是错误——`new` / `add` / `remove` 完全不碰 UI，只有 `run` 需要它。
 */
export function findResourcesDir(projectRoot?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    // lib/ → 包根 → resources/
    join(here, '..', 'resources'),
    // 仓库内：packages/cli/lib → packages/ui/dist
    join(here, '..', '..', 'ui', 'dist'),
    join(here, '..', '..', '..', 'resources'),
    // 项目自己的构建产物（#7 的 build 约定）
    ...(projectRoot ? [join(projectRoot, 'dist'), join(projectRoot, 'resources')] : []),
  ]
  return candidates.find((dir) => existsSync(join(dir, 'ui', 'index.html')))
}

export interface CreateProjectOptions {
  name: string
  root: string
  frameworkVersion: string
}

export interface CreatedProject {
  projectRoot: string
  appJsonPath: string
  packageJsonPath: string
  bodyEntry: string
  serverEntry: string
}

/**
 * 创建一个可运行的项目根。
 *
 * 只写文件，不联网、不执行包管理器：`new` 的价值是「从零到能启动后端」，
 * 依赖安装交给用户自己的包管理器（或后续的 add 命令）。
 */
export function createProject(options: CreateProjectOptions): CreatedProject {
  const layout = resolveProjectLayout(options.root)
  mkdirSync(options.root, { recursive: true })
  for (const dir of [
    layout.srcDir,
    layout.pagesDir,
    layout.serverDir,
    layout.localPluginsDir,
    layout.dataDir,
    layout.cordisDir,
  ]) {
    mkdirSync(dir, { recursive: true })
  }

  const manifest: AppManifest = {
    name: options.name,
    version: PROJECT_VERSION,
    plugins: [],
    ui: {
      pages: true,
      slots: ['header.right', 'activity.bottom'],
      menus: ['activity'],
      settings: true,
    },
  }
  writeJson(layout.appJson, manifest)
  writeJson(layout.packageJson, {
    name: packageNameOf(options.name),
    version: PROJECT_VERSION,
    private: true,
    type: 'module',
    scripts: {
      dev: 'cordis-app dev',
      build: 'cordis-app build',
      start: 'cordis-app start',
    },
    dependencies: {
      'cordis-app': `^${options.frameworkVersion}`,
      react: '^19.0.0',
      'react-dom': '^19.0.0',
    },
  })

  writeFileSync(layout.bodyEntry, BODY_TEMPLATE)
  writeFileSync(join(layout.pagesDir, 'Home.tsx'), HOME_PAGE_TEMPLATE)
  writeFileSync(layout.serverEntry, SERVER_ENTRY_TEMPLATE)
  writeFileSync(join(layout.projectRoot, '.gitignore'), GITIGNORE)

  // 空目录在 git 中不存在；放一个占位文件，让用户 clone 后目录结构完整。
  for (const dir of [layout.localPluginsDir, layout.dataDir, layout.cordisDir]) {
    writeFileSync(join(dir, '.gitkeep'), '')
  }

  return {
    projectRoot: layout.projectRoot,
    appJsonPath: layout.appJson,
    packageJsonPath: layout.packageJson,
    bodyEntry: layout.bodyEntry,
    serverEntry: layout.serverEntry,
  }
}

/** 把相对路径（含 `~`）展开成绝对路径，命令行里手打路径的常见写法。 */
export function expandPath(input: string): string {
  const expanded = input === '~' || input.startsWith('~/') ? join(process.env.HOME ?? '', input.slice(1)) : input
  return resolve(expanded)
}

/** 目录是否已有内容。`new` 只在空目录（或尚不存在的目录）里落盘。 */
export function isDirectoryNonEmpty(path: string): boolean {
  if (!existsSync(path)) return false
  if (!statSync(path).isDirectory()) return true
  return readdirSync(path).length > 0
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

/** npm 包名：小写，只保留合法字符。应用展示名仍用用户输入。 */
function packageNameOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'cordis-app-project'
}

const BODY_TEMPLATE = `import type { ReactElement } from 'react'
import { DefaultBody } from 'cordis-app/ui'

/**
 * 项目 body 入口。
 *
 * 默认转出框架的参考布局；布局、导航和项目页面都可以在这里替换。
 * 自定义时请保留宿主出口：PluginPageOutlet、PluginSlot、PluginMenuTrigger、
 * SettingsPanel，并让 app.json.ui 声明的能力与实际布局一致。
 */
export default function Body(): ReactElement {
  return <DefaultBody />
}
`

const HOME_PAGE_TEMPLATE = `import type { ReactElement } from 'react'

export default function Home(): ReactElement {
  return (
    <section>
      <h2>Home</h2>
      <p>示例页面：src/pages/Home.tsx</p>
    </section>
  )
}
`

const SERVER_ENTRY_TEMPLATE = `/**
 * 项目后端入口。
 *
 * 默认导出 apply(ctx)，由 worker 在内置插件之后、应用插件之前调用。
 * 它不是插件：没有 plugin.json，也不参与安装/卸载。
 */
export default function apply(ctx) {
  ctx.router.get('/api/hello', (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
}
`

const GITIGNORE = `node_modules/
dist/
.cordis/
data/
`
