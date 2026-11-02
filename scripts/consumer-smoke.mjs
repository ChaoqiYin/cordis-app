#!/usr/bin/env node
/**
 * 真实消费方冒烟：npm `file:` → add → build → start。
 *
 * 包内测试用假 node_modules，覆盖不到「npm 安装的目录是符号链接」「插件入口
 * 已经由 serverPreset 构建过」这两件事。这里从临时项目出发，只走使用方的
 * 公开命令，最后删掉项目 node_modules 再以打包形态启动。
 *
 * 前置：先在仓库根执行 `pnpm build`。
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
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
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function fail(message) {
  throw new Error(message)
}

function log(message) {
  console.log(`[consumer-smoke] ${message}`)
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
    join(helloPlugin, 'lib', 'server.js'),
    join(helloPlugin, 'lib', 'client.js'),
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

/** 等 stdout 上出现带 token 的访问地址；子进程提前退出时立即失败。 */
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
          `start 提前退出（${signal ?? `exit ${code}`}）。stdout:\n${getStdout()}\nstderr:\n${getStderr()}`,
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

async function main() {
  assertBuilt()
  const work = mkdtempSync(join(tmpdir(), 'cordis-consumer-'))
  const projectRoot = join(work, 'demo')
  const nodeModules = join(projectRoot, 'node_modules')
  const movedNodeModules = join(projectRoot, 'node_modules.off')
  let startChild

  try {
    // ① 使用方脚手架。
    run(process.execPath, [frameworkCli, 'new', 'demo', '--project', projectRoot], { cwd: work })

    // ② README 记录的本地联调方式：npm 在 node_modules 里创建 file: 符号链接。
    writeConsumerDependencies(projectRoot)
    run(npm, ['install', '--no-audit', '--no-fund'], { cwd: projectRoot })

    // ③ 用已安装的 CLI 添加插件；插件入口是作者预构建的 lib/。
    const installedCli = join(nodeModules, 'cordis-app', 'bin', 'cordis-app.js')
    run(
      process.execPath,
      [installedCli, 'add', `file:${helloPlugin}`, '--project', projectRoot],
      { cwd: projectRoot },
    )

    const pkg = readJson(join(projectRoot, 'package.json'))
    if (!pkg.dependencies['cordis-app-example-hello']?.startsWith('file:')) {
      fail('add 后项目 package.json 应记录 hello 插件的 file: 依赖')
    }
    const app = readJson(join(projectRoot, 'app.json'))
    if (!app.plugins?.includes('hello')) fail('add 后 app.json 应启用 hello')

    // ④ 构建；依赖根插件必须进入发布产物，且只注入一份运行期 banner。
    run(process.execPath, [installedCli, 'build', '--project', projectRoot], {
      cwd: projectRoot,
    })
    const pluginEntry = join(projectRoot, 'dist', 'resources', 'plugins', 'hello', 'lib', 'server.js')
    if (!existsSync(pluginEntry)) fail(`依赖根插件没有进入发布产物：${pluginEntry}`)
    const pluginSource = readFileSync(pluginEntry, 'utf8')
    const banners = pluginSource.match(/createRequire as __cordisAppCreateRequire/g) ?? []
    if (banners.length !== 1) {
      fail(`插件产物应只含一份 createRequire banner，实际 ${banners.length} 份`)
    }
    if (existsSync(join(projectRoot, 'dist', 'node_modules'))) {
      fail('dist 不能携带 node_modules')
    }

    // ⑤ 模拟部署：删掉项目 node_modules，再用仓库里的 CLI 以打包形态启动。
    renameSync(nodeModules, movedNodeModules)
    const port = await freePort()
    let stdout = ''
    let stderr = ''
    startChild = spawn(
      process.execPath,
      [frameworkCli, 'start', '--project', projectRoot, '--port', String(port)],
      { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    startChild.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    startChild.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })

    const { token } = await waitForUrl(startChild, () => stdout, () => stderr)
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: `Bearer ${token}` }

    const health = await fetch(`${base}/__health`, { headers })
    if (health.status !== 200) fail(`健康检查返回 ${health.status}`)

    const manifestResponse = await fetch(`${base}/__plugins`, { headers })
    if (!manifestResponse.ok) fail(`插件清单返回 ${manifestResponse.status}`)
    const manifest = await manifestResponse.json()
    if (manifest.failures?.length) {
      fail(`打包形态加载失败：${JSON.stringify(manifest.failures)}`)
    }
    const entry = manifest.plugins?.hello
    if (!entry) fail('打包形态清单里没有 hello')
    const clientFile = entry.files?.[0]
    if (!clientFile) fail('hello 清单没有前端入口')

    const client = await fetch(`${base}${clientFile}`, { headers })
    if (!client.ok) fail(`hello 前端入口返回 ${client.status}`)
    await client.arrayBuffer()

    log('通过：npm file: → add → build → 删除 node_modules → start 加载 hello')
  } finally {
    if (startChild) await waitForExit(startChild)
    if (existsSync(movedNodeModules)) renameSync(movedNodeModules, nodeModules)
    rmSync(work, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[consumer-smoke] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
