# 签名插件包（`.cordis-plugin`）

打包应用不运行 npm，只接受经过签名校验的插件包。本文记录归档格式、内容 hash、
签名载荷与密钥管理。项目模式仍然走 npm 安装，两者共用同一个事务与回滚框架；
区别只在 `InstallSource`，事实文件与回滚语义完全一致。

## 1. 归档格式

`.cordis-plugin` 是 **tar.gz**（不是 zip）。归档根目录至少包含：

```
plugin.json        插件身份、入口与 UI 需求
package.json       peerDependencies（必须声明 cordis-app）
bundle.json        版本、内容 hash、签名、peer 范围、UI 需求
server 与 client 入口（路径由 plugin.json 指向）
```

`bundle.json` 字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 插件 id，必须与 `plugin.json.id` 一致，且符合插件 id 规则 |
| `version` | 是 | 语义化版本；安装目录为 `<id>@<version>` |
| `hash` | 是 | 规范化内容 hash，`sha256:<hex>` |
| `signature` | 是 | Ed25519 签名，base64 |
| `algorithm` | 否 | 目前只接受 `ed25519` |
| `peer` | 是 | 与 `package.json.peerDependencies` 一致，必须包含 `cordis-app` |
| `ui` | 否 | 插件声明的 UI 出口需求 |
| `builtAt` | 否 | 构建时间，仅作说明，不参与校验 |

## 2. 内容 hash

取归档内全部普通文件，**排除 `bundle.json` 自身**，按 POSIX 路径排序，依次加入：

```
路径 + "\0" + 内容字节长度 + "\0" + 内容 + "\0"
```

对整段字节求 SHA-256，输出 `sha256:<hex>`。因此 tar 条目顺序、mtime、压缩参数
都不影响结果；任何一个文件内容或路径变化都会改变 hash。

## 3. 签名载荷

签名对象是下面这段 UTF-8 字节（注意每行结尾的换行）：

```
cordis-plugin-bundle-v1
<id>
<version>
<hash>
<peer 的规范化 JSON>
<ui 的规范化 JSON（缺省为空行）>
```

`peer` 与 `ui` 使用确定性 JSON：对象键按字典序递归排序，数组保持原顺序；
`ui` 缺省时该行为空字符串。使用 Ed25519 对载荷做
`sign(null, payload, privateKey)`，把结果编码为 base64 写入
`bundle.json.signature`。校验时用可信公钥做
`verify(null, payload, publicKey, signature)`。

签名覆盖 id、版本、内容 hash、peer 范围与 UI 需求：替换任一文件、换版本号、
把包挪给另一个 id、或改写 `bundle.json` 里的 `peer`/`ui` 都会导致校验失败。
`hash` 本身不覆盖 `bundle.json`，所以 `peer`/`ui` 的完整性由签名而不是 hash
保证。

## 4. 生成密钥

```bash
# 私钥只留在发布机器上，不要提交进仓库，也不要打进插件包
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

应用启动时通过环境变量提供可信公钥：

```bash
export CORDIS_APP_BUNDLE_PUBLIC_KEY="$(cat public.pem)"
```

也接受 base64 的 SPKI DER 或已构造的 `KeyObject`。**未配置公钥时安装一律被拒绝**，
不存在“跳过校验”的降级路径。

## 5. 打包与签名

打包器可以先收集文件、计算 hash，再写 `bundle.json`，最后生成 tar.gz：

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { createPrivateKey, sign } from 'node:crypto'
import {
  computeBundleHash,
  bundleSignaturePayload,
  createTarGz,
} from '@cordis-app/runtime'

const files = new Map()
for (const name of ['plugin.json', 'package.json', 'server.js', 'client.js']) {
  files.set(name, readFileSync(`dist/${name}`))
}

const id = 'hello-plugin'
const version = '1.0.0'
const peer = { 'cordis-app': '^1.0.0' }
const ui = { pages: true }

const hash = computeBundleHash(files)
const payload = bundleSignaturePayload({ id, version, hash, peer, ui })
const privateKey = createPrivateKey(readFileSync('private.pem'))
const signature = sign(null, payload, privateKey).toString('base64')

const bundle = { id, version, hash, signature, algorithm: 'ed25519', peer, ui }
files.set('bundle.json', Buffer.from(JSON.stringify(bundle, null, 2)))

writeFileSync(`hello-plugin-${version}.cordis-plugin`, createTarGz(files))
```

`bundle.json` 必须在计算 hash **之后**加入，因为 hash 不覆盖它自身。

## 6. 安装行为

1. 读取归档，解析 `bundle.json`，计算内容 hash 并比对。
2. 校验签名；公钥缺失或签名不匹配直接失败。
3. 解压到 `<userData>/.cordis/tmp/extract-<txId>`。
4. 校验 `plugin.json`、`package.json`、peer 范围、id/版本，以及服务端/前端入口
   必须是插件根内的普通文件（拒绝绝对路径、`..`、反斜杠、NUL、符号链接）。
5. 把已有的 `<id>@*` 目录移入事务备份，再 `rename` 新目录到
   `<userData>/plugins/<id>@<version>/`。
6. 原子更新 `<userData>/installed.json`。成功后才删除备份。
7. 任一步失败：删除新目录、移回旧版本、由外层事务恢复文件快照。

`installed.json` 是用户安装事实，形状为：

```json
{
  "version": 1,
  "plugins": {
    "hello-plugin": {
      "id": "hello-plugin",
      "version": "1.0.0",
      "dir": "hello-plugin@1.0.0",
      "hash": "sha256:…",
      "installedAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

它写在用户数据目录，不是项目里的公共 `app.lock`。文件损坏时安装器会硬失败，
不会静默清空用户的安装记录。

## 7. 安全边界

- 归档来源默认只接受本地路径或 `file://`；远程 URL 必须由进程配置注入
  `readArchive`，HTTP 请求不能指定下载地址。
- 运行形态由进程配置决定（`mode: 'packaged'`）；HTTP 请求不能切换安装来源。
- 解压后有总大小上限（默认 256 MB），避免压缩炸弹。
- 拒绝重复路径、符号链接、硬链接、设备文件与 FIFO。
- UI 能力不匹配只产生警告并写入 `InstallResult.uiCompatibility`，不阻断安装。

## 8. 与项目模式的关系

| | 项目模式 | 打包模式 |
| --- | --- | --- |
| 安装来源 | npm（项目包管理器） | `.cordis-plugin` 签名包 |
| 事实文件 | `package.json`、项目 lockfile、`app.json` | `<userData>/installed.json` |
| 安装位置 | `<project>/node_modules` | `<userData>/plugins/<id>@<version>/` |
| 可写数据 | `<project>/data` | `<userData>` |
| 是否需要 npm | 是 | 否 |

运行形态由进程配置（`mode: 'project' | 'packaged'`）决定，HTTP 请求不能切换来源，
也不能指定任意下载地址。插件 UI 需求与项目 body 能力的匹配结果写入
`InstallResult.uiCompatibility`（`full` / `backend-only` / `incompatible`），
不阻断服务端安装。

## 9. 不在范围内

插件包格式只负责「可信地分发单个插件」。以下属于市场/发布服务，当前版本不实现：

- 插件目录检索、上传、账户体系与审核流程
- 自动更新与版本回滚策略
- 托盘与跨平台外壳的实机验证
