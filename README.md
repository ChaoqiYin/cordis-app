# cordis-app

插件化 Web 应用的可复用基础设施：一个项目根、一套 Node 宿主、一套 React 界面，
以及「安装/卸载插件时窗口不闪、页面自动重连」的完整链路。

cordis-app 只支持**项目模式**：应用就是一个普通目录，`package.json` 是依赖的唯一
真源，`app.json` 记录应用身份、启用的插件与 body 提供的 UI 能力。不再有
`instances/default`、平台级数据目录或公共 `app.lock`。

## 项目长什么样

```
<project>/
├── package.json        依赖唯一真源：cordis-app、插件、React
├── app.json            应用身份、启用的插件 id、UI 能力
├── src/
│   ├── body.tsx        项目 body 入口，默认导出 React 组件
│   └── pages/          项目自己的页面
├── server/
│   └── index.js        项目后端入口，默认导出 apply(ctx)
├── plugins/            本地插件，每个子目录一个插件包
├── data/               插件数据与用户配置（可 gitignore）
├── .cordis/            runtime.json、tmp/、logs/、安装事务日志（可 gitignore）
├── node_modules/
└── dist/               build 产物（可 gitignore）
```

`app.json`：

```json
{
  "name": "demo",
  "version": "0.1.0",
  "plugins": ["hello"],
  "ui": {
    "pages": true,
    "slots": ["header.right", "activity.bottom"],
    "menus": ["activity"],
    "settings": true
  }
}
```

- `plugins` 的键是**插件 id**，不是 npm 包名；顺序即启用顺序。缺省或空数组表示
  「发现即启用」。
- `ui` 是项目 body 能提供的能力。同一个形状也出现在 `plugin.json.ui`，表示插件
  **需要**的能力；两者不满足时只告警，不阻断服务端加载。
- 框架版本约束只写在 `package.json`，`app.json` 不保存版本范围。

## 快速开始

环境要求：Node.js ≥ 20.19、pnpm 10。构建 Go 外壳还需要 Go 1.25。

```bash
pnpm install
pnpm build

# 1. 新建项目（只写文件，不联网、不安装依赖）
node packages/cli/lib/cli.js new demo --project /tmp/cordis-demo

# 2. 安装仓库里的示例插件
node packages/cli/lib/cli.js add "file:$PWD/examples/hello-plugin" \
  --project /tmp/cordis-demo

# 3. 开发模式：Vite HMR + worker 自动重启
node packages/cli/lib/cli.js dev --project /tmp/cordis-demo
```

页面左侧会出现 **Hello** 入口；访问次数来自插件的服务端路由，数据写在
`/tmp/cordis-demo/data/hello/visits.txt`。卸载后入口随清单一起消失：

```bash
node packages/cli/lib/cli.js remove cordis-app-example-hello --project /tmp/cordis-demo
```

发布构建与运行构建产物：

```bash
node packages/cli/lib/cli.js build --project /tmp/cordis-demo
node packages/cli/lib/cli.js start --project /tmp/cordis-demo
```

`build` 产出：

```
<project>/dist/
├── app.json
├── package.json
├── resources/
│   ├── ui/          前端壳与项目 body
│   ├── shared/      React、React DOM、cordis-app/client
│   └── plugins/     本地插件的前端与服务端产物
└── server/index.js  项目后端产物
```

`start` 从 `dist/` 读取 `app.json`、前端产物与 server 入口；可写的 `data/` 与
运行时 `.cordis/` 仍按项目根定位。源码根没有 `app.json` 不影响 `start`。

## 项目 body 与 `cordis-app/ui`

body 决定布局，框架只固定宿主职责和四个出口。`cordis-app/ui` 导出：

