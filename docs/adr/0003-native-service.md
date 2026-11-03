# ADR 0003：原生能力由 worker 统一提供

## Status

已采纳（2026-11-03）。

## Context

项目与插件需要少量只有桌面外壳能提供的系统能力：原生路径选择、窗口控制、
系统通知等。当前架构有两处结构性障碍：

1. **外壳被刻意压到最小。** `packages/shell/main.go` 的原则是「不解析配置、不加载
   插件、不代理 HTTP、不在页面与后端之间传话」；`window.go` 也明确「外壳不做任何
   导航拦截或注入」。外壳与 Node 之间只有 fork、stdout 握手行和进程树回收，没有
   页面→外壳或 Node→外壳的通道。
2. **前端是普通网页。** 项目页面与插件页面都跑在 WebView 里，没有文件系统或原生
   API；项目后端 `server/index.js` 与插件服务端运行在 worker（Node）里，拥有完整
   Node 权限，但拿不到窗口、系统对话框等外壳能力。

不统一处理时，作者只能二选一：在 Node 侧用 `child_process` 调平台命令（打包形态
的 PATH 被裁剪到 `bin/`，外部工具必须写绝对路径，且每个平台各写一套），或者在框架
里给页面加 WebView Bind（浏览器模式没有对应实现，前端分叉，权限无法归属插件）。

本 ADR 给项目与插件一套**统一、可信、跨平台**的原生能力接口，同时不破坏「桌面模式
只是浏览器模式加壳」的既有原则。

## Decision

原生能力的唯一入口是 worker 的 **`ctx.native`**。Go 外壳只提供系统原语实现，不接触
页面；页面继续只通过 HTTP 调用 worker。

```
项目页面 / 插件页面（普通网页）
        │  HTTP + 现有 auth token
        ▼
worker（Node）—— ctx.native、权限、审计
        │  回环 HTTP + 独立 native token
        ▼
Go 外壳 native server（平台原语实现）
        ▼
操作系统
```

### 传输

- 外壳在启动 supervisor 之前监听 `127.0.0.1:0`（随机端口），生成 32 字节随机 token，
  只接受回环连接。`--url` 降级模式同样启动，只是没有窗口。
- 端点与 token 经环境变量传给 supervisor，再由 `buildWorkerEnv` 显式转发给 worker：
  `CORDIS_APP_NATIVE_URL`、`CORDIS_APP_NATIVE_TOKEN`。它们和现有的
  `CORDIS_APP_*` 一样，**先过滤外层注入的同名变量再显式写入**，防止用户 shell 劫持。
- worker 启动时读取这两个变量，创建 client 后**立即从 `process.env` 删除**；client
  只挂在 `ctx.native` 上。worker 重启后由 supervisor 重新注入。
- 页面永远拿不到这两个值。页面使用现有 auth token 调用 worker 自己的路由，再由
  worker 调用原生层。
- supervisor 不参与原生 RPC，职责不变。

### 协议

`POST /invoke`，`Authorization: Bearer <native-token>`，JSON 请求体：

```json
{ "command": "path.chooseOpen", "input": { "multiple": true } }
```

HTTP 200 + 统一 envelope：

```json
{ "ok": true, "value": { "paths": ["/Users/…/a.csv"] } }
{ "ok": false, "code": "cancelled" }
{ "ok": false, "code": "unsupported", "platform": "linux", "message": "未找到 zenity/kdialog" }
```

`GET /info` 返回：

```json
{ "contractVersion": 1, "platform": "darwin", "arch": "arm64", "hasWindow": true, "commands": ["path.chooseOpen", "…"] }
```

`/info` 只在 worker 启动时读取一次并缓存，供 `ctx.native.available` 与
`ctx.native.commands()` 使用；业务代码查询系统状态用 `system.info`。

- 错误码固定为 `cancelled`、`unsupported`、`denied`、`busy`、`invalid`、`timeout`、
  `internal`。HTTP 4xx/5xx 只表示 transport 或鉴权失败，业务结果一律在 envelope 里。
- `nativeContractVersion` 当前为 **1**。worker 启动时校验；不匹配时
  `ctx.native.available = false` 并告警，不阻止应用启动。
- 同一时刻只允许一个 `path.choose*`，第二个返回 `busy`；窗口命令串行执行。
- 交互类命令（`path.choose*`）不设 RPC 超时；其余默认 5 秒。

### 命令表（v1）

命令名是「系统资源.动作」，**不出现 UI 控件形态**；一个命令对应一个系统原语，复合
流程由调用方组合。

| 命令 | 输入 | 成功返回 |
| --- | --- | --- |
| `path.chooseOpen` | `{ multiple?, filters?, title?, defaultPath? }` | `{ paths: string[] }` |
| `path.chooseDirectory` | `{ multiple?, title?, defaultPath? }` | `{ paths: string[] }` |
| `path.chooseSave` | `{ filters?, defaultName?, title?, defaultPath? }` | `{ path: string }` |
| `window.setTitle` | `{ title }` | `{}` |
| `window.setSize` | `{ width, height }` | `{}` |
| `window.minimize` | `{}` | `{}` |
| `window.maximize` | `{}` | `{}` |
| `window.restore` | `{}` | `{}` |
| `window.focus` | `{}` | `{}` |
| `window.close` | `{}` | `{}` |
| `window.state` | `{}` | `{ maximized, minimized, focused, size }` |
| `notification.show` | `{ title, body }` | `{}` |
| `shell.openExternal` | `{ url }` | `{}` |
| `shell.showItemInFolder` | `{ path }` | `{}` |
| `system.info` | `{}` | `{ platform, arch, release, theme, hasWindow }` |

明确不提供：

