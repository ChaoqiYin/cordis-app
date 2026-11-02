#!/usr/bin/env node
/**
 * 桌面打包形态冒烟：build → package-desktop → 启动安装目录。
 *
 * 包内测试覆盖了打包脚本的纯函数与 runtime 打包，但不会真的 go build、
 * 释放内嵌资源并启动外壳。这里从临时项目出发，只走使用方的公开命令，
 * 最后运行打包出来的可执行文件，检查插件是否真的被加载。
 *
 * 前置：先在仓库根执行 `pnpm build`；需要 Go 与 WebKit 构建依赖。
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const framework = join(repo, 'packages', 'cordis-app')
const frameworkCli = join(framework, 'bin', 'cordis-app.js')
const helloPlugin = join(repo, 'examples', 'hello-plugin')
const packageDesktop = join(
  repo,
  'packages',
  'shell',
  'scripts',
  'package-desktop.mjs',
)
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const exeName = process.platform === 'win32' ? 'cordis-app.exe' : 'cordis-app'

function fail(message) {
  throw new Error(message)
}

function log(message) {
  console.log(`[desktop-smoke] ${message}`)
}

function run(command, args, options = {}) {
  log(`${command === process.execPath ? 'node' : command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} 失败（exit ${result.status}）`)
  }
}

function assertBuilt() {
  for (const path of [
    frameworkCli,
    join(repo, 'packages', 'ui', 'dist', 'shell', 'index.html'),
    join(repo, 'packages', 'preset', 'lib', 'index.js'),
    join(repo, 'packages', 'runtime', 'lib', 'supervisor', 'main.js'),
    join(repo, 'packages', 'runtime', 'lib', 'worker', 'main.js'),
    join(helloPlugin, 'lib', 'server.js'),
    join(helloPlugin, 'lib', 'client.js'),
    packageDesktop,
  ]) {
    if (!existsSync(path)) {
      fail(`缺少构建产物：${path}。先在仓库根执行 pnpm build。`)
    }
  }
}

function writeConsumerDependencies(projectRoot) {
  const packageJsonPath = join(projectRoot, 'package.json')
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  // 脚手架写的是 registry 范围；消费方按 README 的方式指向本仓库。
  pkg.dependencies['cordis-app'] = `file:${framework}`
  writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n')
}

/** 等 stdout 上出现访问地址；子进程提前退出时立即失败。 */
function waitForUrl(child, getStdout, getStderr) {
  return new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`等待启动地址超时。stdout:\n${getStdout()}\nstderr:\n${getStderr()}`))
    }, 30_000)

    const check = () => {
      const match = getStdout().match(/http:\/\/127\.0\.0\.1:\d+\/#token=([^\s]+)/)
      if (!match) return false
      clearTimeout(timer)
      resolveUrl({ url: match[0], token: decodeURIComponent(match[1]) })
      return true
    }

    const poll = setInterval(() => {
      if (check()) clearInterval(poll)
    }, 50)

    child.once('exit', (code, signal) => {
      if (check()) return
      clearTimeout(timer)
      clearInterval(poll)
      reject(
        new Error(
          `桌面程序提前退出（${signal ?? `exit ${code}`}）。stdout:\n${getStdout()}\nstderr:\n${getStderr()}`,
        ),
      )
    })
  })
}

async function waitForExit(child) {
  if (child.exitCode !== null) return
  await new Promise((resolveExit) => {
    child.once('exit', resolveExit)
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 5_000).unref()
  })
}

/**
 * 构建期把系统浏览器调用挡掉。
 *
 * `--url` 已跳过开窗，但仍会沿用降级路径去打开浏览器；自动化回归不需要
 * 真的弹出页面。Unix 上把 PATH 指向空目录即可让 open/xdg-open 找不到，
 * 失败只会打印一行提示。Windows 的 rundll32 依赖 System32，不能这样裁剪。
 */
function withoutBrowserOpener(emptyDir) {
  if (process.platform === 'win32') return process.env
  mkdirSync(emptyDir, { recursive: true })
  return { ...process.env, PATH: emptyDir }
}

async function main() {
  assertBuilt()
  const work = mkdtempSync(join(tmpdir(), 'cordis-desktop-'))
  const projectRoot = join(work, 'demo')
  const outDir = join(work, 'desktop')
  const dataDir = join(work, 'data')
  let startChild

  try {
    // ① 使用方脚手架与本地联调安装方式。
    run(process.execPath, [frameworkCli, 'new', 'demo', '--project', projectRoot], { cwd: work })
    writeConsumerDependencies(projectRoot)
    run(npm, ['install', '--no-audit', '--no-fund'], { cwd: projectRoot })

    const installedCli = join(projectRoot, 'node_modules', 'cordis-app', 'bin', 'cordis-app.js')
    run(
      process.execPath,
      [installedCli, 'add', `file:${helloPlugin}`, '--project', projectRoot],
      { cwd: projectRoot },
    )
    run(process.execPath, [installedCli, 'build', '--project', projectRoot], {
      cwd: projectRoot,
    })

    // ② 打成安装目录：嵌入 dist、bundle runtime、go build、复制 node。
    run(process.execPath, [packageDesktop, '--project', projectRoot, '--out', outDir], {
      cwd: repo,
    })
    const exePath = join(outDir, exeName)
    for (const path of [
      exePath,
      join(outDir, 'bin', process.platform === 'win32' ? 'node.exe' : 'node'),
      join(outDir, 'bin', 'cordis-app-supervisor.mjs'),
      join(outDir, 'bin', 'cordis-app-worker.mjs'),
    ]) {
      if (!existsSync(path)) fail(`安装目录缺少 ${path}`)
    }

    // ③ 以安装目录形态启动；--url 跳过开窗，端口由系统分配。
    let stdout = ''
    let stderr = ''
    startChild = spawn(exePath, ['--url', '--data', dataDir], {
      cwd: work,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: withoutBrowserOpener(join(work, 'empty-path')),
    })
    startChild.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    startChild.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })

    // 端口写在外壳打印的 URL 里；等它出现再请求。
    const { url, token } = await waitForUrl(startChild, () => stdout, () => stderr)
    const port = new URL(url).port
    if (!token) fail('启动地址里没有 token')
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: `Bearer ${token}` }

    const health = await fetch(`${base}/__health`, { headers })
    if (health.status !== 200) fail(`健康检查返回 ${health.status}`)

    const manifestResponse = await fetch(`${base}/__plugins`, { headers })
    if (!manifestResponse.ok) fail(`插件清单返回 ${manifestResponse.status}`)
    const manifest = await manifestResponse.json()
    if (manifest.failures?.length) {
      fail(`桌面形态加载失败：${JSON.stringify(manifest.failures)}`)
    }
    const entry = manifest.plugins?.hello
    if (!entry) fail('桌面形态清单里没有 hello')
    const clientFile = entry.files?.[0]
    if (!clientFile) fail('hello 清单没有前端入口')

    const client = await fetch(`${base}${clientFile}`, { headers })
    if (!client.ok) fail(`hello 前端入口返回 ${client.status}`)
    await client.arrayBuffer()

    // 数据目录应已释放出内嵌应用；再启动一次会走同一份缓存。
    if (!existsSync(join(dataDir, 'app'))) {
      fail(`桌面程序没有释放内嵌应用到 ${join(dataDir, 'app')}`)
    }

    log('通过：build → package-desktop → 启动安装目录并加载 hello')
  } finally {
    if (startChild) await waitForExit(startChild)
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[desktop-smoke] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
