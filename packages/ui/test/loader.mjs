/**
 * Node 测试用解析钩子。
 *
 * 宿主产物把 `cordis-app/client` 标为 external（浏览器里由 import map 指向
 * /__shared/client.js）。Node 测试没有 import map，这里把它映射到同一份源码，
 * 保证测试里的 RuntimeContext 与宿主组件使用的是同一个模块实例。
 *
 * 源码使用 TypeScript 的 `.js` 说明符；Node 的类型剥离不会自动换成 `.ts`，
 * 因此这里对 `src/client` 内部的相对导入做一次后缀映射。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientEntry = pathToFileURL(
  new URL('../src/client/index.ts', import.meta.url).pathname,
).href

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cordis-app/client') {
    return { url: clientEntry, shortCircuit: true }
  }

  if (
    context.parentURL?.includes('/src/client/') &&
    specifier.startsWith('.') &&
    specifier.endsWith('.js')
  ) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true }
    }
  }

  return nextResolve(specifier, context)
}