- `alert.show`：页面自己就能渲染确认框，原生模态只在必须压过页面时才需要。
- 剪贴板：WebView 页面可以直接使用浏览器的 `navigator.clipboard`，不需要占用原生命令。
- 任意 shell 执行、文件内容读写：Node 自己就能做，放进原生层只扩大攻击面。
- 托盘、全局快捷键、主题/通知点击/窗口状态事件：留给 v2，v1 用 `system.info` 与
  `window.state` 轮询。

### 权限

- 权限字符串与命令一一对应：`native:path.chooseOpen`、`native:window.state`。
- `native:window.*` 这类通配只作书写便利，运行时展开成具体命令；审计日志记录的
  永远是展开后的命令名。
- 项目 server 与 body 同等可信，默认拥有全部命令。
- 插件按 `plugin.json.capabilities` 限制；worker 在插件 fork 出的 ctx 上挂受限视图，
  调用时再校验一次。`denied` 不终结插件，只让这次调用失败。
- 打包模式下 `plugin.json` 的内容 hash 与签名覆盖 `capabilities`，篡改会导致安装失败。
- 敏感原语单独授权：`window.close`、`shell.openExternal`、`path.chooseSave`。
- Linux 能力不足时 `commands` 如实返回，不假装支持。

### 平台实现

- 命令注册表与分发放在 `packages/shell/native/`，平台实现按文件拆分；未实现返回
  `unsupported`。
- 窗口命令经 `w.Dispatch` 投递到 UI 线程，`w.Run()` 占着的主线程不得被阻塞。
- `webview_go` 只提供 `SetTitle` / `SetSize`；窗口状态读取与最小化、最大化、恢复、
  关闭都要经 `w.Window()` 在平台文件里原生实现，参照现有的 `focus_*.go`。这是
  v1 已接受的实现成本。
- 外部工具一律使用绝对路径（打包形态 PATH 只有 `bin/`）。
- v1 允许用系统自带工具实现（macOS `/usr/bin/osascript`、Linux zenity/kdialog），
  命令契约不变；后续换成原生绑定不需要改 API。
- Linux 的通知依赖桌面环境工具，探测不到时该命令从 `commands` 中消失。

### 降级

- `ctx.native.available` 为 false（浏览器模式、`cordis-app run`、契约版本不匹配）时，
  所有调用返回 `unsupported`。
- `--url` 模式没有窗口，`window.*` 返回 `unsupported`；`hasWindow` 供调用方提前判断。
- 前端不从 manifest 读取原生能力。项目或插件若需要据能力调整 UI，由自己的服务端
  路由返回。

### 可信边界

这套机制防的是**页面越权**与**插件误用**，不是**恶意插件**。插件代码与项目 server
运行在同一个 worker 进程里，能直接 `require('node:fs')`，也能在 worker 删除 token
之前抢读 `process.env`。真正的恶意插件隔离需要独立进程或 VM，不在本 ADR 范围内。

## Alternatives

**WebView Bind（页面直连 Go）。** 少一次中转，但违背外壳「不在页面与后端之间传话」
的定位；浏览器模式没有对应实现，前端必须分叉；Go 无法知道调用方是哪个插件，权限无法
归属；页面导航到外部地址后桥仍然存在。否决。

**stdio JSON-RPC（外壳 stdin/stdout）。** 不新增监听面，但要同时改外壳、supervisor
和 worker，把 supervisor 从「转发日志」变成「协议中转」；stdout 已被握手行与日志契约
占用，二进制要走 base64；worker 重启时在途请求全部丢失。可信度更高，但职责扩张与
调试成本不划算。否决为 v1 传输，保留为未来替换项。

**Unix domain socket / Windows named pipe。** 可信度最高，但 Windows 需要额外依赖，
两个平台实现分叉。`ctx.native` 之下的 transport 已做抽象，将来可替换，不影响本 ADR
的 API。暂不采用。

**维持 Node 侧 `child_process`。** 不需要框架改动，但打包形态 PATH 被裁剪到 `bin/`，
必须硬编码绝对路径；每个项目各写一套平台分支；能力无法声明、审计或授权。作为临时
方案可行，不能作为公开 API。否决。

## Consequences

正面：

- 项目与插件只依赖 `ctx.native`，浏览器模式自动降级，前端不分叉。
- supervisor 与现有 HTTP auth 模型不变，改动集中在 worker 与外壳。
- 命令、权限、错误码都可枚举，审计与安装期检查有稳定标识。
- 传输可替换，命令契约不随平台实现变化。

代价：

- 新增一个回环监听面与第二把 token，需要处理端口冲突与 worker 重连。
- Go 侧要维护三个平台的实现矩阵；窗口状态与窗口操作需要按平台写原生代码；Linux
  的对话框与通知依赖桌面环境工具，能力不齐。
- 同进程不是安全沙箱，第三方插件仍可绕过 `ctx.native`。
- 命令表是公开契约，新增或修改需要走 ADR 或提升 `nativeContractVersion`。
- v1 没有事件通道，主题变化、窗口状态变化只能轮询。

## 实施顺序

1. `protocol` 定义命令表、输入输出、错误码与 `nativeContractVersion`；扩展
   `PluginCapability` 的 `native:` 前缀。
2. 外壳新增 native server 与最小三条命令（`path.chooseOpen`、`window.setTitle`、
   `system.info`），建立 env 注入与回环鉴权。
3. worker 新增 native client，创建 `ctx.native`，在插件 ctx 上挂受限视图。
4. 接入权限校验与审计日志；补浏览器模式与 `--url` 模式的降级测试。
5. 补齐其余命令与平台实现，完成打包形态实测。

同步更新 `GLOSSARY.md`（原生能力、`ctx.native`、原生 token、原子命令）、README 的
架构图与 `packages/protocol` 的类型。
