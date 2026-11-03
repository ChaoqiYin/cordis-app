# 术语表

本文件是 cordis-app 领域语言的唯一出处。写代码、测试、文档、提交信息时优先使用
这里的词；需要引入新术语时先更新本文件。

## 项目与应用

**项目（项目根）**
一个普通目录，包含 `package.json`、`app.json`、`src/`、`server/`、`plugins/`、
`data/`、`.cordis/` 与 `dist/`。项目是唯一的应用形态，没有平台级「实例」概念。

**运行形态（`RuntimeMode`）**
`project` 或 `packaged`，由 supervisor 参数与 `CORDIS_APP_MODE` 环境变量传到
worker。它决定安装来源与插件根的扫描范围，是进程配置，HTTP 请求不能切换。

**项目模式**
缺省运行形态。项目根是事实源，安装走 npm，插件可来自项目本地根与项目依赖根。

**打包模式**
面向分发布局的运行形态：CLI 从 `dist/` 产物运行，桌面外壳从释放目录运行；
清单是构建产物里的 `app.json`，只接受签名插件包；不扫描 `<project>/plugins`
与 `<project>/node_modules`，除非显式传入本地插件根。

**用户插件根（`userPluginsDir`）**
可写的插件安装目录。`start` 使用 `<project>/data/plugins`；桌面外壳传入
`<桌面数据目录>/plugins`。worker 以它的父目录作为用户数据根，
`installed.json`、安装事务日志与插件目录都在那里。

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
（`<桌面数据目录>/plugins`）。重复 id 保留高优先级插件。项目模式四个根都参与；打包
模式只扫内置与用户（显式传入的本地根仍生效），不扫项目依赖。

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

**插件来源模块（`app.json.pluginSource`）**
项目声明的、替代 bundle 来源默认读取逻辑的模块。导出
`readArchive(spec, ctx)`，返回归档字节；只在打包形态加载。它是项目代码，与
项目 server 入口同等可信，必须自行限制允许的 `spec`。`build` 把它打进
`dist/server/plugin-source.js`，并改写产物清单指向同一路径。

**安装事务（`PluginInstaller`）**
所有来源共用的可靠性层：开始前快照事实文件并写事务日志，失败或进程死亡后回滚。
项目模式快照 `package.json`、项目 lockfile、`app.json`；打包模式快照
`installed.json` 并由来源撤销目录移动。

**事务日志（`install-journal.json`）**
`<project>/.cordis/install-journal.json`，打包模式写在
`<桌面数据目录>/.cordis/install-journal.json`。来源动手前落盘，记录来源、动作、
规格、事实文件原文与来源自己的事务前状态；回滚成功后删除。进程被强杀后，
下一次启动据此恢复。

**启动 doctor**
worker 启动前的兼容性检查：项目 `package.json` 声明的 `cordis-app` 版本必须与
当前框架兼容（缺失只告警，不兼容是硬错误），插件还要校验 `cordis-app` 与共享
模块的 peer 范围。检查在监听端口之前完成，避免留下半启动的 worker。项目侧检查
只在项目模式执行；打包形态没有 npm 安装，依赖由构建期保证自包含。

**插件包（`.cordis-plugin`）**
tar.gz 归档，包含 `plugin.json`、`package.json`、server/client 产物与
`bundle.json`。第三方依赖已在构建期进入产物，归档不包含 `node_modules`。
`package.json` 只保留元数据与 `peerDependencies`（框架契约）；`dependencies`
只是开发/构建期的解析输入，运行时不安装。内容 hash 排除 `bundle.json` 自身；
签名为 Ed25519，覆盖 id、版本与 hash。

**自包含**
模块产物在运行时不依赖项目或插件目录下的 `node_modules`；它需要的非框架
代码已经随产物提供。第三方依赖由模块作者负责，框架只提供构建机制，不替
模块安装。

**框架提供依赖**
由宿主而不是模块产物提供的依赖。服务端是 Node 内置模块（`node:*`）与
`cordis-app` 的类型面；客户端是共享模块（React、`cordis-app/client`）。
这些在构建时保持 external，不进入模块产物。`@cordis-app/*` 是框架内部包，
不属于公开的框架提供依赖。

**`installed.json`**
打包模式的安装事实，写在 `<桌面数据目录>/installed.json`。记录每个插件的版本、
目录名、内容 hash 与安装时间。

**桌面安装目录**
`package:desktop` 的 `--out` 目录，也只读安装根：包含 `cordis-app[.exe]` 与
`bin/{node, cordis-app-supervisor.mjs, cordis-app-worker.mjs}`。外壳以「安装目录
下存在 `bin/node`」判定打包形态；运行期从不写入这里。

**桌面数据目录**
打包应用的可写用户数据根。默认按平台：macOS
`~/Library/Application Support/cordis-app`、Windows `%APPDATA%\cordis-app`、
Linux `${XDG_DATA_HOME:-~/.local/share}/cordis-app`；可用外壳的 `--data` 或
`CORDIS_APP_DATA` 覆盖，`--data` 优先。包含释放目录、用户插件根、`installed.json`、`.cordis/`、
`data/` 与单实例锁 `shell.lock`。

