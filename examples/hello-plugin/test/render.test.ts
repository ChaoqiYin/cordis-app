/**
 * hello 插件的前端渲染验收。
 *
 * 用 esbuild 按插件的真实构建方式（React 与 `cordis-app/client` 保持 external）
 * 产出一份临时代码，再交给框架的 `ClientRuntime` 加载，最后用
 * `react-dom/server` 渲染 `PluginPageOutlet`。这条链路覆盖了「项目发现插件 →
 * 插件注册页面 → body 通过宿主出口渲染」的前端部分，不需要浏览器。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'
import { ClientRuntime, RuntimeContext } from 'cordis-app/client'
import { PluginPageOutlet } from 'cordis-app/ui'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 按 build.mjs 的同一套外部依赖，把 client.tsx 打成一份可被 Node 加载的 ESM。 */
async function bundleClient(): Promise<string> {
  const result = await build({
    entryPoints: [join(packageRoot, 'src', 'client.tsx')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'cordis-app/client'],
    logLevel: 'silent',
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error('esbuild 没有产出客户端代码')

  // 临时文件必须落在包内，external 的裸模块名才会按本包的 node_modules 解析。
  const file = join(packageRoot, `.client-test-${process.pid}-${Date.now()}.mjs`)
  writeFileSync(file, output.text)
  return file
}

test('plugin.json 声明了页面 UI 需求', () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'plugin.json'), 'utf8'))
  assert.deepEqual(manifest.ui, { pages: true })
})

test('前端入口能被 ClientRuntime 加载，并通过 PluginPageOutlet 渲染', async () => {
  const file = await bundleClient()
  try {
    const runtime = new ClientRuntime({ token: 'test-token' })
    const loaded = await runtime.loadPlugin({
      id: 'hello',
      files: [pathToFileURL(file).href],
      data: { greeting: '来自服务端的问候' },
    })
    assert.equal(loaded.error, undefined)
    assert.equal(runtime.registry.getPage('/hello')?.name, 'Hello')

    const html = renderToStaticMarkup(
      createElement(
        RuntimeContext.Provider,
        { value: runtime },
        createElement(PluginPageOutlet, { path: '/hello' }),
      ),
    )

    // SSR 不执行 useEffect，因此只断言首屏：服务端随清单送来的 data 与页面文案。
    assert.match(html, /来自服务端的问候/)
    assert.match(html, /这一页由 hello 插件/)
  } finally {
    rmSync(file, { force: true })
  }
})
