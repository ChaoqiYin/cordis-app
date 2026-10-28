# cordis-app 架构方案

> 一个面向「外壳 — 网页 — 插件」三层的通用基础设施：应用由插件组成，插件同时扩展服务端与前端，外壳可选。
>
> 本文档描述的是框架层面的设计结论，不包含具体业务应用。框架基于 cordis 3.18.1 构建，非 cordis 官方项目。

---

## 目录

1. [定位与边界](#1-定位与边界)
2. [总体架构](#2-总体架构)　·　进程模型 / 启动方式 / 外壳
3. [核心概念](#3-核心概念)　·　应用 / 实例 / 插件
4. [内核层](#4-内核层)　·　为什么 cordis / Kernel 接口 / 内置插件
5. [插件模型](#5-插件模型)　·　双端入口 / 依赖处理 / 冲突判定
6. [运行时契约](#6-运行时契约)　·　握手 / 退出码 / 重启 / 安装
7. [UI 扩展点](#7-ui-扩展点)　·　五件套 / 菜单 / 资源加载
8. [配置系统](#8-配置系统)
9. [安全模型](#9-安全模型)
10. [目录布局](#10-目录布局)
11. [构建与分发](#11-构建与分发)
12. [工程结构](#12-工程结构)
13. [许可与来源](#13-许可与来源)
14. [v1 范围与验收](#14-v1-范围与验收)
15. [已知代价](#15-已知代价)

---

## 1. 定位与边界

### 1.1 它是什么

`cordis-app` 是一个**插件化 Web 应用的可复用基础设施**。它同时提供：

- 一套插件运行时（服务端 + 前端双端）
- 一套自带的 Web UI 骨架，插件可向其中挂载页面、插槽、菜单、设置面板
- 一个可选的桌面外壳，用于窗口、托盘、自动更新

框架不假设具体业务。任何 Web 应用都可以通过「把功能拆成插件」的方式构建在它之上。

### 1.2 核心判断

| 判断 | 结论 | 含义 |
|---|---|---|
| 插件是双端的 | 一个包同时有服务端入口和前端入口 | 插件能注册服务、跑任务，也能贡献 UI |
| 外壳是可选的 | 无外壳时退化为「启动器 + 浏览器」 | 功能不因缺少外壳而残缺 |
| 插件可运行时安装 | 用户不重新打包应用即可添加插件 | 强制宿主进程与外壳解耦 |
| 实例是单例的 | 一个运行单元 = 一个 worker + 一套插件 | 多实例只做结构预留 |
| 安装即信任 | 插件能力在清单中声明，运行时不拦截 | 与 VS Code 扩展、Koishi 插件同模型 |

### 1.3 明确不做的事

- **不做插件市场 UI**。运行时安装的通道要有，但版本选择、评分、搜索不是框架的职责。
- **不允许插件扩展外壳**。原生菜单、托盘、窗口装饰由外壳固定提供，插件够不到。
- **不做跨实例的共享守护进程**。多实例意味着插件环境隔离与版本重新解析，这与单实例的前提冲突。
- **不做跨大版本的 peer 依赖共存**。冲突时在安装阶段硬失败，而不是运行时妥协。

---

## 2. 总体架构

### 2.1 进程模型

```
┌─────────────────────────────────────────────────────────┐
│ 外壳（Go，可选）                                        │
│  ├─ 窗口（系统 WebView）                                │
│  ├─ 托盘 / 自动更新 / 单实例锁                          │
│  └─ 不参与任何业务逻辑                                  │
└─────────────────────────────────────────────────────────┘
                          │ spawn，只读握手行
┌─────────────────────────────────────────────────────────┐
│ supervisor（Node，约 100 行）                           │
│  ├─ 分配端口与 token                                    │
│  ├─ 转发 worker 的日志                                  │
│  ├─ worker 就绪后输出握手行                             │
│  └─ 见退出码 75 → 重新 fork                             │
└─────────────────────────────────────────────────────────┘
                          │ fork（端口与 token 不变）
┌─────────────────────────────────────────────────────────┐
│ worker（Node，承载一切）                                │
│  ├─ 内核：cordis + Kernel 接口                          │
│  ├─ 内置插件：server/router/static/ws/auth/storage      │
│  ├─ 应用插件：服务端逻辑                                │
│  └─ HTTP：静态资源 + 插件前端资源 + API + WebSocket     │
└─────────────────────────────────────────────────────────┘
                          │ 浏览器加载
┌─────────────────────────────────────────────────────────┐
│ 前端（React 19 + TS）                                   │
│  ├─ 框架布局：活动栏 / 页头 / 插槽 / 设置面板           │
│  └─ 插件 UI：动态 import，挂载到扩展点                  │
└─────────────────────────────────────────────────────────┘
```

**为什么需要两层 Node。** 运行时装插件后，`require.cache` 无法可靠卸载，所以必须重启进程才能加载新代码。如果只有一个 Node 进程，重启意味着整个应用退出——桌面模式下可以由外壳重新拉起，但不带外壳的浏览器模式下无人重启。把「运行插件的 worker」和「决定何时重启它的 supervisor」分开，重启这件事就完全落在 Node 侧，外壳与 CLI 都只负责拉起一次。

**supervisor 的职责严格受限。** 它不加载任何插件、不碰业务、不持有平台相关的逻辑。它只做五件事：分配端口与 token、fork worker、转发 worker 的日志、输出握手行、按退出码决定是否重新 fork。这一约束保证它永远不会成为架构的复杂度来源。

分配端口与 token 之所以放在 supervisor 而不是 worker，是因为它们的生命周期必须**跨 worker 重启**——worker 每次都是全新进程，上一份状态随进程消失，只有 supervisor 一直活着。这也是 supervisor 存在的第二个理由（第一个是重启），两个理由都指向同一个事实：**它是唯一稳定的、能持有跨重启状态的那一层。**

### 2.2 两种启动方式

**桌面模式**

```
用户双击 → 外壳启动 → spawn supervisor
         → 读 stdout 握手（端口 / token / 版本 / 失败插件）
         → 窗口导航到 http://127.0.0.1:<port>/#token=<token>
```

外壳不猜端口、不生成 token，全部来自握手行——它只需要等这一行，然后开窗。

**浏览器模式**

```
用户执行 cordis-app run → CLI 启动 supervisor → 读 stdout 握手
                        → 打印访问 URL（含 token）→ 由用户用浏览器打开
```

两种模式的差异只有「谁拉起 supervisor」和「谁打开 URL」，worker 内部的运行逻辑完全一致。

**端口与 token 的归属**

两者的生命周期都必须**跨 worker 重启**，因此由 supervisor 持有：

```
supervisor 启动
  → 监听 127.0.0.1:0 取得空闲端口后立即释放
  → 生成 32 字节随机 token
  → 把端口与 token 写入环境变量，fork worker

worker 绑定该端口
  → 若 EADDRINUSE，退出并告知 supervisor 换端口重试（最多 5 次）
```

worker 重启时环境变量不变，页面因此留在同一个 origin 上、拿着同一个 token 重连——这是「不闪窗」的前提。

**supervisor 的 stdout 只有一个用途：输出握手行。** 它自己不打日志（日志走 stderr），也把 worker 的 stdout 全部吞掉，只在收到 worker 的「就绪」IPC 消息后合成一行写出去。于是外壳面对的是一个干净、只有握手的管道。

token 放在 URL 的 fragment 而非 query，是因为 fragment 不会进入服务端访问日志，也不会随 `Referer` 外泄。

### 2.3 外壳（Go）

外壳是一个独立的 Go 程序，职责被刻意压到最小：

| 职责 | 说明 |
|---|---|
| 拉起 supervisor | 找到 `bin/node`，以 supervisor 脚本为参数启动，工作目录固定 |
| 读握手、开窗 | 等 stdout 上那一行，解析端口与 token，导航到对应 URL |
| 单实例锁 | 第二次启动时把已有窗口提到前台，而不是再起一个实例 |
| 托盘 | 显示 / 隐藏、重启、退出、打开日志目录 |
| 自动更新 | 下载新版本、校验、替换、重启 |
| 子进程治理 | 外壳退出时确保整棵进程树被回收（Windows 用 Job Object，Unix 用进程组） |

**它不做的事比做的事更重要**：不解析配置、不加载插件、不代理 HTTP、不在页面与后端之间传话。任何一项都会让浏览器模式出现分叉。

**WebView 降级。** 外壳优先使用系统 WebView（Windows 上 WebView2，macOS 上 WKWebView）。若目标环境缺少运行时（例如老版本 Windows 未安装 WebView2），退化为调用系统默认浏览器打开同一个 URL——功能完整，只少托盘与窗口装饰。这条降级路径与「浏览器模式」共用同一套实现，不是额外分支。

**子进程治理的平台差异。** Windows 没有进程组，必须创建 Job Object 并把 supervisor 加入，才能保证外壳退出时 worker 不会变成孤儿；Unix 则用 `setpgid` + 向进程组发信号。这是两个平台各写一段、无法抽象掉的部分。

**为什么自建而不直接用 Tauri。** 外壳需要的「启动一个外部长驻进程、读它的 stdout、控制它的生命周期」恰好是 Tauri 不擅长而 Go 擅长的事；同时外壳要随包分发 Node 与 `node_modules`，需要精确控制安装目录布局，自建更容易。从 Koishi Desktop 复制过来的部分正是这些进程管理代码，`vendor` 进来即可复用。

---

## 3. 核心概念

### 3.1 应用（App）

应用由 `app.json` 定义，是用户获得的完整产物。

```jsonc
{
  "name": "my-app",
  "version": "1.0.0",
  "icon": "assets/icon.png",
  "framework": "^1.0.0",
  "plugins": {
    "theme-picker": "^2.1.0",
    "file-upload": "^1.4.0",
    "auth": "^3.0.0"
  }
}
```

`app.json` 只描述**直接依赖**。传递依赖由 `app.lock` 锁定：

```jsonc
{
  "lockfileVersion": 1,
  "plugins": {
    "theme-picker": {
      "version": "2.1.3",
      "resolved": "https://registry.npmjs.org/theme-picker/-/theme-picker-2.1.3.tgz",
      "integrity": "sha512-...",
      "dependencies": { "lodash": "4.17.21" }
    }
  }
}
```

**为什么区分两份文件。** `app.json` 表达意图（允许小版本升级），`app.lock` 记录事实（实际装了什么）。只有 `app.json` 会导致同一应用在两台机器上行为不同；只有精确版本会让作者无法表达升级诉求。`app.lock` 同时使离线安装和可复现构建成为可能——安装时无需重新解析依赖图。

**`app.json` 不是 `package.json`。** 实例目录里确实也有一份 `package.json`，但它由框架从 `app.json` 生成，只承担一件事：让包管理器知道往 `node_modules` 里装什么。用户永远只编辑 `app.json`；`package.json` 与 `app.lock` 一样是派生物，改动会在下次解析时被覆盖。

这样区分的理由与插件清单一致：**用户表达意图，框架生成实现细节。** 手写 `package.json` 会让「哪些字段框架说了算」变成需要解释的规则，而派生之后这条规则不需要存在。

### 3.2 实例（Instance）

单实例，但目录按实例名组织：

```
data/instances/default/
├── app.json         ← 用户编辑的唯一清单
├── app.lock         ← 解析结果
├── package.json     ← 从 app.json 派生
├── config.json      ← 插件配置
└── node_modules/
```

实例名固定为 `default`，路径中保留 `instances/` 这一层是为了让整个目录可被直接复制、备份、迁移——**结构预留，抽象不预留**。`Instance` 对象不会贯穿生命周期，多实例一旦需要，本质上是引入插件环境隔离与版本重新解析，不是把路径参数化就能解决。

启动时数据目录按以下顺序解析，先命中者生效：

| 顺序 | 来源 | 用途 |
|---|---|---|
| 1 | `CORDIS_APP_DATA` 环境变量 | 测试、便携版、多份数据并存 |
| 2 | 命令行 `--data <dir>` | 同上，且可脚本化 |
| 3 | 平台标准目录 | 默认值（见下表） |

| 平台 | 默认数据目录 |
|---|---|
| Windows | `%APPDATA%\cordis-app\` |
| macOS | `~/Library/Application Support/cordis-app/` |
| Linux | `$XDG_DATA_HOME/cordis-app/`，缺省 `~/.local/share/cordis-app/` |

### 3.3 插件（Plugin）

插件是一个 npm 包，通过 `plugin.json` 声明身份与能力。

```jsonc
{
  "id": "theme-picker",
  "displayName": "主题选择器",
  "server": "./dist/index.js",
  "client": "./dist/client.js",
  "capabilities": ["fs:read", "net"]
}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `id` | 唯一标识，与 npm 包名分离，允许同一包在不同应用中以不同 id 出现 |
| `server` | 服务端入口，可选。缺失则插件只贡献前端 |
| `client` | 前端入口，可选。缺失则插件只贡献服务端能力 |
| `capabilities` | 能力声明列表，用于安装 UI 展示，运行时不拦截 |

**`plugin.json` 只补 `package.json` 表达不了的东西。** 依赖仍然只写在 `package.json` 里——包括 `peerDependencies`。清单里再抄一份会立刻产生「两处不一致时以哪个为准」的问题，而唯一可靠的答案是「以包管理器用的那份为准」。同理，配置 schema 由代码导出（`export const Config`），不写进清单。

于是职责边界很清楚：`package.json` 管「这个包怎么被安装」，`plugin.json` 管「装好之后框架怎么使用它」。

**为什么用独立文件而不是 `package.json` 扩展字段。** 两个文件回答两个问题，混在一起会让「插件作者需要理解应用层」这一错误认知根深蒂固；而且 `package.json` 是包管理器的领地，往里塞框架私有的字段，一旦与包管理器的校验或工具链冲突，就没有退路。独立文件还能让未来支持非 npm 形态的插件（本地目录、单文件）成为可能——尽管 v1 不做。

---

## 4. 内核层

### 4.1 为什么复用 cordis

cordis 3.18.1 提供了本框架最难以自己实现的部分：

| 能力 | 说明 |
|---|---|
| effect 栈 | 所有副作用（服务注册、事件监听、定时器）都是可撤销的 |
| 作用域级联销毁 | 卸载插件时逆序 dispose，不留残渣 |
| 服务注入 | `inject` + Proxy 查表，可安全压缩 |
| 隔离表 | symbol 键沿原型链继承，按名字粒度控制 |
| 状态机 | PENDING / LOADING / ACTIVE / FAILED / DISPOSED |
| 软等待 | 依赖未就绪时插件挂起，就绪后自动恢复 |
| 异步 epoch 校验 | 加载到一半被卸载时，丢弃过期的异步结果 |

最后一条尤其重要——「插件加载到一半被卸载」这类竞态，自己实现会在生产环境中反复踩坑。

### 4.2 Kernel 接口

cordis 的内部概念（Fiber、Scope、effect）**不暴露给插件作者**。框架在 cordis 之外包一层：

```ts
export interface Kernel {
  plugin(definition: PluginDefinition, config?: unknown): Disposable
  service<T>(name: string, factory: (ctx: ServerContext) => T): Disposable
  emit(event: string, ...args: unknown[]): void
  on(event: string, handler: (...args: unknown[]) => void): Disposable
  isolate(name: string): Kernel
  restart(name: string): Promise<void>
}
```

只有 `packages/kernel` 依赖 cordis。这条约束的价值在于：未来若 cordis 4.x 稳定或需要替换内核，改动面被限制在一个包内。

`Kernel` 是最小面，`ServerContext` 是它的扩展：内置插件通过 `kernel.service()` 注册 `router`、`storage` 等服务，这些服务以类型声明（declaration merging）的形式出现在 `ServerContext` 上。插件作者看到的是 `ctx.router`、`ctx.storage`，看不到 `kernel` 这一层。

### 4.3 极简内核与内置插件

内核本身只提供：日志、配置持久化、生命周期、事件总线。其余全部是**可替换的内置插件**：

```
内置插件（可被应用替换或移除）
├── server     HTTP 服务、端口监听、握手
├── router     API 路由
├── static     静态资源与插件前端资源分发
├── ws         WebSocket 推送
├── auth       token / Origin 校验
└── storage    插件数据目录的受管读写
```

`storage` 单独成插件而不是塞进内核：内核只保证「配置能持久化」，用户数据（上传的文件、缓存、数据库）的存放策略属于应用决策。默认实现把数据放在 `instances/default/data/<plugin-id>/`，应用可以换成一个走对象存储的实现，插件代码不变。

**为什么不是中等内核。** 把 HTTP 框架的选择写进内核，会锁死应用最可能想替换的东西；而「配置持久化、日志、生命周期」无法由插件提供——插件自己就依赖它们，所以必须在最底层。

---

## 5. 插件模型

### 5.1 服务端入口

```ts
import { Schema } from 'cordis-app'
import type { ServerContext } from 'cordis-app'

export const name = 'theme-picker'
export const inject = ['router', 'storage']
export const Config = Schema.object({
  accent: Schema.string().role('color').default('#4f7cff').description('强调色'),
  dark: Schema.boolean().default(false).description('深色模式'),
})

export function apply(ctx: ServerContext, config: Config) {
  ctx.router.get('/api/theme', async (req, res) => {
    res.json({ accent: config.accent, dark: config.dark })
  })
}
```

### 5.2 前端入口

```ts
import type { ClientContext } from 'cordis-app/client'
import ThemePanel from './ThemePanel'

export default (ctx: ClientContext) => {
  ctx.page({
    path: '/theme',
    name: '主题',
    icon: 'palette',
    component: ThemePanel,
  })

  ctx.menu('activity', [
    { id: '.reset', label: '重置主题' },
  ])

  ctx.action('.reset', {
    action: () => ctx.http.post('/api/theme/reset'),
  })
}
```

`ctx.http` 是一层极薄的封装（基于 axios），负责自动附加 token、统一错误处理与重试。插件不必自己拼 `Authorization` 头——token 的注入点只有一个，未来加固时不需要改每个插件。

### 5.3 两套 API 的边界

前端同时提供**命令式 API** 与 **React Hooks**：

| 形态 | 用途 | 示例 |
|---|---|---|
| 命令式 | 注册与副作用 | `ctx.page()`、`ctx.slot()`、`ctx.menu()`、`ctx.action()`、`ctx.settings()` |
| Hooks | 组件内读取状态 | `useMenu()`、`useConfig()`、`usePluginState()`、`useAppearance()` |
| 组件 | 消费已注册的内容 | `<Slot name="sidebar.bottom" />` |

边界规则：**命令式 API 只在插件入口处调用一次，用于注册；组件内部一律用 Hooks 或声明式组件。** 这条规则不是风格偏好——命令式 API 依赖 cordis 的 effect 生命周期，在组件渲染阶段调用会导致重复注册与内存泄漏。

`ctx.slot()` 注册内容，`<Slot>` 消费内容，是同一枚硬币的两面：框架布局里预置若干个具名插槽（如 `header.right`、`sidebar.footer`），插件往其中挂载组件，阅读顺序由 `order` 决定、同序号时按注册顺序稳定排序。

### 5.4 依赖处理

插件依赖分三类，各有明确规则。

**① 普通依赖**——由包管理器处理，框架不介入。

```
node_modules/
├── lodash/                  ← 4.x，hoist 到顶层
└── theme-picker/
    └── node_modules/lodash/ ← 3.x，局部嵌套
```

Node 的模块解析从当前文件逐级向上查找 `node_modules`，多版本共存是模块系统自带能力。

**② 核心包**——必须声明为 `peerDependencies`。

```jsonc
{ "peerDependencies": { "cordis-app": "^1.0.0" } }
```

框架核心包持有服务注册表与事件总线，出现第二份会导致插件各自正常、彼此失联——这是最难排查的一类问题。**安装时强制校验**，缺失或版本不符直接拒绝。

**③ 前端共享模块**——通过 external + import map 共享。

```html
<script type="importmap">
{
  "imports": {
    "react": "/__shared/react.js",
    "react-dom": "/__shared/react-dom.js",
    "react/jsx-runtime": "/__shared/jsx-runtime.js",
    "cordis-app/client": "/__shared/client.js"
  }
}
</script>
```

插件前端 bundle 把以上模块标为 external，浏览器通过 import map 解析到框架提供的同一份实现。

**为什么用 import map 而非 `window` 全局。** 全局方案要求插件依赖的每一个第三方库（例如某个 UI 库）把其中的 `react` 引用也改写为全局变量，构建配置会迅速失控。import map 是浏览器原生能力，external 语义与 Node 完全一致，插件作者不需要知道「共享」这件事的存在。

**共享白名单固定为**：`react`、`react-dom`、`react/jsx-runtime`、`cordis-app/client`。白名单之外的依赖一律打进插件自己的 bundle。

### 5.5 依赖布局变化的判定

安装插件会重新计算整棵依赖树的布局——此前 hoist 到顶层的包，可能因新包的版本冲突而被下沉。

```
安装前：node_modules/lodash → 4.17.21
安装后：node_modules/lodash → 3.10.1
        node_modules/theme-picker/node_modules/lodash → 4.17.21
```

已加载的插件缓存仍指向旧路径，行为可能悄然改变。

**规则：安装前后各读一次 `node_modules` 布局，对已加载插件依赖到的每个包做 resolved 路径 diff，有任何变化就重启 worker。**

注意 diff 的对象是「原有包是否搬家」，不是「装了哪些新包」——新增一个此前不存在的包不会影响任何已加载的模块，不必重启（见 6.4）。

本框架把重启成本压到 1~3 秒，因此可以采取「宁可多重启一次」的保守策略；Koishi 依赖的是 `require.cache` 判定，不做布局比对，是因为它的重启代价高得多。

### 5.6 peer 冲突的判定时机

两个插件分别要求 `react@18` 与 `react@19` 时，**安装阶段硬失败**。

冲突检测前移的理由：框架前端的 React 只有一份，第二个实例必然导致 hooks 崩溃；把问题推迟到运行时，用户看到的是玄学故障而不是一句明确提示。实现上，安装时展开插件的 `peerDependencies`，与框架共享白名单比对，不兼容则拒绝并给出具体原因。

---

## 6. 运行时契约

### 6.1 握手协议

worker 就绪后，supervisor 向自己的 **stdout** 输出一行带标记的 JSON（外壳与 CLI 都读这一行）：

```
@@CORDIS_APP@@{"ready":true,"port":51823,"token":"…","version":"1.0.0","failures":[]}
```

字段说明：

| 字段 | 说明 |
|---|---|
| `ready` | 服务已开始接受请求（HTTP 已监听 **且** 插件已加载完） |
| `port` | 实际监听端口，用于校验 worker 是否绑定了分配的那个端口 |
| `token` | 会话令牌，API 与 WebSocket 均需携带 |
| `version` | 框架版本，外壳据此判断兼容性 |
| `failures` | 加载失败的插件列表（id + 原因） |

**握手回传的是「就绪」，不是「发现」。** 端口与 token 由 supervisor 在 fork 之前就确定并注入 worker，握手只是把它们公布出去。worker 就绪后通过 **IPC 消息**（`process.send({ ready: true, port, failures })`）告知 supervisor，而不是往 stdout 写——worker 的 stdout 被 supervisor 吞掉，保证外壳看到的管道上只可能出现 supervisor 自己输出的握手行。

这让启动路径没有探索性：supervisor 不必解析任何日志来判断「服务是不是起来了」，只需等一条结构化消息。

**为什么不用日志嗅探。** Koishi Desktop 通过匹配 `" server listening at "` 提取 URL，日志文案一变就失效。本框架的三方都在自己的控制下，没有理由再依赖文本匹配。

**为什么 stdout 只承载握手。** 端口文件有「读到的是上一次运行留下的」这一经典问题，必须配合 pid 与进程存活检查才可靠；stdout 是外壳与被拉起进程之间天然存在的管道，进程死了管道就断，不存在陈旧值。

**一条容易被忽略的陷阱：`pipe` 写满会阻塞。** 外壳若只读 stdout 而不读 stderr，worker 的日志一旦攒满管道缓冲区（Windows 约 4KB，Unix 通常 64KB），worker 就会阻塞在 `write()` 上，表现为「应用卡死但不报错」。因此外壳必须**同时**消费 stdout 与 stderr，哪怕后者只是丢弃或写入日志文件。这是 Koishi Desktop 已经踩过、本框架必须显式写明的坑。

`runtime.json` 由 supervisor 在输出握手行后写入，内容是端口、token、pid，供 CLI 判断「是否已在运行」以及供第三方工具发现当前实例。它是派生文件，不参与启动。

**同一份数据的两条通道。** 握手是「推送」（谁拉起 supervisor 谁立刻拿到），`runtime.json` 是「拉取」（后来者主动读）。两者内容一致，用途不同：启动路径永远走推送，避免读文件带来的竞态。

### 6.2 退出码

| 码 | 含义 | 行为 |
|---|---|---|
| `0` | 正常退出 | 不重启 |
| `75` | 请求重启 | supervisor 重新 fork worker |
| `76` | 端口被占用 | supervisor 换端口重试，重新 fork（最多 5 次） |
| 其他 | 异常退出 | supervisor 记录日志并退出，由外壳/CLI 决定是否提示 |

退出码只承载「接下来做什么」这一个语义。Koishi 用 51/52 区分「重启 worker」与「连 supervisor 一起换」，本框架不需要这个区分——supervisor 永远存活到外壳或用户终止它为止。

`76` 单独一码的原因：端口冲突是启动期最常见的失败，且**只有 supervisor 能处理**（它持有分配逻辑）。让 worker 直接 exit 而不是自己重试，是为了保持「worker 不碰端口分配」这条边界。

但 `76` 只允许出现在**首次启动**。worker 重启时端口已经在用，此刻换端口会让页面落在旧 origin 上、彻底失去重连的可能——所以重启阶段遇到 `EADDRINUSE`，supervisor 不换端口，而是把它当作致命错误：记录日志、退出，把「端口被别的进程占走了」如实报告给外壳或 CLI。这是唯一一处「宁可失败也不自动恢复」的地方，因为自动恢复的代价比失败更高。

### 6.3 重启流程

```
worker 检测到需要重启
  → 关闭 HTTP 监听（不再接受新请求）
  → 通知所有 WebSocket 客户端：即将重连
  → dispose 全部插件（逆序）
  → process.exit(75)

supervisor 收到 75
  → fork 新 worker（环境变量带上同一个端口与 token）
  → 新 worker 经 IPC 报告就绪
  → supervisor 输出新的握手行（token 与端口不变）
  → 前端探测到服务恢复，自动重连
```

**端口与 token 由 supervisor 持有，worker 只接收。** 两者在 worker 重启间保持不变，否则页面会落在旧 origin 上、或拿着过期 token 无法重连——「不闪窗」就无从谈起。supervisor 只在自身启动时生成一次。

**窗口不重启。** 前端拿到「即将重连」通知后进入等待态，随后轮询 `/__health`（不校验 token）直到服务恢复，再携带原 token 重连。轮询而非依赖 WebSocket 重连，是因为旧连接随旧进程一起消失了，前端此刻处于「不知道什么时候好」的盲区。轮询间隔 200ms，上限 30 秒后提示用户。

**外壳也不需要重新读握手。** 端口与 token 都不变，外壳完全不必感知 worker 的重启——它只管一次：启动时读一行握手、开窗。后续的重启是 supervisor 与页面之间的事。这条划分让外壳的逻辑极简，也解释了为什么 supervisor 必须持有端口与 token。

**前端状态如何保住。** 「不丢登录态」不靠任何特殊机制：页面本身从未卸载，React 状态、路由位置、表单内容都还在内存里。唯一的约束是**前端只能通过 `ctx.http` 与 WebSocket 访问后端**，不能在模块作用域缓存后端返回的引用对象——那些对象随旧 worker 一起失效了。这条约束在框架层已经满足，插件作者不需要额外留意。

**页面会不会加载到一半。** 新 worker 的 `/__health` 只会在「HTTP 已监听 **且** 全部插件加载完成」之后才返回 200。若前半段就绪，页面重连后立刻请求接口会 404 或打到未初始化的服务。把「就绪」定义为完整就绪，让前端只需判断一次。

### 6.4 安装后生效策略

| 场景 | 处理 |
|---|---|
| 安装**新**插件 | 直接 `kernel.plugin()` 挂载，不重启 |
| **升级**已加载插件 | 重启 worker |
| **卸载**插件 | dispose + 删除文件 + 重启 worker |
| 依赖布局发生**任何**变化 | 重启 worker（见 5.5） |
| 修改插件**配置** | 插件级 restart（见 8.3） |

判定「新插件」的依据是它是否已进入 `require.cache`——没有旧代码残留，重启就是纯粹的浪费。Koishi 的市场插件使用同样的判断逻辑。

### 6.5 安装通道

框架提供运行时安装能力，但**不提供市场 UI**。安装动作有两个入口，走同一条实现：

| 入口 | 形式 |
|---|---|
| 命令行 | `cordis-app add <package>` / `cordis-app remove <package>` |
| 应用内 | `POST /api/plugins` / `DELETE /api/plugins/:id`，自带设置页调用 |

安装流程：

```
① 校验插件清单（plugin.json 存在且入口文件可解析）
② peerDependencies 与框架白名单比对，冲突则拒绝
③ 记录安装前的 node_modules 布局
④ 调用包管理器写入 node_modules（yarn，nodeLinker: node-modules）
⑤ 重新读取布局，与第 ③ 步 diff
⑥ 更新 app.json / app.lock
⑦ 按 6.4 的规则决定：直接挂载，或重启 worker
```

**为什么用 Yarn 而不是 npm。** 单文件 CLI（`yarn.cjs`）可以直接随包分发，不需要用户机器上有全局安装；`nodeLinker: node-modules` 关闭 PnP 后，产出的目录结构与 npm 一致，插件作者用哪个都无所谓。若用户环境已有 `pnpm`，框架不阻止，但默认路径是自带的 Yarn。

**安装失败必须可回滚。** 第 ④ 步失败时用 `app.lock` 回到安装前状态——这正是保留 lock 的直接收益：不需要「卸载残留」，只需按记录重装。

**没有市场，但有地址。** 用户在 UI 里粘贴的是包名（`@scope/plugin-foo@1.2.3`）或 tarball URL，框架不做搜索、评分、版本选择。把「发现插件」留给外部站点，框架只负责「装、跑、卸」。

---

## 7. UI 扩展点

### 7.1 五件套

| 扩展点 | 签名 | 作用 |
|---|---|---|
| `ctx.page()` | `{ path, name, icon, component, order, authority }` | 注册路由 + 活动栏入口 |
| `ctx.slot()` | `{ type, component, order }` | 向具名位置挂载组件 |
| `ctx.menu()` | `(id, items[])` | 往指定菜单追加菜单项 |
| `ctx.action()` | `(id, { action, shortcut, disabled })` | 菜单项行为与快捷键 |
| `ctx.settings()` | `{ id, title, schema \| component }` | 设置面板分组 |

所有注册调用都返回 `() => void`，并且绑定在当前插件的 effect 生命周期上——插件卸载时，页面、菜单、设置项全部自动消失，不需要插件作者写清理代码。

### 7.2 菜单机制

菜单与触发分离：

```ts
const trigger = useMenu('activity')      // 绑定菜单 id，返回触发函数

return (
  <nav onContextMenu={(e) => { e.preventDefault(); trigger(e) }}>
    ...
  </nav>
)

ctx.menu('activity', [                    // 往这个 id 追加菜单项
  { id: '.reset', label: '重置', order: 10 },
  { id: '@separator' },
  { id: '.about', label: '关于', order: 20 },
])

ctx.action('.reset', {                    // 与菜单项用同一个相对 id，自动配对
  action: () => ctx.http.post('/api/theme/reset'),
})
```

菜单项的 `id` 有三种形态：

| 形态 | 完整 id | 说明 |
|---|---|---|
| `.reset` | `<plugin-id>/reset` | 相对 id，框架以插件 id 为前缀展开，跨插件天然不冲突 |
| `@separator` | 框架内置 | 框架提供的内置项（分隔线、标题等），只读 |
| `my-item` | `my-item` | 绝对 id，用于跨插件引用，需自行保证唯一 |

`ctx.action()` 应用同一套展开规则，因此菜单项写 `.reset`、行为也写 `.reset`，框架自动配对——插件作者不需要手写完整 id，也不需要感知前缀规则。

绝对 id 的唯一用途是**跨插件引用**：插件 A 可以给插件 B 的菜单项挂一个额外行为，或在它附近插入自己的项。这需要知道对方的完整 id，属于少数场景，因此不提供糖语法。

`@` 命名空间完全归框架所有，插件不能注册、覆盖或删除其中的项。理由是这些项（分隔线、分组标题）是布局骨架的一部分，允许改写会让内置菜单的结构变得不可预测。

右键菜单由 DOM 的 `contextmenu` 事件驱动，**完全是网页内行为**，不涉及系统原生菜单。

### 7.3 外壳能力不开放

原生菜单、系统托盘、窗口装饰、自动更新由外壳固定提供，插件无法访问。

**理由**：外壳是可选组件，一旦插件依赖外壳能力，浏览器模式就必须写条件分支，功能完整性被打破。唯一例外是一个范围极窄的外观接口：

```ts
ctx.appearance.setTheme('dark' | 'light')
ctx.appearance.setAccent('#4f7cff')
```

浏览器模式下这些调用被安全忽略——降级行为自然，不会造成功能缺失。

### 7.4 前端资源加载

worker 通过内置的 static 插件提供插件清单，前端启动时拉取一次：

```jsonc
{
  "plugins": {
    "theme-picker": {
      "files": ["/__plugins/theme-picker/client.js"],
      "data": { "accent": "#4f7cff" }
    }
  }
}
```

`data` 是插件服务端在加载时导出的初始状态，随清单一起送达——它让插件不必在前端挂载后再发一次请求去取「我是谁、我该显示什么」。

前端对每个 `files` 执行动态 `import()`，然后调用其默认导出：

```ts
const mod = await import(/* @vite-ignore */ url)
ctx.isolate('extension').plugin(mod.default, entry.data)
```

每个插件的前端代码跑在自己的隔离 scope 中，卸载时整块撤销。

**`files` 是数组而不是单一路径。** 插件前端可以代码分割——动态 `import()` 出来的 chunk 由浏览器自行请求，但需要在模块加载完成前就位。数组承载的是「入口 + 预加载清单」，让框架能在渲染入口之前把这些 URL 交给浏览器预取，避免挂载时白屏。

**路径统一前缀 `/__plugins/<plugin-id>/`。** 前缀同时服务于两件事：static 插件据此定位到 `node_modules` 中的实际文件，浏览器据此做缓存分区。卸载插件后该前缀返回 404，旧页面残留的请求不会打到别的插件上。

---

## 8. 配置系统

### 8.1 Schema

使用 **schemastery**（MIT）。

```ts
export const Config = Schema.object({
  accent: Schema.string().role('color').default('#4f7cff'),
  dark: Schema.boolean().default(false),
  storage: Schema.string().role('path'),
})
```

**为什么是 schemastery 而非 zod。** 设置面板需要自动生成，这要求 schema 能告诉渲染层「这个字符串是颜色、那个是文件路径」——`role()` 正是为此设计。zod 在类型推导上更强，但缺少 UI 元数据，最终会维护两套描述。附带好处：cordis 3.18.1 的配置校验本身基于 schemastery，插件作者只需学一套。

### 8.2 持久化

单一 `config.json`，位于实例根目录：

```jsonc
{
  "theme-picker": { "accent": "#ff6b6b", "dark": true },
  "logger": { "level": 3 },
  "file-upload": { "maxSize": 10485760 }
}
```

**为什么是单一文件而非一插件一文件。** 插件之间存在引用关系（例如上传插件指向某个存储插件的 id），放在一起可以肉眼对照；单个文件也便于整体导出、diff、迁移。文件大小在几十个插件的量级上不是问题——真正的复杂度来自插件间关系，而不是文件体积。

写入采用原子替换：

```
write config.json.tmp → rename → config.json
```

### 8.3 配置变更

```
用户修改 → schema 校验 → 写入 config.json
        → 目标插件 restart
```

**插件级 restart，不重启 worker。** cordis 的 `scope.update()` 默认会重启该插件的整个 effect 栈——这符合多数插件的直觉（配置变了就重新初始化），且代价远小于重启 worker。

保留 cordis 的 `accept()` 作为可选优化：愿意精细化的插件作者可以声明自己接受哪些字段的变化，此时只有变化的字段生效、不重启。框架不强制，也不为此增加新概念。

---

## 9. 安全模型

### 9.1 信任模型

**安装即信任。** 插件是任意 npm 包，运行在 Node 中，可以读写文件、启动子进程、发起网络请求。

能力在 `plugin.json` 的 `capabilities` 字段中声明，用于**安装界面展示**，运行时不做拦截。

**为什么不拦截。** monkey-patch `fs` / `child_process` / `net` 很容易被绕过——插件从任意入口 `require('node:fs')` 就能拿到真实模块；而 worker/isolated-vm 沙箱会让插件失去整个 Node 生态，等于放弃双端能力。诚实的做法是承认这一点，把选择权交给用户在安装时判断。

### 9.2 本地 HTTP 的访问边界

worker 监听 `127.0.0.1`，页面是普通 `http://127.0.0.1:<port>`。**用户浏览器里打开的任何网站都能向该端口发请求**——这是一个真实存在、且常被忽略的攻击面。

三重防护：

| 措施 | 防什么 |
|---|---|
| 监听 `127.0.0.1` | 局域网访问 |
| `Origin` 白名单 | 浏览器发起的跨站请求（只允许 `http://127.0.0.1:<port>` 与 `http://localhost:<port>`） |
| 会话 token | `Origin` 可被非浏览器客户端伪造，token 补上这一层 |

- token 由 supervisor 在启动时生成，经环境变量交给 worker，并通过握手告知外壳与 CLI
- API 请求校验 `Authorization` 头
- WebSocket 连接在 URL 中携带 token
- `/__health` 是唯一免 token 的端点，只回 200 与框架版本，不泄露任何状态

`Origin` 与 token 是**互补**关系：前者覆盖浏览器场景，后者覆盖脚本场景，缺一不可。

注意浏览器模式下访问 URL 形如 `http://127.0.0.1:<port>/#token=...`：token 在 fragment 中，不会进入服务端访问日志，也不会随 Referer 发往第三方站点。前端启动时读取它、存入 `sessionStorage`，然后从地址栏抹掉。

---

## 10. 目录布局

### 10.1 安装目录

```
<install-dir>/
├── cordis-app[.exe]        ← 外壳二进制，内嵌 UI 产物
├── bin/
│   ├── node[.exe]          ← Node 24 LTS
│   └── yarn.cjs            ← 包管理器 CLI
└── resources/
    ├── app.json            ← 初始应用定义
    └── ui/                 ← 外壳首次启动时释放，由 worker 静态分发
```

CLI 与外壳是两个独立产物：`cordis-app`（外壳）负责窗口与托盘，`cordis-app-cli` 负责 `new / add / run`。开发与服务器场景只需要后者，不必安装外壳；这种发行包里 `resources/ui/` 直接随包提供。

### 10.2 数据目录

```
<data-dir>/
├── runtime.json            ← supervisor 写入：port / token / pid
├── logs/
└── instances/
    └── default/
        ├── app.json          ← 用户编辑
        ├── app.lock          ← 解析结果
        ├── package.json      ← 从 app.json 派生
        ├── config.json       ← 插件配置
        └── node_modules/
```

---

## 11. 构建与分发

### 11.1 产物聚合

| 组件 | 位置 | 可变性 |
|---|---|---|
| 外壳二进制（含内嵌 UI） | 安装目录 | 发版才变 |
| 前端产物（React UI） | `resources/ui/`，由外壳释放 | 发版才变 |
| Node 运行时 | `bin/` | 发版才变 |
| 包管理器 | `bin/` | 发版才变 |
| 插件与 `node_modules` | 数据目录 | 用户可增删 |

**前端产物嵌入外壳二进制，运行时释放到 `resources/ui/`。** 嵌入保证「外壳 + UI」作为一个不可分割的版本单元分发，不会出现外壳升级了但 UI 还是旧的；释放到磁盘则是因为前端必须由 worker 的 static 插件提供——外壳不监听端口、不提供 HTTP，也无从代劳。

释放是幂等的：外壳启动时比对嵌入式 UI 的构建哈希与 `resources/ui/.version`，不一致才重写。正常情况下只有升级后的第一次启动会写盘。

**纯浏览器模式（不带外壳的发行包）** 不做嵌入，直接把同样的产物放在 `resources/ui/`。两条路径在 worker 看来完全一致，都是「从 `resources/ui/` 读静态文件」。

### 11.2 Node 运行时

**锁定 Node 24 LTS，构建时下载并随包分发。**

不以用户机器上的 Node 为准，理由：版本、架构、构建参数全部不可控，而插件安装要求 ABI 稳定。选择 24 LTS 而非更旧版本，是因为 `require(esm)` 的原生支持能显著减少「纯 ESM 插件加载失败」这类兼容问题。

安装包因此增加约 30~40MB，对桌面应用可接受。

### 11.3 目标平台

| 平台 | 架构 | 优先级 |
|---|---|---|
| Windows | x64 | v1 |
| macOS | arm64 | v1 |
| macOS | x64 | v1 |
| Linux | x64 | v1 |

构建脚本按矩阵驱动，增加产物只需增加一行配置。

### 11.4 构建流水线

一条脚本链驱动全部产物，**本地与 CI 使用同一套脚本**：

```
① 下载 Node 与 Yarn 到构建缓存
② 构建前端（Vite）→ 产物用于嵌入外壳
③ 编译内置插件（esbuild）
④ go build（各平台外壳，`//go:embed` 前端产物）
⑤ 打包（MSI / DMG / AppImage / tar.gz）
```

本地可复现 CI 产物的价值在于：出问题时不必猜测「是不是 CI 环境差异」。

### 11.5 开发模式

| 层 | 机制 |
|---|---|
| 前端 | Vite dev server + HMR，窗口不闪 |
| 后端 | chokidar 监听插件目录 → 触发 worker 重启 |
| 配置 | 插件级 restart |

开发模式下前端由 Vite 提供，生产模式下由 static 插件提供——这两条路径在架构中本来就存在，不需要为开发模式额外设计机制。

### 11.6 运行时环境隔离

子进程的环境变量由框架显式构造，不继承用户的 shell。

| 变量 | 处理 |
|---|---|
| `PATH` | 只保留 `bin/`（Linux/macOS）或让 `bin/` 前置（Windows）。确保解析到的 `node`、`yarn` 是随包分发的那一份 |
| `HOME` / `APPDATA` / `XDG_*` | 重定向到数据目录，避免插件把状态写进用户主目录 |
| `NODE_OPTIONS` / `NODE_PATH` | 清空。用户 shell 里残留的调试或注入配置会污染 worker |
| `TMPDIR` | 指向数据目录下的临时目录，便于统一清理 |

`PATH` 只保留 `bin/` 的副作用是：插件调用 `git`、`ffmpeg` 这类外部命令会失败。这是刻意的——让「依赖系统已安装的工具」在开发期就暴露，而不是在另一台机器上才崩。需要外部命令的插件必须自行检测并提示用户。

**Windows 上 `PATH` 不能只留 `bin/`。** 系统 DLL 的查找依赖 `System32` 等目录，清空会导致 Node 甚至外壳自身启动失败。因此 Windows 采用「前置 `bin/`、保留系统目录」的策略，Linux/macOS 采用「只留 `bin/`」。这个差异是平台事实，不是设计取舍。

Koishi Desktop 在这里还保留了一组 `KOI_HOST_*` 变量用于回传给外壳的信息，本框架用握手通道代替，不需要环境变量这一层。

---

## 12. 工程结构

```
packages/
├── kernel/      cordis 适配层 + Kernel 接口（唯一依赖 cordis 的包）
├── runtime/     宿主进程：模块加载、插件安装、HTTP、握手
├── ui/          React：布局、五个扩展点、设置面板
├── preset/      插件打包预设（esbuild 配置 + external 白名单）
├── cli/         命令行：new / add / remove / run / restart
└── shell/       Go 外壳（窗口、托盘、更新、单实例锁），vendor 自 koi
```

**划分依据。**

- `kernel` 独立，使 cordis 的依赖被限制在一个包内。
- `preset` 必须独立发布——插件作者把它作为 devDependency 引入，不能要求他们依赖整个 runtime。
- `ui` 与 `runtime` 分属浏览器与 Node 两个运行时，合并会导致构建产物中大量死代码。

---

## 13. 许可与来源

- **全仓 AGPL-3.0**。
- 从 Koishi Desktop 复制的代码以 **vendor 方式内联**到本仓库（而非作为依赖引用），保留原始版权头，并在 `NOTICE` 中逐项列出。
- **插件作者使用框架 API 不构成衍生作品**——这一点必须在 README 中明确，否则会阻断插件生态。

---

## 14. v1 范围与验收

### 14.1 交付顺序

范围是完整功能，但实现分两段——**先验证核心假设，再叠加外围能力**。

**第一段：端到端闭环**

- 外壳（Windows x64 + macOS arm64）
- supervisor + worker 的进程模型
- 内核、内置插件、React UI 骨架
- 五个 UI 扩展点
- 安装一个插件 → 前端出现入口 → 卸载后干净消失
- 退出码 75 的重启链路，窗口不闪

**第二段：完整能力**

- 托盘、自动更新、单实例锁
- 开发模式（Vite HMR + 后端监听）
- Linux x64 与 macOS x64 产物
- 浏览器模式的完整验证

**顺序不能调换的理由**：第一段验证的是「装完插件不重启整个应用」——这条链路决定进程模型、握手协议、目录结构三件事，任何一项改动都会波及全局。托盘与更新是纯加层，随时可补，且对架构没有验证价值。

### 14.2 验收标准

1. 一个新插件从 `cordis-app new` 到出现在 UI 中，**不超过 5 分钟**
2. 安装一个插件后，**窗口不闪、登录态不丢**
3. 关掉外壳，直接用浏览器访问，**功能完整**，只缺少外壳相关能力

---

## 15. 已知代价

| 代价 | 来源 | 缓解 |
|---|---|---|
| 多一个 Node 进程 | supervisor + worker | supervisor 严格保持 100 行以内 |
| 安装包增大 30~40MB | 内置 Node | 接受 |
| 前端技术栈锁定 React | 框架自带完整 UI | 通过 preset 统一插件构建配置 |
| 插件作者需学习两套 API | 命令式 + Hooks | 用明确的使用边界约束 |
| 接入已有 Web 应用需改写 | 框架接管 HTTP 与路由 | 明确这是设计前提，不是缺陷 |
| AGPL 限制商业闭源 | 许可证选择 | 框架层开源，插件层不受影响 |
| 无多实例能力 | 单实例前提 | 目录结构预留，抽象不预留 |
| 跨大版本 peer 冲突无法共存 | React 单例约束 | 安装阶段硬失败并说明原因 |
| 插件无法调用系统命令 | `PATH` 只保留 `bin/` | 刻意为之，插件需自行检测并提供提示 |
