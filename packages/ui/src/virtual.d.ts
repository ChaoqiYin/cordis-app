/**
 * 构建期替换点。
 *
 * 框架壳只认识 `virtual:cordis-app/body`；仓库内由 vite.config.ts 指向默认
 * body，项目构建/开发由 `@cordis-app/ui/build` 指向项目的 `src/body.tsx`。
 * 这样壳不需要知道项目路径，项目也不需要复制一份壳。
 */
declare module 'virtual:cordis-app/body' {
  import type { ComponentType } from 'react'

  const Body: ComponentType
  export default Body
}
