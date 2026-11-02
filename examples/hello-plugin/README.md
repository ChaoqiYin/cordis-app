# hello-plugin

最小可用插件：一个服务端路由、一个前端页面、一份插件自己的数据文件。

它是 `cordis-app` 插件契约的可执行说明书——把两个入口、`plugin.json`、
`plugin.json.ui`、共享模块外部化这几件事放在一个不到 200 行的例子里。看完这个
目录，应当能直接写自己的插件。

## 目录

```
hello-plugin/
├── plugin.json         ← 插件身份：id、入口、UI 需求、安全能力
├── package.json        ← 依赖与 peer（cordis-app 必须声明为 peer）
├── build.mjs           ← 两次 esbuild：服务端 node / 前端 browser
├── src/server.ts       ← 服务端入口：router + storage
├── src/client.tsx      ← 前端入口：注册页面，组件里用 Hooks
└── lib/                ← 构建产物，被 worker 与浏览器加载（不入库）
```

## 契约要点

- **服务端入口**导出 `name` / `inject` / `apply`，还可以导出 `data`——它会随
  前端清单一起送到浏览器，省掉一次请求。
- **前端入口**默认导出 `activate(ctx)`，在入口处调用一次命令式 API 注册扩展点；
  组件内部只用 Hooks。
- `plugin.json.ui` 声明插件需要的 UI 出口。本插件只注册页面，所以写
  `{ "pages": true }`；`capabilities` 继续表示安全能力（这里是 `storage`），
  两者不混用。
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

也可以直接跑仓库根目录的 `pnpm build`，它会连同框架各包一起构建。

## 装进一个项目

在仓库根目录执行：

```bash
# 1. 建一个空项目（只写文件，不联网）
node packages/cli/lib/cli.js new demo --project /tmp/cordis-demo

# 2. 按路径安装本插件
node packages/cli/lib/cli.js add "file:$PWD/examples/hello-plugin" \
  --project /tmp/cordis-demo

# 3. 开发模式
node packages/cli/lib/cli.js dev --project /tmp/cordis-demo
```

左侧会出现 **Hello** 入口，页面上的访问次数会随每次打开递增，数据文件在
`/tmp/cordis-demo/data/hello/visits.txt`（项目根下的 `data/`，不是全局数据目录）。

卸载：

```bash
node packages/cli/lib/cli.js remove cordis-app-example-hello --project /tmp/cordis-demo
```

卸载后活动栏的入口随清单一起消失——页面注册在插件的前端作用域里，作用域销毁
时注册表把它的条目一并清掉。

## 测试

```bash
pnpm --filter cordis-app-example-hello test
```

- `test/server.test.ts` 直接执行服务端源码，用假 ctx 验证路由与落盘。
- `test/render.test.ts` 按真实构建方式把前端入口打成临时 ESM，交给框架的
  `ClientRuntime` 加载，再用 `react-dom/server` 渲染 `PluginPageOutlet`。
  不需要浏览器。
