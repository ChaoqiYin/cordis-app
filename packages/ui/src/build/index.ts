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
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build as esbuild, type BuildOptions } from 'esbuild'
import { build as viteBuild, createServer, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import { clientPreset, serverPreset } from '@cordis-app/preset'
import {
  SHARED_MODULE_TABLE,
  SHARED_PREFIX,
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

  if (!existsSync(layout.appJson)) {
    throw new Error(`找不到应用定义：${layout.appJson}`)
  }
  if (!existsSync(layout.bodyEntry)) {
    throw new Error(`找不到项目 body 入口：${layout.bodyEntry}`)
  }

  try {
    for (const dir of [uiDir, sharedOut, pluginsOut, serverOut]) mkdirSync(dir, { recursive: true })

    copySharedModules(sharedOut)
    log(`  shared/  ${Object.keys(SHARED_MODULE_TABLE).length} 个模块`)

    await buildShell(layout.bodyEntry, uiDir, options.minify === true)
    log('  resources/ui/')

    const serverEntry = await buildProjectServer(layout.projectRoot, join(serverOut, 'index.js'), {
      minify: options.minify === true,
    })
    log(`  server/index.js  ← ${relative(layout.projectRoot, serverEntry) || '（空入口）'}`)

    const plugins = await buildLocalPlugins(layout.localPluginsDir, pluginsOut, {
      minify: options.minify === true,
      log,
    })
    log(`  resources/plugins/  ${plugins.length} 个`)
    builtPlugins = plugins

    copyFileSync(layout.appJson, join(staging, 'app.json'))
    writePackageJson(layout.projectRoot, join(staging, 'package.json'))

    // 原子切换：先移走旧目录，再改名。失败时旧目录已在 try 外被清理逻辑保护。
    rmSync(outDir, { recursive: true, force: true })
    renameSync(staging, outDir)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  return {
    projectRoot: layout.projectRoot,
    outDir,
    resourcesDir: join(outDir, 'resources'),
    serverEntry: join(outDir, 'server', 'index.js'),
    appJson: join(outDir, 'app.json'),
    packageJson: join(outDir, 'package.json'),
    plugins: builtPlugins,
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
 */
async function buildProjectServer(
  projectRoot: string,
  outfile: string,
  options: { minify: boolean },
): Promise<string> {
  const source = findProjectServer(projectRoot)
  if (!source) {
    mkdirSync(dirname(outfile), { recursive: true })
    writeFileSync(outfile, 'export default function apply() {}\n')
    return outfile
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

function findProjectServer(projectRoot: string): string | undefined {
  for (const name of ['index.ts', 'index.mts', 'index.js', 'index.mjs']) {
    const candidate = join(projectRoot, 'server', name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** 构建项目 plugins/ 下带 plugin.json 的本地插件。 */
async function buildLocalPlugins(
  sourceRoot: string,
  outRoot: string,
  options: { minify: boolean; log: (line: string) => void },
): Promise<BuiltPlugin[]> {
  if (!existsSync(sourceRoot)) return []

  const built: BuiltPlugin[] = []
  const ids = new Set<string>()
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const pluginRoot = join(sourceRoot, entry.name)
    const manifestPath = join(pluginRoot, 'plugin.json')
    if (!existsSync(manifestPath)) continue

    const manifest = readPluginManifest(manifestPath)
    const id = manifest.id ?? entry.name
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      throw new Error(`插件 id 只能包含字母、数字、点、下划线与短横线：${id}`)
    }
    if (ids.has(id)) throw new Error(`插件 id 重复：${id}`)
    ids.add(id)

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
            })
      await esbuild(buildOptions(preset, pluginRoot))
      files.push(relativePath)
    }

    // 没有声明入口的插件（纯配置/资源包）原样复制，运行时会被告知不可加载。
    if (entries.length === 0) {
      copyDirectory(pluginRoot, pluginOut)
      options.log(`  ${id}: 没有构建入口，已原样复制`)
    }

    built.push({ id, files, copied: entries.length === 0 })
  }

  return built
}

function buildOptions(preset: BuildOptions, root: string): BuildOptions {
  return {
    ...preset,
    absWorkingDir: root,
    logLevel: 'silent',
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
  worker: { port: number; token: string }
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
      proxy: {
        ...proxyFor('/api', workerOrigin),
        ...proxyFor('/__plugins', workerOrigin),
        ...proxyFor('/__health', workerOrigin),
        ...proxyFor('/ws', workerOrigin),
      },
    },
  })

  await server.listen()
  const address = server.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 5173)

  return {
    url: `http://127.0.0.1:${port}/#token=${encodeURIComponent(options.worker.token)}`,
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

function proxyFor(prefix: string, target: string) {
  return {
    [prefix]: {
      target,
      changeOrigin: true,
      ws: prefix === '/ws',
      // auth 只接受 worker 自己的 origin；代理必须把浏览器的 Origin 换掉。
      configure(proxy: { on(event: 'proxyReq', listener: (req: { setHeader(name: string, value: string): void }) => void): void }) {
        proxy.on('proxyReq', (req) => req.setHeader('origin', target))
      },
    },
  }
}