**释放目录**
`<桌面数据目录>/app/<hash>/`。打包时内嵌的应用产物在首次启动后释放到这里；
目录名是「路径 + 内容」的哈希。相同内容再次启动直接复用，不重复写盘；内容变化
生成新目录，并在取得单实例锁后清理旧目录。释放先写 `.tmp-*` 再原子改名，失败
不会留下半成品。

**只读安装目录**
运行期不再被写入的代码与依赖目录。桌面形态就是「桌面安装目录」；项目模式指
构建后不再修改的依赖目录。用户安装的插件目录
（`<桌面数据目录>/plugins/<id>@<version>/`）在安装完成后也不修改，但它位于可写
数据根内，不是安装目录。

**用户数据**
运行时可写的数据根：项目模式是 `<project>/data`（配置为 `data/config.json`），
打包模式是桌面数据目录。

**`runtime.json`**
`<project>/.cordis/runtime.json`，supervisor 写入的运行中快照，供 `restart` 定位
实例。打包模式下「项目根」是桌面数据目录，因此文件位于
`<桌面数据目录>/.cordis/runtime.json`。

**`--data` 与 `--project`**
CLI 的 `--data` 是 `--project` 的兼容别名，二者都指项目根。Go 外壳的 `--data`
指「桌面数据目录」，不是项目源码根；外壳交给 supervisor 时一律用 `--project`。
打包模式下 supervisor 的「项目根」就是桌面数据目录——运行时事实、`.cordis/`
与 `data/` 都在那里；项目模式下才是源码项目根。两种同名参数不能混用。

## 原生能力

**原生能力（native）**
只有桌面外壳能提供的系统原语：路径选择、窗口控制、系统通知等。由外壳实现，经
回环 HTTP 暴露给 worker；项目和插件只通过 `ctx.native` 调用，页面不直连外壳。
命令表与权限模型见 ADR 0003。

**`ctx.native`**
worker 侧原生能力的唯一入口。浏览器模式或没有外壳时 `available` 为 false，调用
返回 `unsupported`。项目 server 与 body 同等可信，默认拥有全部命令；插件按
`plugin.json.capabilities` 中的 `native:<命令>` 受限，运行时强制。

**原子命令**
原生命令的命名形式 `资源.动作`，一个命令对应一个系统原语。不出现 dialog、panel
等 UI 控件形态，也不提供「导入 CSV」这类场景命令；复合流程由调用方组合。

**原生 token**
外壳为回环原生服务生成的随机凭据，只经 `CORDIS_APP_NATIVE_URL` /
`CORDIS_APP_NATIVE_TOKEN` 传给 worker，worker 启动后从 `process.env` 删除。它与
页面使用的 auth token 分离，页面永远拿不到。

**原生能力契约版本（`NATIVE_CONTRACT_VERSION`）**
worker 与外壳之间的原生命令契约版本，当前为 `1`。外壳通过 `/info` 的
`contractVersion` 字段报告；不匹配时 worker 关闭原生能力并告警，不阻止应用启动。

## Node 版本契约

**Node 版本契约**
最低运行版本、构建目标、随包 Node 与开发版本之间的版本一致性规则；当前最低
运行版本为 Node.js 24。

**最低运行版本**
框架承诺支持的最旧 Node.js 版本。当前为 Node.js 24（最低 24.0.0）。开发环境、CLI、
服务端产物与桌面随包 Node 都不得低于它；构建目标不得高于它。

**构建目标**
构建器生成代码时假设的最低 Node.js 语法能力。构建目标不得高于最低运行版本，
否则产物可能在受支持的 Node 上无法加载。

**随包 Node**
桌面安装目录中随应用分发的 Node.js 运行时。它的版本不得低于最低运行版本；
最终用户不需要另外安装 Node.js。

**开发版本**
仓库构建与测试使用的 Node.js 版本。它不得低于最低运行版本。

## 进程

**外壳（Go shell）**
可选的桌面进程：窗口、单实例锁、进程树回收、内嵌 UI 释放，以及原生能力服务
（见「原生能力」）。

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
- **全局数据目录**：项目模式的数据在 `<project>/data`；只有打包模式才有桌面
  数据目录。
- **把外壳的 `--data` 当成项目源码根**：已废弃。外壳的 `--data` 是桌面数据
  目录，交给 supervisor 时叫 `--project`；CLI 的同名参数才是项目根的兼容
  别名（见「`--data` 与 `--project`」）。
- **可写安装目录**：桌面安装目录在运行期只读，应用产物释放到桌面数据目录后
  才写入。
- **distribution 预设 / 把服务端依赖留给 Node 解析**：已废弃。服务端产物一律
  在构建期自包含；不存在第二个 distribution 模式。
