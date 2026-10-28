# 示例

这里的每个目录都是一个**可以直接装进应用**的插件，同时充当插件契约的可执行
说明书。它们被 `pnpm-workspace.yaml` 纳入工作区，因此可以直接引用仓库内的
`@cordis-app/preset` 与 `@cordis-app/kernel`。

| 目录 | 演示的能力 |
|---|---|
| [hello-plugin](./hello-plugin) | 服务端路由 + 前端页面 + 插件数据目录 |

## 完整流程

```bash
pnpm install
pnpm build                       # 构建框架各包（含示例插件）

node packages/cli/lib/cli.js new demo --data /tmp/cordis-demo
node packages/cli/lib/cli.js add "file:$PWD/examples/hello-plugin" --data /tmp/cordis-demo
node packages/cli/lib/cli.js run --data /tmp/cordis-demo --open
```

`add` 走的是与安装 npm 包完全相同的路径：包管理器写入 `node_modules`、校验
`plugin.json` 与 peer 依赖、更新 `app.json` / `app.lock`。换成 `file:` 只是
spec 的写法不同，插件本身不知道自己是从哪来的。

## 写新示例时注意

- **包名不要加 scope**：`/__plugins/<包目录名>/…` 的 URL 只取包根目录名，带
  scope 的包会被映射到错误路径。
- `plugin.json` 只写 `package.json` 表达不了的东西（id、入口、能力声明），
  依赖仍然只写在 `package.json` 里。
- 前端产物里只 external 共享白名单，其余依赖打进自己的 bundle。
- `cordis-app` 照文档声明为 `peerDependencies`，并在 `peerDependenciesMeta`
  里标 optional：仓库根目录的 `.npmrc` 关掉了 `auto-install-peers`，否则 pnpm
  会尝试从 registry 拉取这个尚未发布的框架核心包。
