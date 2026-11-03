/**
 * 项目构建与开发的公共入口。
 *
 * 这里集中两件容易漂移的知识：
 *   - 可分发布局长什么样（resources/ui、shared、plugins、server、app.json）
 *   - 框架壳如何被项目 body 替换
 *
 * CLI 只负责编排与打印；Vite / esbuild 的配置留在这里，避免命令行里出现
 * 第二份「哪些模块是共享的」「body 在哪里」的答案。
 */

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild, type BuildOptions } from 'esbuild'
import { build as viteBuild, createServer, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { RUNTIME_BANNER_MARKER, clientPreset, serverPreset } from '@cordis-app/preset'
import {
  SHARED_MODULE_TABLE,
  SHARED_PREFIX,
  WS_PATH,
  PLUGIN_SOURCE_BUILT_PATH,
  resolveProjectLayout,
  type AppManifest,
  type PluginManifest,
} from '@cordis-app/protocol'

const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const shellDir = join(packageRoot, 'dist', 'shell')
const sharedDir = join(packageRoot, 'dist', 'shared')
const hostEntry = join(packageRoot, 'dist', 'host', 'index.js')

const BODY_ID = 'virtual:cordis-app/body'
const RESOLVED_BODY_ID = '\0' + BODY_ID

export interface BuildProjectOptions {
  projectRoot: string
  /** 缺省 `<project>/dist` */
  outDir?: string
  /** 压缩前端与插件产物；缺省 false，保留可读的调试信息 */
  minify?: boolean
  log?: (line: string) => void
}

export interface BuiltPlugin {
  id: string
  /** 实际产出/复制的文件（相对插件根） */
  files: string[]
  /** 没有任何可构建入口时原样复制 */
  copied: boolean
}

export interface BuildResult {
  projectRoot: string
  outDir: string
  resourcesDir: string
  serverEntry: string
  /** 项目声明了来源模块时，构建产物中的绝对路径 */
  pluginSource?: string
  appJson: string
  packageJson: string
  plugins: BuiltPlugin[]
}

/**
 * 构建可分发布局。
 *
 * 所有产物先写到同级临时目录，成功后再整体替换 `dist`：构建失败时旧产物
 * 仍然可运行，不会留下「一半新一半旧」的目录。
 */
export async function buildProject(options: BuildProjectOptions): Promise<BuildResult> {
  const layout = resolveProjectLayout(options.projectRoot)
  const log = options.log ?? (() => {})
  const outDir = resolve(options.outDir ?? layout.distDir)
  const staging = `${outDir}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const resourcesDir = join(staging, 'resources')
  const uiDir = join(resourcesDir, 'ui')
  const sharedOut = join(resourcesDir, 'shared')
  const pluginsOut = join(resourcesDir, 'plugins')
  const serverOut = join(staging, 'server')
  let builtPlugins: BuiltPlugin[] = []
  let builtPluginSource: string | undefined

  if (!existsSync(layout.appJson)) {
    throw new Error(`找不到应用定义：${layout.appJson}`)
  }
  if (!existsSync(layout.bodyEntry)) {
    throw new Error(`找不到项目 body 入口：${layout.bodyEntry}`)
  }

  try {
    // 清单要解析一次：来源模块的路径与产物清单的改写都依赖它。放最前面，
    // 清单写错时不必先跑完一整轮前端构建才报错。
    const app = readProjectAppManifest(layout.appJson)

    for (const dir of [uiDir, sharedOut, pluginsOut, serverOut]) mkdirSync(dir, { recursive: true })

    copySharedModules(sharedOut)
    log(`  shared/  ${Object.keys(SHARED_MODULE_TABLE).length} 个模块`)

    await buildShell(layout.bodyEntry, uiDir, options.minify === true)
    log('  resources/ui/')

    const serverEntry = await buildProjectServer(layout.projectRoot, join(serverOut, 'index.js'), {
      minify: options.minify === true,
    })
    log(`  server/index.js  ← ${relative(layout.projectRoot, serverEntry) || '（空入口）'}`)

    const pluginSource = await buildProjectPluginSource(
      layout.projectRoot,
      app,
      join(serverOut, 'plugin-source.js'),
      { minify: options.minify === true },
    )
    if (pluginSource) {
      log(`  server/plugin-source.js  ← ${relative(layout.projectRoot, pluginSource)}`)
      builtPluginSource = join(outDir, 'server', 'plugin-source.js')
    }

    const plugins = await buildProjectPlugins(
      layout.localPluginsDir,
      layout.nodeModulesDir,
      pluginsOut,
      {
        minify: options.minify === true,
        log,
      },
    )
    log(`  resources/plugins/  ${plugins.length} 个`)
    builtPlugins = plugins

    writeAppJson(layout.appJson, join(staging, 'app.json'), app, builtPluginSource !== undefined)
    writePackageJson(layout.projectRoot, join(staging, 'package.json'))

    // 原子切换：旧目录先挪到同级备份，staging 改名成功后才删备份。
    // 两段 rename 都不可能跨设备（同一父目录），因此失败时旧目录还在，
    // 移回去即可——绝不能先 rmSync(outDir)，否则 rename 失败会同时失去新旧产物。
    swapIntoPlace(staging, outDir)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  return {
    projectRoot: layout.projectRoot,
    outDir,
    resourcesDir: join(outDir, 'resources'),
    serverEntry: join(outDir, 'server', 'index.js'),
    ...(builtPluginSource ? { pluginSource: builtPluginSource } : {}),
    appJson: join(outDir, 'app.json'),
    packageJson: join(outDir, 'package.json'),
    plugins: builtPlugins,
  }
}

/**
 * 文件系统操作注入点。
 *
 * 保留为导出是必要的测试 seam：`rename` 失败是「旧产物必须保住」的唯一
 * 证据，而真实文件系统无法在不破坏机器的前提下稳定制造 EXDEV/权限错误。
 * 生产调用方不应传入这个参数，缺省实现就是 node:fs。
 */
export interface SwapOps {
  existsSync(path: string): boolean
  renameSync(from: string, to: string): void
  rmSync(path: string, options: { recursive: boolean; force: boolean }): void
}

/**
 * 用 staging 整体替换 outDir，失败时旧产物仍在原位。
 *
 * 先把旧目录 rename 到同级备份（不是删除），再把 staging rename 成 outDir。
 * 两次 rename 都在同一父目录下，不会跨设备；第二次失败就把备份移回去。
 *
 * `ops` 只用于测试失败分支（见 `SwapOps` 的说明），生产路径使用缺省实现。
 */
export function swapIntoPlace(
  staging: string,
  outDir: string,
  ops: SwapOps = { existsSync, renameSync, rmSync },
): void {
  if (!ops.existsSync(outDir)) {
    ops.renameSync(staging, outDir)
    return
  }

  const backup = `${outDir}.old-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  ops.renameSync(outDir, backup)
  try {
    ops.renameSync(staging, outDir)
  } catch (error) {
    try {
      ops.renameSync(backup, outDir)
    } catch (restoreError) {
      throw new Error(
        `构建产物切换失败，旧产物保留在 ${backup}，自动恢复也失败：${(restoreError as Error).message}`,
        { cause: error },
      )
    }
    throw error
  }
  // 新产物已经就位；清理备份失败不影响本次构建结果。
  try {
    ops.rmSync(backup, { recursive: true, force: true })
  } catch {
    // 备份目录留待下一次构建或人工清理。
  }
}

/** 共享模块直接复用框架包已构建的产物，清单只来自协议的 `SHARED_MODULE_TABLE`。 */
function copySharedModules(outDir: string): void {
  for (const definition of Object.values(SHARED_MODULE_TABLE)) {
    const source = join(sharedDir, definition.file)
    if (!existsSync(source)) {
      throw new Error(
        `共享模块产物缺失：${source}。先构建 @cordis-app/ui（pnpm --filter @cordis-app/ui build）。`,
      )
    }
    copyFileSync(source, join(outDir, definition.file))
  }
}

/** 用框架壳 + 项目 body 构建 resources/ui。 */
async function buildShell(projectBody: string, outDir: string, minify: boolean): Promise<void> {
  if (!existsSync(join(shellDir, 'index.html'))) {
    throw new Error(`框架壳产物缺失：${shellDir}。先构建 @cordis-app/ui。`)
  }

  await viteBuild({
    configFile: false,
    root: shellDir,
    base: './',
    logLevel: 'warn',
    plugins: shellPlugins(projectBody),
    resolve: {
      alias: {
        'cordis-app/ui': hostEntry,
      },
    },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      minify,
      sourcemap: true,
      rollupOptions: {
        // 与生产 import map 完全一致：共享模块由 /__shared 提供
        external: Object.keys(SHARED_MODULE_TABLE),
        output: {
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  })
}

function shellPlugins(projectBody: string): Plugin[] {
  return [...react(), bodyPlugin(projectBody), importMapPlugin()]
}

/** 把框架壳的 body 选择点换成项目入口。 */
function bodyPlugin(projectBody: string): Plugin {
  return {
    name: 'cordis-app:project-body',
    resolveId(source) {
      return source === BODY_ID ? RESOLVED_BODY_ID : undefined
    },
    load(id) {
      if (id !== RESOLVED_BODY_ID) return undefined
      return `export { default } from ${JSON.stringify(projectBody)}`
    },
  }
}

/** 注入 import map；构建与开发共用同一份表。 */
function importMapPlugin(): Plugin {
  const imports = Object.fromEntries(
    Object.entries(SHARED_MODULE_TABLE).map(([specifier, definition]) => [
      specifier,
      `${SHARED_PREFIX}/${definition.file}`,
    ]),
  )
  const tag = `<script type="importmap">\n${JSON.stringify({ imports }, null, 2)}\n    </script>`
  return {
    name: 'cordis-app:import-map',
    transformIndexHtml(html) {
      return html.replace('%CORDIS_IMPORT_MAP%', tag)
    },
  }
}

/**
 * 构建项目 server。
 *
 * `server/index.ts` 与 `server/index.js` 都接受；都没有时产出一个空 apply，
 * 让「只有前端」的项目也能得到完整布局。
 *
 * `server/` 顶层除 index 外的脚本入口各自作为独立入口打包到输出目录下的
 * `<name>.js`，供 `worker_threads` 等场景按路径加载。子目录不参与：
 * 入口集合必须能从一次目录读取完整得出，否则产物名会与相对路径纠缠。
 */
async function buildProjectServer(
  projectRoot: string,
  outfile: string,
  options: { minify: boolean },
): Promise<string> {
  const entries = projectServerEntries(projectRoot)
  const main = entries.find((entry) => entry.name === 'index')
  mkdirSync(dirname(outfile), { recursive: true })

  if (!main) {
    writeFileSync(outfile, 'export default function apply() {}\n')
  } else {
    await buildServerEntry(projectRoot, main.source, outfile, options)
  }

  const outDir = dirname(outfile)
  for (const entry of entries) {
    if (entry.name === 'index') continue
    await buildServerEntry(projectRoot, entry.source, join(outDir, `${entry.name}.js`), options)
  }

  return main ? main.source : outfile
}

/** 项目 server 入口的扩展名；顺序也是同名入口的优先级。 */
const SERVER_ENTRY_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'] as const

interface ProjectServerEntry {
  /** 去扩展名后的产物名。 */
  name: string
  source: string
  /** 扩展名优先级，数字越小越优先。 */
  priority: number
}

/**
 * 列出 `server/` 顶层的脚本入口。
 *
 * 文件名（去扩展名）就是产物名；子目录与 `.d.ts` 声明文件不参与。同名入口
 * 按扩展名优先级只取一个，避免两份源码争抢同一个产物。
 */
function projectServerEntries(projectRoot: string): ProjectServerEntry[] {
  const dir = join(projectRoot, 'server')
  const found = new Map<string, ProjectServerEntry>()

  for (const entry of readdirSafe(dir)) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.d.ts') || entry.name.endsWith('.d.mts')) continue

    const extension = SERVER_ENTRY_EXTENSIONS.find((candidate) => entry.name.endsWith(candidate))
    if (!extension) continue

    const name = entry.name.slice(0, -extension.length)
    if (name === '') continue

    const candidate: ProjectServerEntry = {
      name,
      source: join(dir, entry.name),
      priority: SERVER_ENTRY_EXTENSIONS.indexOf(extension),
    }
    const existing = found.get(name)
    if (!existing || candidate.priority < existing.priority) found.set(name, candidate)
  }

  return [...found.values()]
}

/** 用同一个服务端预设构建单个入口，保持 external、banner 与 sourcemap 一致。 */
async function buildServerEntry(
  projectRoot: string,
  source: string,
  outfile: string,
  options: { minify: boolean },
): Promise<void> {
  await esbuild(
    buildOptions(
      serverPreset({
        entry: source,
        outfile,
        root: projectRoot,
        minify: options.minify,
        sourcemap: true,
      }),
      projectRoot,
    ),
  )
}

/**
 * 读项目清单。
 *
 * `build` 需要解析 app.json 来定位来源模块；格式错误必须在构建期失败，
 * 而不是把坏清单原样复制进 dist，等启动时才以「未找到模块」的形式暴露。
 */
function readProjectAppManifest(path: string): AppManifest {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析应用定义 ${path}：${(error as Error).message}`, { cause: error })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`应用定义 ${path} 必须是 JSON 对象`)
  }
  return raw as AppManifest
}

/**
 * 构建 app.json.pluginSource 指向的来源模块。
 *
 * 输出名固定为 `server/plugin-source.js`，与源文件名无关；产物清单里的值
 * 会被改写成同一路径，运行期只按清单所在目录解析。这样 `start` 与桌面
 * 释放目录都不需要额外的启动参数，也不会回头读源码根。
 */
async function buildProjectPluginSource(
  projectRoot: string,
  app: AppManifest,
  outfile: string,
  options: { minify: boolean },
): Promise<string | undefined> {
  const declared = app.pluginSource
  if (declared === undefined) return undefined
  if (typeof declared !== 'string' || declared.trim() === '') {
    throw new Error('app.json.pluginSource 必须是非空字符串')
  }
  if (isAbsolute(declared)) {
    throw new Error(`app.json.pluginSource 必须是相对路径：${declared}`)
  }

  const source = resolve(projectRoot, declared)
  const rel = relative(projectRoot, source)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`app.json.pluginSource 不能指向项目根之外：${declared}`)
  }
  if (!existsSync(source)) {
    throw new Error(`找不到插件来源模块：${source}（app.json.pluginSource = ${declared}）`)
  }

  await esbuild(
    buildOptions(
      serverPreset({
        entry: source,
        outfile,
        root: projectRoot,
        minify: options.minify,
        sourcemap: true,
      }),
      projectRoot,
    ),
  )
  return source
}

/**
 * 写产物清单。
 *
 * 没有来源模块时原样复制，保留用户的格式；有来源模块时只改写这一个字段，
 * 让它指向构建产物里的固定位置。
 */
function writeAppJson(
  sourcePath: string,
  outPath: string,
  app: AppManifest,
  hasPluginSource: boolean,
): void {
  if (!hasPluginSource) {
    copyFileSync(sourcePath, outPath)
    return
  }
  writeFileSync(
    outPath,
    JSON.stringify({ ...app, pluginSource: PLUGIN_SOURCE_BUILT_PATH }, null, 2) + '\n',
  )
}

type PluginRootKind = 'local' | 'dependency'

interface BuildPluginsOptions {
  minify: boolean
  log: (line: string) => void
}

/**
 * 构建可分发布布局里的插件。
 *
 * 本地 `plugins/` 与项目依赖根都按同一套预设重建：运行时的项目模式会同时
 * 扫描这两个根，构建后的 packaged 形态也必须包含同一组插件，否则
 * `add` → `build` → `start` 会静默丢掉 npm 安装的插件。
 *
 * 同 id 时本地插件优先，与运行时 catalog 的 local > dependency 一致。
 */
async function buildProjectPlugins(
  localRoot: string,
  nodeModulesDir: string,
  outRoot: string,
  options: BuildPluginsOptions,
): Promise<BuiltPlugin[]> {
  return buildPluginRoots(
    [
      { dir: localRoot, kind: 'local' },
      { dir: nodeModulesDir, kind: 'dependency' },
    ],
    outRoot,
    options,
  )
}

/** 构建项目 plugins/ 下带 plugin.json 的本地插件（dev 只构建这个根）。 */
async function buildLocalPlugins(
  sourceRoot: string,
  outRoot: string,
  options: BuildPluginsOptions,
): Promise<BuiltPlugin[]> {
  return buildPluginRoots([{ dir: sourceRoot, kind: 'local' }], outRoot, options)
}

async function buildPluginRoots(
  roots: ReadonlyArray<{ dir: string; kind: PluginRootKind }>,
  outRoot: string,
  options: BuildPluginsOptions,
): Promise<BuiltPlugin[]> {
  const built: BuiltPlugin[] = []
  const ids = new Map<string, PluginRootKind>()

  for (const root of roots) {
    if (!existsSync(root.dir)) continue
    for (const pluginRoot of packageDirectories(root.dir)) {
      const manifestPath = join(pluginRoot, 'plugin.json')
      if (!existsSync(manifestPath)) continue

      const manifest = readPluginManifest(manifestPath)
      const id = manifest.id ?? basename(pluginRoot)
      if (!/^[A-Za-z0-9._-]+$/.test(id)) {
        throw new Error(`插件 id 只能包含字母、数字、点、下划线与短横线：${id}`)
      }

      const existing = ids.get(id)
      if (existing) {
        if (existing === 'local' && root.kind === 'dependency') {
          options.log(`  ${id}: 本地插件优先，跳过依赖 ${pluginRoot}`)
          continue
        }
        throw new Error(`插件 id 重复：${id}`)
      }
      ids.set(id, root.kind)

      built.push(await buildPluginPackage(pluginRoot, manifestPath, manifest, id, outRoot, options))
    }
  }

  return built
}

/**
 * 扫描一个插件根下的包目录。
 *
 * `node_modules` 的 `@scope/name` 是一个包，所以作用域目录再展开一层；
 * 点目录（`.bin`、`.pnpm`）跳过。符号链接（pnpm / npm file: 依赖）也要接受。
 */
function packageDirectories(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSafe(root)) {
    if (entry.name.startsWith('.')) continue
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue

    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSafe(join(root, entry.name))) {
        if (scoped.name.startsWith('.')) continue
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue
        found.push(join(root, entry.name, scoped.name))
      }
    } else {
      found.push(join(root, entry.name))
    }
  }
  return found
}

function readdirSafe(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function buildPluginPackage(
  pluginRoot: string,
  manifestPath: string,
  manifest: PluginManifest,
  id: string,
  outRoot: string,
  options: BuildPluginsOptions,
): Promise<BuiltPlugin> {
  const pluginOut = join(outRoot, id)
  mkdirSync(pluginOut, { recursive: true })
  copyIfExists(manifestPath, join(pluginOut, 'plugin.json'))
  copyIfExists(join(pluginRoot, 'package.json'), join(pluginOut, 'package.json'))

  const files: string[] = []
  const entries: Array<{ kind: 'client' | 'server'; relativePath: string }> = []
  if (manifest.client) entries.push({ kind: 'client', relativePath: manifest.client })
  if (manifest.server) entries.push({ kind: 'server', relativePath: manifest.server })

  for (const { kind, relativePath } of entries) {
    const source = join(pluginRoot, relativePath)
    if (!existsSync(source)) {
      throw new Error(`插件 ${id} 的 ${kind} 入口不存在：${relativePath}`)
    }
    const outfile = join(pluginOut, relativePath)
    const preset =
      kind === 'client'
        ? clientPreset({
            entry: source,
            outfile,
            root: pluginRoot,
            minify: options.minify,
            sourcemap: true,
          })
        : serverPreset({
            entry: source,
            outfile,
            root: pluginRoot,
            minify: options.minify,
            sourcemap: true,
            // npm 分发的插件通常带预构建入口；banner 已经在内，再注入一次会
            // 重复声明 __cordisAppCreateRequire，产物加载即语法错误。
            ...(hasRuntimeBanner(source) ? { injectRuntimeBanner: false } : {}),
          })
    await esbuild(buildOptions(preset, pluginRoot))
    files.push(relativePath)
  }

  // 没有声明入口的插件（纯配置/资源包）原样复制，运行时会被告知不可加载。
  if (entries.length === 0) {
    copyDirectory(pluginRoot, pluginOut)
    options.log(`  ${id}: 没有构建入口，已原样复制`)
  }

  return { id, files, copied: entries.length === 0 }
}

function buildOptions(preset: BuildOptions, root: string): BuildOptions {
  return {
    ...preset,
    absWorkingDir: root,
    logLevel: 'silent',
  }
}

/**
 * 入口是否已经由服务端预设构建过。
 *
 * 插件作者发布到 npm 的通常是 `lib/server.js` 这类预构建入口；项目构建会把
 * 它重新打进发布产物。banner 只能保留一份，否则重复声明导入标识符。
 */
function hasRuntimeBanner(entry: string): boolean {
  try {
    return readFileSync(entry, 'utf8').includes(RUNTIME_BANNER_MARKER)
  } catch {
    return false
  }
}

function readPluginManifest(path: string): PluginManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PluginManifest
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`插件清单格式不正确：${path}`)
  }
  return parsed
}

function writePackageJson(projectRoot: string, outfile: string): void {
  let project: Record<string, unknown> = {}
  try {
    project = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as Record<string, unknown>
  } catch {
    // 没有 package.json 也允许构建；产物只需要一个 ESM 边界
  }
  writeFileSync(
    outfile,
    JSON.stringify(
      {
        name: typeof project.name === 'string' ? project.name : 'cordis-app-project',
        version: typeof project.version === 'string' ? project.version : '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    ) + '\n',
  )
}

function copyIfExists(source: string, target: string): void {
  if (!existsSync(source)) return
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
}

function copyDirectory(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) => {
      const name = path.split(/[\\/]/).pop() ?? ''
      return name !== 'node_modules' && name !== '.git' && !name.startsWith('.cache')
    },
  })
}

// ---------------------------------------------------------------- 开发

export interface ProjectWatcherOptions {
  projectRoot: string
  /** 缺省 `<project>/.cordis/dev` */
  devRoot?: string
  /**
   * 重建完成后调用。`plugin` 表示插件前端/服务端有变化，调用方通常还需要
   * 刷新页面；`server` 只重启 worker。
   */
  onChange?: (change: { kind: 'server' | 'plugin' }) => void | Promise<void>
  log?: (line: string) => void
}

export interface ProjectWatcher {
  readonly devRoot: string
  readonly serverEntry: string
  readonly localPluginsDir: string
  close(): Promise<void>
}

/**
 * 把项目 server 与本地插件现场构建到 `.cordis/dev` 并监听源码。
 *
 * 输出放在 `.cordis` 而不是写回源码目录：开发产物不污染项目，也不会被
 * 插件扫描当成第二份插件。worker 通过 `--server-entry` / `--local-plugins`
 * 指向这里。
 */
export async function createProjectWatcher(
  options: ProjectWatcherOptions,
): Promise<ProjectWatcher> {
  const layout = resolveProjectLayout(options.projectRoot)
  const devRoot = resolve(options.devRoot ?? join(layout.cordisDir, 'dev'))
  const serverEntry = join(devRoot, 'server', 'index.js')
  const localPluginsDir = join(devRoot, 'plugins')
  const log = options.log ?? (() => {})
  const watchers: ReturnType<typeof watch>[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const rebuildServer = async (): Promise<void> => {
    mkdirSync(dirname(serverEntry), { recursive: true })
    await buildProjectServer(options.projectRoot, serverEntry, { minify: false })
  }

  const rebuildPlugins = async (): Promise<void> => {
    rmSync(localPluginsDir, { recursive: true, force: true })
    mkdirSync(localPluginsDir, { recursive: true })
    await buildLocalPlugins(layout.localPluginsDir, localPluginsDir, { minify: false, log })
  }

  const rebuildAll = async (): Promise<void> => {
    await Promise.all([rebuildServer(), rebuildPlugins()])
  }

  const schedule = (kind: 'server' | 'plugin'): void => {
    if (closed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      void (async () => {
        try {
          await rebuildAll()
          await options.onChange?.({ kind })
        } catch (error) {
          log(`重建失败：${(error as Error).message}`)
        }
      })()
    }, 100)
  }

  await rebuildAll()
  // 初次构建不算变化；watch 只负责后续改动。
  const serverDir = join(options.projectRoot, 'server')
  if (existsSync(serverDir)) {
    watchers.push(
      watchDirectory(serverDir, () => schedule('server')),
    )
  }
  if (existsSync(layout.localPluginsDir)) {
    watchers.push(
      watchDirectory(layout.localPluginsDir, () => schedule('plugin')),
    )
  }

  return {
    devRoot,
    serverEntry,
    localPluginsDir,
    async close() {
      closed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
    },
  }
}

function watchDirectory(dir: string, listener: () => void): ReturnType<typeof watch> {
  // 递归监听在 macOS / Windows / 新版 Linux 都可用；目录不存在时调用方已跳过。
  return watch(dir, { recursive: true }, () => listener())
}

export interface ProjectDevServerOptions {
  projectRoot: string
  /** Vite 端口；缺省 5173，占用时自动换一个 */
  port?: number
  /** worker 的监听地址，代理目标 */
  worker: { port: number; token?: string }
  /** 固定端口（用户显式 --port 时） */
  strictPort?: boolean
}

export interface ProjectDevServer {
  readonly url: string
  readonly port: number
  readonly server: ViteDevServer
  /** 让浏览器整页刷新；插件前端重建后调用。 */
  reload(): void
  close(): Promise<void>
}

/** 启动项目 body 的 Vite 开发服务器。 */
export async function createProjectDevServer(
  options: ProjectDevServerOptions,
): Promise<ProjectDevServer> {
  if (!existsSync(join(shellDir, 'index.html'))) {
    throw new Error(`框架壳产物缺失：${shellDir}。先构建 @cordis-app/ui。`)
  }

  const workerOrigin = `http://127.0.0.1:${options.worker.port}`
  const server = await createServer({
    configFile: false,
    root: shellDir,
    logLevel: 'warn',
    appType: 'spa',
    plugins: [
      devJsxRuntimePlugin(),
      ...react(),
      bodyPlugin(resolveProjectLayout(options.projectRoot).bodyEntry),
      importMapPlugin(),
      sharedModulesPlugin(),
      serveSharedModules(),
    ],
    resolve: {
      alias: {
        'cordis-app/ui': hostEntry,
      },
    },
    server: {
      host: '127.0.0.1',
      ...(options.port ? { port: options.port, strictPort: options.strictPort === true } : {}),
      fs: {
        allow: [shellDir, options.projectRoot, packageRoot],
      },
      proxy: devProxyConfig(workerOrigin),
    },
  })

  await server.listen()
  const address = server.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 5173)

  return {
    // 外壳模式由外壳用握手 token 拼入口地址，这里不需要 token fragment。
    url: options.worker.token
      ? `http://127.0.0.1:${port}/#token=${encodeURIComponent(options.worker.token)}`
      : `http://127.0.0.1:${port}/`,
    port,
    server,
    reload() {
      server.ws.send({ type: 'full-reload' })
    },
    async close() {
      await server.close()
    },
  }
}

/**
 * 让壳里的共享模块说明符指向 `/__shared/*.js`。
 *
 * 插件 bundle 由 worker 提供，里面同样保留这些 URL。两边落在同一个浏览器
 * 模块上，React 与 RuntimeContext 才是同一份。
 */
function sharedModulesPlugin(): Plugin {
  return {
    name: 'cordis-app:shared-modules',
    // 必须早于 Vite 的依赖预构建：裸模块名一旦被 vite:resolve 命中，React
    // 就会从 node_modules/.vite 来一份，与 /__shared 的不是同一个实例。
    enforce: 'pre',
    resolveId(source) {
      if (!(source in SHARED_MODULE_TABLE)) return undefined
      return `\0cordis-app:shared:${source}`
    },
    load(id) {
      if (!id.startsWith('\0cordis-app:shared:')) return undefined
      const specifier = id.slice('\0cordis-app:shared:'.length)
      const definition = SHARED_MODULE_TABLE[specifier as keyof typeof SHARED_MODULE_TABLE]
      if (!definition) return undefined
      return `export * from ${JSON.stringify(`${SHARED_PREFIX}/${definition.file}`)}`
    },
  }
}

/**
 * 开发时的 JSX 运行时。
 *
 * `@vitejs/plugin-react` 在 dev 下编译成 `react/jsx-dev-runtime`，而共享清单
 * 里只有 `react/jsx-runtime`。若放任 Vite 预构建，它会自带一份 React，
 * 与 `/__shared/react.js` 形成两个实例，hooks 立刻报错。这里把它桥接到
 * 同一份共享运行时：`jsxDEV` 用 `jsx`/`jsxs` 实现，只少掉开发期参数校验。
 */
const DEV_JSX_RUNTIME_ID = '\0cordis-app:jsx-dev-runtime'

function devJsxRuntimePlugin(): Plugin {
  return {
    name: 'cordis-app:jsx-dev-runtime',
    // 必须早于 Vite 的依赖扫描，否则说明符会先进预构建。
    enforce: 'pre',
    resolveId(source) {
      return source === 'react/jsx-dev-runtime' ? DEV_JSX_RUNTIME_ID : undefined
    },
    load(id) {
      if (id !== DEV_JSX_RUNTIME_ID) return undefined
      const runtime = `${SHARED_PREFIX}/${SHARED_MODULE_TABLE['react/jsx-runtime'].file}`
      return [
        `import { Fragment, jsx, jsxs } from ${JSON.stringify(runtime)}`,
        'export { Fragment }',
        'export function jsxDEV(type, props, key, isStaticChildren) {',
        '  return isStaticChildren ? jsxs(type, props, key) : jsx(type, props, key)',
        '}',
        '',
      ].join('\n')
    },
  }
}

/** 开发时由 Vite 提供 /__shared，避免代理到 worker 产生第二份模块实例。 */
function serveSharedModules(): Plugin {
  return {
    name: 'cordis-app:serve-shared',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(`${SHARED_PREFIX}/`)) return next()
        const name = decodeURIComponent(url.slice(SHARED_PREFIX.length + 1).split('?')[0] ?? '')
        if (!/^[A-Za-z0-9._-]+\.js$/.test(name)) return next()
        const file = join(sharedDir, name)
        if (!existsSync(file)) return next()
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(readFileSync(file))
      })
    },
  }
}

/**
 * dev 服务器转发给 worker 的路径。
 *
 * WebSocket 路径必须来自 protocol 的 `WS_PATH`：前端连接的是 `/__ws`，dev
 * 代理若写成别的路径，浏览器会连到 Vite 自己身上，worker 重启后的清单重拉
 * 就永远等不到。
 *
 * 内部实现：对外的可验证行为是 `createProjectDevServer` 的代理结果，测试
 * 从那个公共入口断言，不再单独导出这个配置函数。
 */
function devProxyConfig(target: string) {
  return {
    ...proxyFor('/api', target),
    ...proxyFor('/__plugins', target),
    ...proxyFor('/__health', target),
    ...proxyFor(WS_PATH, target),
  }
}

function proxyFor(prefix: string, target: string) {
  return {
    [prefix]: {
      target,
      changeOrigin: true,
      ws: prefix === WS_PATH,
      // auth 只接受 worker 自己的 origin；代理必须把浏览器的 Origin 换掉。
      configure(proxy: { on(event: 'proxyReq', listener: (req: { setHeader(name: string, value: string): void }) => void): void }) {
        proxy.on('proxyReq', (req) => req.setHeader('origin', target))
      },
    },
  }
}
