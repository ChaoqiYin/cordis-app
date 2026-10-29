# cordis-app

插件化 Web 应用的可复用基础设施：一个 Go 外壳、一个 Node 宿主、一套 React 界面，加一条
「装插件不重启整个应用」的完整链路。

应用由若干插件组成，插件可以同时贡献服务端路由与前端页面；安装或卸载插件时，窗口不闪、
登录态不丢、页面自动重连。

## 架构

三个进程，各有单一职责：

```
┌─────────────────────── 外壳（Go）───────────────────────┐
│  窗口 / 托盘 / 单实例锁 / 进程树回收 / 内嵌 UI 释放       │
└──────────────────────────┬─────────────────────────────┘
                           │ fork，从 stdout 读取握手行
                           ▼
┌─────────────────── supervisor（Node）───────────────────┐
│  找空闲端口 → 生成 token → fork worker → 转发日志         │
│  worker 以退出码 75 退出时原地重启，端口与 token 不变     │
└──────────────────────────┬─────────────────────────────┘
                           │ IPC 上报「已就绪」
                           ▼
┌──────────────────── worker（Node）──────────────────────┐
│  内核（cordis 适配层）                                    │
│  内置插件：server / router / auth / static / storage / ws │
│  应用插件：服务端入口 + 前端入口                           │
└─────────────────────────────────────────────────────────┘
```

握手是外壳与 Node 之间唯一的字符串契约：

```
@@CORDIS_APP@@{"ready":true,"port":51482,"token":"…","version":"1.0.0","failures":[]}
```

它只出现在 supervisor 的 stdout 上；worker 通过 IPC 报告就绪，其 stdout 被吞掉。

## 仓库结构

```
packages/
├── kernel/      cordis 适配层 + Kernel 接口（唯一依赖 cordis 的包）
├── runtime/     supervisor、worker、内置插件、插件安装器
├── ui/          React：布局、五个扩展点、设置面板
├── preset/      插件打包预设（esbuild 配置 + 共享模块白名单）
├── cli/         命令行：new / add / remove / run / restart / list
└── shell/       Go 外壳（窗口、单实例、进程树、资源释放）
examples/
└── hello-plugin/  最小可用插件：服务端路由 + 前端页面 + 数据目录
```

## 快速开始

### 环境要求

- Node.js ≥ 20.19（推荐 24 LTS）
- pnpm 10
- Go 1.25（仅构建外壳时需要）

### 安装、构建、运行

```bash
pnpm install
pnpm build

# 新建一个应用，数据目录放在 /tmp/cordis-demo
node packages/cli/lib/cli.js new demo --data /tmp/cordis-demo

# 装上仓库里的示例插件
node packages/cli/lib/cli.js add "file:$PWD/examples/hello-plugin" --data /tmp/cordis-demo

# 启动并在浏览器里打开
node packages/cli/lib/cli.js run --data /tmp/cordis-demo --open
```

左侧活动栏会出现 **Hello** 入口；页面上的访问次数来自插件的服务端路由，数据存在
`<数据目录>/instances/default/data/hello/` 下。

卸载后入口随之消失：

```bash
node packages/cli/lib/cli.js remove cordis-app-example-hello --data /tmp/cordis-demo
```

### 构建桌面外壳

```bash
pnpm build:shell      # 产出 dist/cordis-app
./dist/cordis-app     # 开发态：前端直接读 packages/ui/dist
```

开发态（仓库内运行）不裁剪环境、不释放内嵌资源；正式安装布局下，外壳会把内嵌的 UI
释放到 `resources/ui/`，并按固定规则隔离子进程环境（不继承用户 shell 的调试变量与家目录）。

## 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm build` | 构建全部包与示例插件 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 全仓测试（Node 侧） |
| `pnpm test:shell` | Go 外壳测试 |
| `pnpm build:shell` | 构建外壳二进制 |
| `pnpm dev` | Vite 开发服务器 |

CLI 子命令：

| 命令 | 作用 |
|---|---|
| `new <名字>` | 新建应用（只写清单，不装插件） |
| `add <包名[@版本]>` | 安装插件，支持 npm 包名、tarball、`file:` 路径 |
| `remove <包名>` | 卸载插件 |
| `run` | 前台运行，输出访问地址 |
| `restart` | 请求运行中的 worker 重启 |
| `list` | 列出已安装插件 |

## 编写插件

从 [examples/hello-plugin](./examples/hello-plugin) 开始看——它把插件契约压缩成了
不到 200 行可执行代码。要点：

- `plugin.json` 声明身份与入口，`package.json` 声明依赖与 `cordis-app` peer
- 服务端导出 `name` / `inject` / `apply`，可选导出 `data` 作为前端初始状态
- 前端默认导出 `activate(ctx)`：入口处用命令式 API 注册扩展点，组件内只用 Hooks
- `react` 与 `cordis-app/client` 由框架提供同一份实例，插件不得自带第二份

## 当前状态

已完成 v1 的第一段（端到端闭环）：

- 三进程模型、握手协议、退出码 75 的重启链路
- 内核、内置插件、React UI 骨架与五个扩展点
- 插件的安装 / 卸载 / 失败回滚，前端入口随清单出现与消失
- 外壳的窗口模式、浏览器降级、单实例锁、进程树回收、内嵌 UI 幂等释放

已知限制：

- Linux 与 Windows 外壳尚未实机验证（本机只有 macOS 构建链路）
- 托盘与自动更新属于第二段，尚未实现
- `cordis-app` 核心包尚未作为 npm 包发布，仓库内以路径映射解析

## 参考与致谢

Go 外壳的进程管理参考了 [Koishi Desktop](https://github.com/koishijs/koishi-desktop)
（AGPL-3.0）的实现与设计，具体包括：

- 启动并托管一个外部长驻 Node 进程，从它的 stdout 读取启动信息
- 同时消费 stdout 与 stderr，避免管道缓冲区写满把子进程卡死
- 按平台回收整棵进程树（Windows Job Object / Unix 进程组）
- 用退出码而不是日志文本判断「重启 worker」还是「退出」
- 单实例锁，以及第二次启动时唤起已有窗口
- 显式构造子进程环境，不继承用户 shell 的调试与路径配置

上述部分在 cordis-app 中是**按本项目协议与目录布局重写的实现**，并非逐字复制；
重写日期 2026-10-29。上游版权归 Koishi Desktop 项目及其贡献者所有，许可证为
AGPL-3.0。

## 许可证

[GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0，仅此版本）。

**插件作者使用框架 API 不构成衍生作品**：插件只需声明
`peerDependencies: { "cordis-app": "^1.0.0" }`，可以按自己的许可证分发。
