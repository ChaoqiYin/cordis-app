import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { SHARED_SPECIFIERS, importMap } from './shared-modules.mjs'

/**
 * 宿主 UI 的 Vite 配置。
 *
 * 关键点是 `rollupOptions.external`：产出的 bundle 与 index.html 的 import map
 * 必须指向同一批共享模块，否则宿主自己会带一份 React，而插件拿到的是
 * /__shared 的另一份——两份 React 的 hooks 互不认账，插件组件会直接抛错。
 *
 * dev 模式下不 external：Vite 需要能解析到真实文件才能做 HMR。此时页面不经
 * import map 加载插件，不会出现双实例问题。
 */

/** 把 shared-modules.mjs 的清单注入 index.html，避免手写两份。 */
function importMapPlugin(): Plugin {
  const map = importMap()
  const tag = `<script type="importmap">\n${JSON.stringify(map, null, 2)}\n    </script>`
  return {
    name: 'cordis-app:import-map',
    transformIndexHtml(html) {
      return html.replace('%CORDIS_IMPORT_MAP%', tag)
    },
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react(), importMapPlugin()],
  // 产物由 worker 的 static 插件从 resources/ui/ 提供，路径必须相对
  base: './',
  resolve: {
    // dev 下没有 import map，源码里的裸模块名需要一个落点。
    // build 不能用 alias：alias 在 external 判定之前生效，会把 cordis-app/client
    // 内联进宿主 bundle，于是宿主与插件各持一份 RuntimeContext，
    // 插件的 useContext 永远读不到 Provider。
    alias: command === 'serve' ? { 'cordis-app/client': resolve(__dirname, 'src/client/index.ts') } : undefined,
  },
  server: {
    port: 5173,
    proxy: {
      // 开发时后端由 supervisor 拉起，前端代理到它，避免 token / Origin 校验分叉
      '/api': { target: devServer(), changeOrigin: false },
      '/__plugins': { target: devServer(), changeOrigin: false },
      '/__shared': { target: devServer(), changeOrigin: false },
      '/__health': { target: devServer(), changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    // 目标是随包分发的 WebView，不需要兼容旧浏览器
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      // 生产构建把共享模块交给 import map；dev 构建不 external
      external: command === 'build' ? SHARED_SPECIFIERS : [],
      output: {
        // 入口带 hash 便于 no-cache 下的正确失效
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
}))

function devServer(): string {
  return process.env.CORDIS_APP_DEV_SERVER ?? 'http://127.0.0.1:5140'
}
