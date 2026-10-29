# hello-plugin

最小可用插件：一个服务端路由、一个前端页面、一个自己的数据目录。

它是 `cordis-app` 插件契约的可执行说明书——把两个入口、`plugin.json`、共享模块
外部化这三件事放在一个不到 200 行的例子里。看完这个目录，应当能直接写自己
的插件。

## 目录

```
hello-plugin/
├── plugin.json         ← 插件身份：id、入口、能力声明
├── package.json        ← 依赖与 peer（cordis-app 必须声明为 peer）
├── build.mjs           ← 两次 esbuild：服务端 node24 / 前端 browser
├── src/server.ts       ← 服务端入口：router + storage
├── src/client.tsx      ← 前端入口：注册页面，组件里用 Hooks
└── lib/                ← 构建产物，被 worker 与浏览器加载（不入库）
```

## 契约要点

- **服务端入口**导出 `name` / `inject` / `apply`，还可以导出 `data`——它会随
  前端清单一起送到浏览器，省掉一次请求。
- **前端入口**默认导出 `activate(ctx)`，在入口处调用一次命令式 API 注册扩展点；
  组件内部只用 Hooks。
- `react` 与 `cordis-app/client` 在构建时是 external，浏览器经 import map 拿到
  框架提供的那一份实例。插件**不得**自带第二份 React。
- `cordis-app` 只在 `import type` 里出现，构建后被擦除；运行时代码由 worker 提供。
- `peerDependenciesMeta` 把 `cordis-app` 标为 optional，只是为了不让仓库内的
  pnpm 去 registry 找它——框架尚未以 npm 包的形式发布。安装器校验的仍然是
  `peerDependencies` 里有没有这一项，optional 不改变契约。

## 构建

```bash
pnpm --filter cordis-app-example-hello run build
```

## 装进一个应用

在仓库根目录执行：

```bash
# 1. 建一个空应用（数据目录在 /tmp/cordis-demo）
node packages/cli/lib/cli.js new demo --data /tmp/cordis-demo

# 2. 按路径安装本插件
node packages/cli/lib/cli.js add "file:$PWD/examples/hello-plugin" --data /tmp/cordis-demo

# 3. 启动
node packages/cli/lib/cli.js run --data /tmp/cordis-demo --open
```

左侧活动栏会出现 **Hello** 入口，页面上的访问次数会随每次打开递增，数据文件在
`/tmp/cordis-demo/instances/default/data/hello/visits.txt`。

卸载：

```bash
node packages/cli/lib/cli.js remove cordis-app-example-hello --data /tmp/cordis-demo
```

卸载后活动栏的入口随清单一起消失——页面注册在插件的前端作用域里，作用域销毁
时注册表把它的条目一并清掉。
