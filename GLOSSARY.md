# 术语表

本文件是 cordis-app 领域语言的唯一出处。写代码、测试、文档、提交信息时优先使用
这里的词；需要引入新术语时先更新本文件。

## 项目与应用

**项目（项目根）**
一个普通目录，包含 `package.json`、`app.json`、`src/`、`server/`、`plugins/`、
`data/`、`.cordis/` 与 `dist/`。项目是唯一的应用形态，没有平台级「实例」概念。

**`package.json`**
项目依赖的唯一真源：`cordis-app`、React、插件包都写在这里。`add`/`remove` 通过
项目包管理器更新它和 lockfile。

**`app.json`**
应用身份与启用清单：`name`、`version`、`icon`、`plugins`（插件 **id** 的启用
顺序）、`ui`（body 提供的 UI 能力）。不保存框架版本范围，也不保存插件版本。

**启用顺序**
`app.json.plugins` 的数组顺序。缺省或空数组表示「发现即启用」；未列出的已发现
插件仍然启用，只是排在已列出的之后。

**body**
项目的前端布局入口 `<project>/src/body.tsx`，默认导出 React 组件。body 决定
布局与导航，框架只固定宿主职责和 UI 出口。

**项目 server 入口**
`<project>/server/index.js`，ESM，默认导出 `apply(ctx)`。它不是插件，不参与
安装/卸载，路由先于应用插件注册。

## 插件

**插件（插件包）**
同时可能贡献服务端路由与前端界面的可安装单元。身份由 `plugin.json` 决定，依赖
由它自己的 `package.json` 决定。

**`plugin.json`**
插件身份清单：`id`、`displayName`、`version`、`server`/`client` 入口、`ui`
需求、`capabilities` 安全能力。

**插件 id**
`plugin.json.id`，必须是 URL 安全段。它是挂载键（`/__plugins/<id>/…`）与
`app.json.plugins` 的键，不是 npm 包名。

**插件根**
发现插件的目录，每个根只扫一层。按优先级从高到低：内置（`resources/plugins`）、
项目本地（`<project>/plugins`）、项目依赖（`<project>/node_modules`）、用户
（`<userData>/plugins`）。重复 id 保留高优先级插件。

**插件入口**
服务端入口导出 `name` / `inject` / `apply`，可选导出 `data`；前端入口默认导出
`activate(ctx)`。入口路径由 `plugin.json` 的 `server`/`client` 指向。

**共享模块**
由框架提供给所有插件与宿主、必须只有一份实例的模块：`react`、`react-dom`、
`react-dom/client`、`react/jsx-runtime`、`cordis-app/client`。插件构建时保持
external。

**宿主出口**
body 暴露给插件的 UI 扩展点：pages（`PluginPageOutlet`）、slots
（`PluginSlot`）、menus（`PluginMenuTrigger`）、settings（`SettingsPanel`）。

**UI 能力（`UiCapabilities`）**
`{ pages: boolean; slots: string[]; menus: string[]; settings: boolean }`。在
`app.json.ui` 中表示 body **提供**什么；在 `plugin.json.ui` 中表示插件
**需要**什么（`PluginUiRequirements`，同一形状的 partial）。

**`uiCompatibility`**
安装插件时需求与 body 能力的匹配结果：`full`、`backend-only` 或
`incompatible`。不匹配只告警，不阻断服务端安装。

**`uiContractVersion`**
前端清单里的宿主契约版本，当前为 `1`。插件/市场据此判断 body 契约是否兼容。

## 安装与分发

**安装来源（`InstallSource`）**
决定一次安装/卸载在磁盘上做什么。`npm` 源用于项目模式；`bundle` 源用于打包
模式，只接受签名插件包。

**安装事务（`PluginInstaller`）**
所有来源共用的可靠性层：开始前快照事实文件并写事务日志，失败或进程死亡后回滚。
项目模式快照 `package.json`、项目 lockfile、`app.json`；打包模式快照
`installed.json` 并由来源撤销目录移动。

**事务日志（`install-journal.json`）**
`<project>/.cordis/install-journal.json`，打包模式写在
`<userData>/.cordis/install-journal.json`。来源动手前落盘，记录来源、动作、
规格、事实文件原文与来源自己的事务前状态；回滚成功后删除。进程被强杀后，
下一次启动据此恢复。

**启动 doctor**
worker 启动前的兼容性检查：项目 `package.json` 声明的 `cordis-app` 版本必须与
当前框架兼容（缺失只告警，不兼容是硬错误），插件还要校验 `cordis-app` 与共享
模块的 peer 范围。检查在监听端口之前完成，避免留下半启动的 worker。

**插件包（`.cordis-plugin`）**
tar.gz 归档，包含 `plugin.json`、`package.json`、server/client 产物与
`bundle.json`。内容 hash 排除 `bundle.json` 自身；签名为 Ed25519，覆盖
id、版本与 hash。

**`installed.json`**
打包模式的安装事实，写在 `<userData>/installed.json`。记录每个插件的版本、
目录名、内容 hash 与安装时间。

**只读安装目录**
安装完成后不再被修改的代码与依赖目录（例如 `<userData>/plugins/<id>@<version>/`、
`resources/`）。

**用户数据**
运行时可写的数据根：项目模式是 `<project>/data`（配置为 `data/config.json`），
打包模式是 `<userData>`。

**`runtime.json`**
`<project>/.cordis/runtime.json`，supervisor 写入的运行中快照，供 `restart` 定位
实例。

## 进程

**外壳（Go shell）**
可选的桌面进程：窗口、单实例锁、进程树回收、内嵌 UI 释放。

**supervisor**
Node 进程：找空闲端口、生成 token、fork worker、转发日志。worker 以退出码 75
退出时原地重启，端口与 token 不变。

**worker**
Node 进程：内核、内置插件、项目 server 入口、应用插件与前端清单。通过 IPC
报告就绪。

**握手行**
supervisor stdout 上唯一的字符串契约：
`@@CORDIS_APP@@{"ready":true,"port":…,"token":…,"version":…,"failures":[]}`。

## 已废弃的说法

以下词来自旧模型，文档与代码中不应再出现（除非明确讨论历史）：

- **实例 / `instances/default`**：应用不再有平台级实例目录，一切基于项目根。
- **公共 `app.lock`**：已删除。版本与完整性属于项目 lockfile 或
  `installed.json`。
- **全局数据目录**：项目模式的数据在 `<project>/data`；只有打包模式才有
  `<userData>`。
- **`--data` 作为「数据目录」**：它只是 `--project` 的兼容别名，含义是项目根。
