# cordis-app

插件化 Web 应用的可复用基础设施：一个项目根、一套 Node 宿主、一套 React 界面，
以及「安装/卸载插件时窗口不闪、页面自动重连」的完整链路。

cordis-app 只支持**项目模式**：应用就是一个普通目录，`package.json` 是依赖的唯一
真源，`app.json` 记录应用身份、启用的插件与 body 提供的 UI 能力。不再有
`instances/default`、平台级数据目录或公共 `app.lock`。

> **发布状态**：项目尚未发布到 npm，也暂时没有 release 流程。使用方项目请通过
> 本地 `file:` 路径依赖接入，见[在另一个项目中使用](#在另一个项目中使用本地联调)。

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

环境要求：Node.js ≥ 24、pnpm 10。构建 Go 外壳还需要 Go 1.25。

下面的命令都在本仓库根执行，用于仓库内演示；在另一个项目中使用见
[本地联调](#在另一个项目中使用本地联调)。

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
│   └── plugins/     本地插件与 node_modules 中插件的前端/服务端产物
└── server/index.js  项目后端产物
```

`start` 从 `dist/` 读取 `app.json`、前端产物与 server 入口；可写的 `data/` 与
运行时 `.cordis/` 仍按项目根定位。源码根没有 `app.json` 不影响 `start`。

`build` 会扫描两个插件根：项目的 `plugins/`，以及项目 `node_modules/` 中带
`plugin.json` 的包（包括 `@scope/name` 与 npm 的 `file:` 符号链接）。两处都用同一
套预设重建入口，因此 `add` 安装的 npm 插件同样会进入 `dist/resources/plugins/`。
同一个 id 同时出现在两处时保留本地插件；依赖根中 id 重复，或清单声明的入口
缺失时构建硬失败，不会留下半新半旧的 `dist/`。

## 在另一个项目中使用（本地联调）

项目尚未发布到 npm。使用方项目不要依赖 npm registry 上的 `cordis-app`，而是把
依赖指向本仓库的聚合包：

```bash
# 源仓库：先安装并构建
cd /path/to/cordis-app
pnpm install
pnpm build

# 使用方项目
cd /path/to/your-app
npm install /path/to/cordis-app/packages/cordis-app
```

npm 会在使用方的 `node_modules/cordis-app` 创建 symlink，指向本仓库的
`packages/cordis-app`；`package.json` 记录为 `file:` 依赖。源仓库必须先完成
`pnpm install`，`cordis-app` 依赖的 `@cordis-app/*` 才能从源仓库的
`node_modules` 解析。使用方同样需要 Node.js ≥ 24。

修改源码后，只需在源仓库重新执行 `pnpm build`，使用方不需要重新安装：

```bash
npx cordis-app build
npx cordis-app start
```

如果使用方是 pnpm 项目，可以用
`pnpm add link:/path/to/cordis-app/packages/cordis-app`。这是临时联调方式，
不是发布形态；release 流程补齐后再改为版本依赖。

## 桌面打包

仓库提供一条本机打包命令，把项目的 `dist/` 连同 Node 运行时、supervisor 与
worker 装进一个可直接运行的桌面安装目录。前置条件是仓库已执行
`pnpm install && pnpm build`，且项目已执行 `cordis-app build`。

打包环境必须使用 Node.js ≥ 24；安装包随包提供打包者当前的 Node 运行时，最终用户
不需要另外安装 Node。完整的版本一致性规则见
[ADR 0002](./docs/adr/0002-node-version-contract.md)。

下面的 `cordis-app` 指仓库里的 CLI；没有全局安装时等价地使用
`node packages/cli/lib/cli.js`。

完整链路（命令都在仓库根执行）：

```bash
# 1. 新建并构建项目
cordis-app new demo --project /tmp/cordis-demo
cordis-app build --project /tmp/cordis-demo

# 2. 产出桌面安装目录（只构建宿主平台）
pnpm package:desktop --project /tmp/cordis-demo --out /tmp/cordis-demo-install

# 3. 启动：默认打开桌面窗口
/tmp/cordis-demo-install/cordis-app

#    只打印访问地址并交给系统浏览器，适合脚本验收
/tmp/cordis-demo-install/cordis-app --url --data /tmp/cordis-demo-data
```

`package:desktop` 先构建 preset 与 runtime，再把 `dist/` 暂存进外壳、用
esbuild 打包 supervisor 与 worker、`go build` 外壳，并复制打包者当前的 Node
（`process.execPath`）到 `bin/`。`--out` 目录可以不存在。可选参数
`--bundle-public-key <PEM 文件>` 让签名公钥随包分发。

启动后可以直接照抄下面这段做端到端验收（命令都在仓库根或任意目录执行）。
它覆盖 HTTP 探测、释放目录内容与「第二次启动不重复写盘」：

```bash
# 后台启动，并把 --url 打印的地址抓到文件里。
# token 在 URL fragment 中，上面三条探测都不需要它。
/tmp/cordis-demo-install/cordis-app --url --data /tmp/cordis-demo-data \
  > /tmp/cordis-demo-url.txt 2> /tmp/cordis-demo.log &
CORDIS_PID=$!
for _ in $(seq 1 100); do
  grep -q '^http://127\.0\.0\.1:' /tmp/cordis-demo-url.txt && break
  sleep 0.2
done
PORT=$(sed -E 's#^http://127\.0\.0\.1:([0-9]+)/.*#\1#' /tmp/cordis-demo-url.txt)

# 1) HTTP 探测
curl -s "http://127.0.0.1:$PORT/__health"
# 预期输出：{"ok":true,"version":"1.0.0"}

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "http://127.0.0.1:$PORT/"
# 预期输出：200 text/html; charset=utf-8

curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "http://127.0.0.1:$PORT/__shared/react.js"
# 预期输出：200 text/javascript; charset=utf-8

# 2) 释放目录内容（hash 是 64 位十六进制，目录名随内容变化）
DATA=/tmp/cordis-demo-data
HASH_DIR=$(find "$DATA/app" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' | head -n 1)
echo "$HASH_DIR"
test -f "$HASH_DIR/app.json" && echo 'app.json: ok'
test -f "$HASH_DIR/server/index.js" && echo 'server/index.js: ok'
test -d "$HASH_DIR/resources/plugins" && echo 'resources/plugins: ok'
# 预期输出：/tmp/cordis-demo-data/app/<hash> 以及三行 ok

# 3) 第二次启动不重复写盘
#    macOS 用 stat -f '%m'；Linux 用 stat -c '%Y'。
BEFORE=$(stat -f '%m' "$HASH_DIR/app.json")
kill "$CORDIS_PID"; wait "$CORDIS_PID" 2>/dev/null

/tmp/cordis-demo-install/cordis-app --url --data "$DATA" \
  > /tmp/cordis-demo-url-2.txt 2>> /tmp/cordis-demo.log &
CORDIS_PID=$!
for _ in $(seq 1 100); do
  grep -q '^http://127\.0\.0\.1:' /tmp/cordis-demo-url-2.txt && break
  sleep 0.2
done
kill "$CORDIS_PID"; wait "$CORDIS_PID" 2>/dev/null

AFTER=$(stat -f '%m' "$HASH_DIR/app.json")
[ "$BEFORE" = "$AFTER" ] && echo 'mtime 未变: ok'
find "$DATA/app" -mindepth 1 -maxdepth 1 -type d -name '[0-9a-f]*' | wc -l
# 预期输出：
#   mtime 未变: ok
#          1
```

如果第一条探测不是 200，先看 `/tmp/cordis-demo.log`：通常是端口被占用、
`dist/` 缺产物，或服务端产物里有没打进产物（不自包含）的第三方依赖。

### 安装目录与数据目录

安装目录在运行期只读：

```
<out>/
├── cordis-app                 可执行文件（Windows 为 cordis-app.exe）
└── bin/
    ├── node[.exe]             随包 Node.js，目标机器无需预装
    ├── cordis-app-supervisor.mjs
    └── cordis-app-worker.mjs
```

首次启动时，外壳把内嵌的应用产物释放到可写的数据目录：

```
<dataDir>/
├── app/<hash>/                释放目录（路径 + 内容的哈希）
│   ├── app.json
│   ├── package.json
│   ├── server/index.js
│   ├── resources/
│   │   ├── ui/
│   │   ├── shared/
│   │   └── plugins/
│   └── bundle-public-key.pem  可选，随包分发的公钥
├── plugins/                   用户安装的签名插件（首次安装后出现）
├── installed.json             插件安装事实（首次安装后出现）
├── .cordis/                   runtime.json、tmp/、logs/、安装事务日志
├── data/                      插件数据与用户配置
└── shell.lock                 单实例锁
```

`<dataDir>` 默认按平台取标准目录：macOS
`~/Library/Application Support/cordis-app`、Windows `%APPDATA%\cordis-app`、
Linux `${XDG_DATA_HOME:-~/.local/share}/cordis-app`。可用外壳的
`--data <目录>` 或环境变量 `CORDIS_APP_DATA` 覆盖，`--data` 优先。

释放目录名是内嵌产物的内容哈希：同一份内容第二次启动直接复用，不重复写盘；
内容变化（升级）会生成新目录，并在取得单实例锁后清理旧目录。释放先写
`.tmp-*` 再原子改名，异常退出不会留下半成品。

### 签名公钥

打包形态只接受签名插件包。可信公钥按以下优先级解析，只使用第一个命中的来源：

1. 启动外壳时的环境变量 `CORDIS_APP_BUNDLE_PUBLIC_KEY`，值是 PEM 内容，不是路径；
2. 打包时通过 `--bundle-public-key <PEM 文件>` 随包分发的 `bundle-public-key.pem`；
3. 两者都没有：不向 worker 注入公钥，外壳启动时打印一条警告。

注意区别：`--bundle-public-key` 接收的是 PEM **文件路径**，打包时文件被复制成
`bundle-public-key.pem`；`CORDIS_APP_BUNDLE_PUBLIC_KEY` 接收的是 PEM **内容本身**。
两者不要混用。

第 3 种情况下 worker 保持 fail-closed：安装任何 `.cordis-plugin` 都会被拒绝
（错误信息为「未配置插件包签名公钥，拒绝安装未受信任的插件包」），不会退化成
「跳过签名校验」。外壳会先移除继承来的 `CORDIS_APP_*` 变量，再写入本次解析
出的值；用户 shell 里残留的 `CORDIS_APP_PROJECT` 等配置不会劫持 supervisor
的项目根或资源根。

### 服务端依赖在构建期自包含

唯一规则：**非框架提供的额外包由模块作者在构建期自包含**。服务端产物不在运行时
从项目或插件目录的 `node_modules` 解析依赖。

框架提供的服务端依赖只有 Node 内置模块（`node:*` 或无前缀，如 `events`）与
`cordis-app` 的类型面，
构建时保持 external。`@cordis-app/*` 是框架内部包，不属于公开契约，值导入在
构建期失败。

五条路径共用这一条规则：

- **`dev`**：与 `build` 使用同一个 `serverPreset`，项目 `server/` 与本地插件会
  现场构建到 `.cordis/dev/`，第三方依赖在每次重建时重新打包。
- **`build`**：项目 `server/index.js` 与 `resources/plugins/*` 的服务端入口（本地
  插件与 `node_modules` 中的插件）都会把第三方依赖打进各自的 ESM 产物；`dist/`
  不包含 `node_modules`。
- **`start`**：只读取 `dist/` 的 `app.json`、前端产物与 server 入口，部署时不需要
  项目 `node_modules`。
- **`package:desktop`**：在暂存与构建之前扫描项目 server 与各插件的服务端入口。
  白名单外的裸导入会硬失败，列出文件与包名，且不生成安装目录。遇到这种情况时，
  检查依赖是否已声明在项目或插件的 `package.json` 中，然后重新执行
  `cordis-app build`。
- **签名插件**：作者用 `@cordis-app/preset` 的 `serverPreset` / `clientPreset`
  构建入口。`.cordis-plugin` 只含构建产物，不含 `node_modules`；`package.json`
  只保留元数据与 `peerDependencies`，`dependencies` 只是构建输入，运行时不安装。
  安装与启动不需要 npm 或网络。

取舍（每个插件各带一份第三方依赖、模块级单例不跨插件共享、`dev` 重建更重、
不支持原生 `.node` addon）记录在
[ADR 0001](./docs/adr/0001-self-contained-server-builds.md)。

### 不在范围内

桌面打包本轮不包含：安装器与卸载器、代码签名与公证、自动更新、跨平台交叉
打包（Windows/macOS/Linux 各自在宿主平台构建），也不新增 `cordis-app package`
子命令。

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
| 4 | `<桌面数据目录>/plugins` | 有则扫描 | 扫描 | 打包应用的用户安装目录 |

「桌面数据目录」是打包形态的可写用户数据根：`cordis-app start` 用
`<project>/data`，桌面应用用「桌面打包」一节定义的桌面数据目录。

¹ 打包应用的源码插件已由 `build` 复制进 `resources/plugins`；再扫源码根会让同一
批插件重复出现。显式传入 `localPluginsDir` 时本地根仍然生效（`dev` 就靠它指向
`.cordis/dev/plugins`）。打包模式同样不扫描 `node_modules`，避免加载未经签名
校验的依赖。

重复 id 保留高优先级插件，低优先级产生一条失败记录；应用继续启动，只让冲突插件
不可用。

安装有两个来源，由进程配置决定，HTTP 请求不能切换：

- **项目模式**：npm 源在项目根执行包管理器，更新 `package.json`、lockfile，并把
  插件 id 写进 `app.json.plugins`。
- **打包模式**：只接受签名插件包。安装到 `<桌面数据目录>/plugins/<id>@<version>/`，
  事实写入 `<桌面数据目录>/installed.json`，不运行 npm。

两种来源共用同一个安装事务：开始前快照事实文件并写事务日志，失败或被中断时回滚。
**只读安装目录**指代码与依赖安装后不再修改（桌面形态就是「桌面打包」一节的
安装目录）；**可写用户数据**指 `<project>/data`（项目模式）或桌面数据目录
（打包模式）。公共 `app.lock` 已移除。

## 签名插件包

`.cordis-plugin` 是 tar.gz，包含 `plugin.json`、`package.json`、server/client
产物与 `bundle.json`。归档**不包含 `node_modules`**：第三方依赖已由作者在构建期
打进 server/client 产物。`package.json` 只保留元数据与 `peerDependencies`；
`dependencies` 是构建输入，安装与运行时不解析、也不安装。`bundle.json` 记录内容
hash、Ed25519 签名与 peer 范围；安装时先比 hash、再验签名，任何一步失败都不改动
用户插件目录。

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
| `pnpm test:consumer` | 真实消费方冒烟：npm `file:` 接入 → `add` → `build` → 删除 `node_modules` → `start` |
| `pnpm test:desktop` | 桌面形态冒烟：`build` → `package-desktop` → 启动安装目录并加载插件 |
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