| 导出 | 作用 |
| --- | --- |
| `BodyHost` | 快捷键、全局右键菜单、顶层错误边界 |
| `DefaultBody` | 框架附带的参考布局，可直接使用 |
| `PluginPageOutlet` | 渲染当前路径对应的插件页面 |
| `PluginSlot` | 渲染具名插槽（`header.right`、`activity.bottom` 等） |
| `PluginMenuTrigger` | 把子元素的右键菜单绑定到某个菜单 id |
| `SettingsPanel` | 插件管理与插件设置面板 |
| `SETTINGS_PATH`、`usePath`、`navigate` | body 自己的导航 |
| `warnUiCompatibility`、`warnUiContractVersion` | UI 能力与契约版本告警 |

body 必须保留自己声明过的出口；项目页面优先于插件页面，未命中时才落到
`PluginPageOutlet`。可以直接用 `DefaultBody` 起步，也可以参考
[examples/full-body](./examples/full-body) 自定义布局——它演示了 pages、slots、
menus、settings 四个出口全部保留的写法。

## 插件契约

一个插件包至少包含 `plugin.json`：

```json
{
  "id": "hello",
  "displayName": "Hello",
  "version": "1.0.0",
  "server": "lib/server.js",
  "client": "lib/client.js",
  "ui": { "pages": true },
  "capabilities": ["storage"]
}
```

- `id` 是挂载键，必须是 URL 安全段；`displayName` 只是展示名。
- `server` 导出 `name` / `inject` / `apply`，可选导出 `data` 作为前端初始状态。
- `client` 默认导出 `activate(ctx)`：入口处用命令式 API 注册扩展点，组件内只用
  Hooks。
- `ui` 声明插件需要的 UI 出口；`capabilities` 声明安全能力，两者不混用。
- `package.json` 必须把 `cordis-app` 写进 `peerDependencies`。

`react`、`react-dom`、`cordis-app/client` 等共享模块由框架提供，整个应用只有一份；插件
构建时保持 external，不得自带第二份 React。完整示例见
[examples/hello-plugin](./examples/hello-plugin)。

## 插件从哪来

四个根按优先级从高到低；实际参与扫描的范围由运行形态决定：

| 优先级 | 根 | 项目模式 | 打包模式 | 典型用途 |
| --- | --- | --- | --- | --- |
| 1 | `resources/plugins` | 有则扫描 | 扫描 | 随产物分发、只读 |
| 2 | `<project>/plugins` | 扫描 | 不扫描¹ | 项目本地插件 |
| 3 | `<project>/node_modules` | 扫描 | 不扫描 | `add` 安装的项目依赖 |
| 4 | `<userData>/plugins` | 有则扫描 | 扫描 | 打包应用的用户安装目录 |

¹ 打包应用的源码插件已由 `build` 复制进 `resources/plugins`；再扫源码根会让同一
批插件重复出现。显式传入 `localPluginsDir` 时本地根仍然生效（`dev` 就靠它指向
`.cordis/dev/plugins`）。打包模式同样不扫描 `node_modules`，避免加载未经签名
校验的依赖。

重复 id 保留高优先级插件，低优先级产生一条失败记录；应用继续启动，只让冲突插件
不可用。

安装有两个来源，由进程配置决定，HTTP 请求不能切换：

- **项目模式**：npm 源在项目根执行包管理器，更新 `package.json`、lockfile，并把
  插件 id 写进 `app.json.plugins`。
- **打包模式**：只接受签名插件包。安装到 `<userData>/plugins/<id>@<version>/`，
  事实写入 `<userData>/installed.json`，不运行 npm。

两种来源共用同一个安装事务：开始前快照事实文件并写事务日志，失败或被中断时回滚。
**只读安装目录**指代码与依赖安装后不再修改；**可写用户数据**指 `<project>/data`
（项目模式）或 `<userData>`（打包模式）。公共 `app.lock` 已移除。

## 签名插件包

`.cordis-plugin` 是 tar.gz，包含 `plugin.json`、`package.json`、server/client
产物与 `bundle.json`。`bundle.json` 记录内容 hash、Ed25519 签名与 peer 范围；
安装时先比 hash、再验签名，任何一步失败都不改动用户插件目录。

格式、hash 规范化、签名载荷与密钥管理见
[docs/plugin-bundles.md](./docs/plugin-bundles.md)。

## 命令行

