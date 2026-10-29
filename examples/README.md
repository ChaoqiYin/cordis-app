# 示例

这里放两类示例：

| 目录 | 类型 | 演示的能力 |
| --- | --- | --- |
| [hello-plugin](./hello-plugin) | 插件包 | 服务端路由 + 前端页面 + `plugin.json.ui` + 插件数据 |
| [full-body](./full-body) | 项目 body | 自定义布局并保留 pages / slots / menus / settings 全部出口 |

`hello-plugin` 是工作区包（由 `pnpm-workspace.yaml` 纳入），可以直接用仓库内的
`@cordis-app/preset` 构建；`full-body` 只是可复制到
`<project>/src/body.tsx` 的源码示例，不是独立包。

## 完整流程

```bash
pnpm install
pnpm build                       # 构建框架各包（含 hello-plugin）

node packages/cli/lib/cli.js new demo --project /tmp/cordis-demo
node packages/cli/lib/cli.js add "file:$PWD/examples/hello-plugin" \
  --project /tmp/cordis-demo
node packages/cli/lib/cli.js dev --project /tmp/cordis-demo
```

`add` 走的是与安装 npm 包相同的项目安装路径：包管理器写入项目的
`node_modules`、更新 `package.json` 与 lockfile、读取 `plugin.json.id` 并写进
`app.json.plugins`。换成 `file:` 只是包管理器 spec 的写法不同，插件本身不知道
自己是从哪来的。不再有公共 `app.lock`。

## 写新示例时注意

- 插件目录名不必等于插件 id；挂载键以 `plugin.json.id` 为准。
- `plugin.json` 只写 `package.json` 表达不了的东西（id、入口、`ui` 需求、
  安全能力），依赖仍然只写在 `package.json` 里。
- 前端产物里只 external 共享白名单（React、`cordis-app/client` 等），其余依赖
  打进自己的 bundle。
- `cordis-app` 照文档声明为 `peerDependencies`，并在 `peerDependenciesMeta`
  里标 optional：仓库根目录的 `.npmrc` 关掉了 `auto-install-peers`，否则 pnpm
  会尝试从 registry 拉取这个尚未发布的框架核心包。
