# ADR 0004：`plugin.json` 是运行时清单，构建把源入口规范化为 JS

## Status

已采纳（2026-11-09）。

## Context

`plugin.json` 同时承担两种角色：作者在源码目录里声明入口，运行时又按它定位并
加载插件。两种角色对入口扩展名的期待并不相同。

源码入口通常是 TypeScript/TSX（`src/client.tsx`、`src/server.ts`），而 Node 与
浏览器只能直接执行 JavaScript。此前 `build` 用 esbuild 编译入口，但产物文件名
沿用源路径，产物目录里的 `plugin.json` 也只是从源码原样复制。结果是：

- `dist/resources/plugins/<id>/src/client.tsx` 里其实是编译后的 JS，但扩展名仍
  是 `.tsx`；静态服务按 MIME 表把它当作未知二进制返回，浏览器不会执行。
- 产物清单仍指向 `.tsx`，`start` 与打包形态照着加载，运行必然失败。
- 运行时对入口扩展名没有校验，`run` 直接拿源码入口去 import，报错信息与真正
  的下一步（改用 `dev`/`build`，或提供已构建入口）无关。

把 MIME 表扩展成认识 `.ts`/`.tsx` 只是掩盖问题：它会让「源码扩展名」在运行时
继续流通，也让 `run` 看起来支持源码入口，实际仍要 Node 会解析 TS 才行。

## Decision

**`plugin.json` 是运行时清单，构建负责把源入口规范化为 JavaScript。**

- 源码目录的 `plugin.json` 可以声明 esbuild 支持的 JS/TS 家族入口
  （`.js`、`.jsx`、`.mjs`、`.cjs`、`.ts`、`.tsx`、`.mts`、`.cts`）。
- `dev` 与 `build` 编译入口时保留目录与 basename，把扩展名统一改为 `.js`
  （`src/client.tsx` → `src/client.js`），sourcemap 跟随产物（`src/client.js.map`）。
- 构建产物里的 `plugin.json` 由构建生成：`client`/`server` 改写为实际输出路径，
  其余字段原样保留；源码目录的 `plugin.json` 不修改。
- 运行时只接受 `.js`、`.mjs`、`.cjs` 三种入口扩展名。该集合放在
  `@cordis-app/protocol`，构建与扫描、加载、bundle/npm 安装校验共用，避免两边
  各维护一份。
- 扫描、加载与安装校验遇到非 JS 入口时只让该插件失败，不影响其他插件；错误信息
  说明 `dev`/`build` 会编译并改写产物清单，`run` 不编译，需要改用 `dev`/`build`
  或提供已构建入口。
- `run` 不新增构建步骤；它只接受已构建的 JS 入口。
- 静态服务的 MIME 表只补 `.cjs`，不把 `.ts`、`.tsx`、`.jsx` 当作 JavaScript。
  源码扩展名不应出现在运行时产物里。
- 签名插件包格式、内容 hash 与签名载荷不变；规范化发生在构建阶段，归档仍然只
  包含构建产物。

## Consequences

正面：

- 源码可以继续使用 TypeScript/TSX，发布产物只有运行时能直接执行的 JS。
- `start`、打包形态与桌面形态读取同一份产物清单，不再依赖源码扩展名。
- 构建与运行时共享同一个扩展名集合，校验口径不会分叉。
- `run` 的行为保持诚实：不编译，只运行已构建入口，并在入口不合法时直接说明
  下一步。

代价：

- 构建产物清单由构建生成，不能再假设它逐字节等于源码清单；需要读取原始声明时
  应看源码目录。
- 产物文件名不再与源文件名完全一致，调试时需要依赖 sourcemap 回到源码。
- 源码入口使用 esbuild 不支持的扩展名（例如 `.vue`）会在构建期失败，需要作者
  先转成 JS/TS 入口。