| 命令 | 作用 |
| --- | --- |
| `new <名字>` | 创建项目（只写文件，不联网） |
| `add <包名[@版本]>` | 安装插件，支持 npm 包名、tarball、`file:` 路径 |
| `remove <包名>` | 卸载插件 |
| `list [--json]` | 列出项目依赖中的插件与启用状态 |
| `run` | 以源码形态启动项目（前台） |
| `dev` | 开发模式：Vite HMR、项目 server 与插件变化重启 worker |
| `build` | 构建 `dist/` 可发布布局 |
| `start` | 运行 `dist/` 构建产物 |
| `restart` | 通过 `.cordis/runtime.json` 重启运行中的项目 |

通用选项：`--project <目录>`（`--data` 是兼容别名；默认当前目录，可用
`CORDIS_APP_PROJECT` 覆盖）、`--resources <目录>`、`--port <端口>`、`--no-open`
（`run`/`dev`/`start` 默认尝试打开浏览器）、`--json`、`-h`、`-v`。

## 架构

```
Go 外壳（可选，桌面分发时使用）
  │ fork，从 stdout 读取握手行
  ▼
supervisor（Node）
  │ 找空闲端口 → 生成 token → fork worker → 转发日志
  │ worker 以退出码 75 退出时原地重启，端口与 token 不变
  ▼
worker（Node）
  │ 内核 + 内置插件：server / auth / router / static / ws / storage
  │ 项目 server 入口 → 应用插件（服务端 + 前端清单）
  ▼
浏览器 / 外壳窗口
```

握手行只出现在 supervisor 的 stdout 上：

```
@@CORDIS_APP@@{"ready":true,"port":51482,"token":"…","version":"1.0.0","failures":[]}
```

Go 外壳负责窗口、单实例锁、进程树回收与内嵌 UI 释放。浏览器模式下 `run`/`dev`/
`start` 直接打印带 token 的访问地址，不依赖外壳。

## 仓库结构

```
packages/
├── protocol/    公共类型、路径布局、共享模块表
├── preset/      插件打包预设（esbuild 配置）
├── kernel/      cordis 适配层（唯一依赖 cordis 的包）
├── runtime/     supervisor、worker、内置插件、安装器、插件包
├── ui/          React 宿主、客户端运行时、项目构建器
├── cli/         命令行实现
├── cordis-app/  聚合包：cordis-app/{client,server,ui,preset,start}
└── shell/       Go 外壳
examples/
├── hello-plugin/  最小可用插件：服务端路由 + 前端页面 + 数据文件
└── full-body/     自定义项目 body：保留全部 UI 出口
```

开发命令：

| 命令 | 作用 |
| --- | --- |
| `pnpm build` | 构建全部包与示例插件 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 全仓测试（Node 侧） |
| `pnpm test:shell` | Go 外壳测试 |
| `pnpm build:shell` | 构建外壳二进制 |

## 不在范围内

以下能力明确不属于当前版本：

- 插件市场服务：目录检索、上传、账户体系、审核流程
- 自动更新
- 托盘
- Linux / Windows 外壳的实机验证（当前只有 macOS 构建链路）
- cordis-app 作为 npm 包发布（仓库内以 workspace 路径解析）

## 参考与致谢

Go 外壳的进程管理参考了 [Koishi Desktop](https://github.com/koishijs/koishi-desktop)
（AGPL-3.0）的实现与设计，包括：托管长驻 Node 进程并读取 stdout 启动信息、
同时消费 stdout/stderr、按平台回收进程树、用退出码判断重启、单实例锁、显式
构造子进程环境。

上述部分在 cordis-app 中是**按本项目协议与目录布局重写的实现**，并非逐字复制；
重写日期 2026-10-29。上游版权归 Koishi Desktop 项目及其贡献者所有，许可证为
AGPL-3.0。

## 许可证

[GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0，仅此版本）。

**插件作者使用框架 API 不构成衍生作品**：插件只需声明
`peerDependencies: { "cordis-app": "^1.0.0" }`，可以按自己的许可证分发。
