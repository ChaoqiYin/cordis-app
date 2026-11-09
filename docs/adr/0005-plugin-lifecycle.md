# ADR 0005：插件生命周期收敛为两状态，来源与物理动作分离

## Status

已采纳（2026-11-09）。

## Context

插件曾经没有明确的用户可见生命周期，由此产生三类问题。

**包管理器被写死。** 项目模式在安装/卸载时固定执行 npm。用户在 pnpm 项目里从
设置页卸载插件，框架跑的是 npm 命令；卸载表面上成功，项目里却多出一个没人用的
`package-lock.json`。项目实际使用 pnpm，依赖与 lockfile 的维护方式被悄悄改变，
用户没有收到任何提示。yarn 与 bun 项目同样会偏离自己的依赖维护方式。

**卸载之后无法恢复。** 设置页卸载插件后只剩已安装列表。用户想把插件装回来，
只能手动编辑 `app.json`，把插件 id 加回 `plugins`。随包插件、项目本地插件与外部
插件混在同一个列表里，用户看不出哪些是随应用发布的、哪些是项目自己的、哪些是从
外部安装的，也不知道卸载它们分别会发生什么。外部插件一旦真正卸载，包名、版本和
原始 spec 就丢了，界面无法提供一键重装。

**框架内部没有「已卸载」概念。** 插件根扫描只看磁盘，`app.json.plugins` 只表示
启用顺序，loader 没有过滤入口；卸载对所有插件都走安装来源，随包插件和项目本地
插件也被当成可被包管理器删除的包。结果是：逻辑上想「关掉」一个随包插件，实际却
可能去删只读的随包产物；或者反过来，把项目依赖当成普通目录处理，留下不一致的
`package.json` 与 lockfile。文档与界面也曾把「随包」误当成「不可卸载」。

## Decision

### 1. 只有两个状态、两个动作

用户可见状态收敛为 **已启用** 与 **已卸载**；动作收敛为 **卸载** 与 **启用**。
不引入 `disabled` / `stopped`，也不提供「停用」按钮。

- `AppManifest` 增加可选字段 `uninstalledPlugins?: string[]`，缺省表示没有显式
  卸载任何插件。`plugins` 继续表示启用顺序，不是白名单。
- 项目模式下 `app.json.uninstalledPlugins` 是已卸载 id 集合的真源，状态文件提供
  明细；打包模式下 `app.json` 只读，状态文件同时保存集合与明细。
- 状态文件放在可写数据目录：项目模式是
  `<project>/data/plugins-state.json`，打包模式是
  `<userData>/plugins-state.json`。写入使用临时文件 + rename；每次读取以磁盘为
  准，不在内存里缓存第二份真相。
- worker 启动时生成两个视图：完整扫描视图供 `GET /api/plugins` 展示；启用视图
  （完整扫描减去已卸载 id）供 loader、前端清单与静态资源使用。已卸载插件不再
  出现在页面、插槽、菜单、设置与前端清单里，`/__plugins/<id>/…` 返回 404。
- 卸载与启用都保留插件配置；安装一个已卸载插件时自动清除其已卸载状态。重复
  卸载或启用是幂等的。重新启用后插件追加到 `app.json.plugins` 末尾。

### 2. 来源标识与物理动作分离

面向用户的来源标识（`origin`）只有三种：随包（`builtin`）、项目本地（`local`）、
外部（`external`，包含项目依赖与打包模式的用户安装目录）。它决定卸载动作，
但不是安装来源（`InstallSource`）。`InstallSource` 保持 `'npm' | 'bundle'` 不变，
事务日志不需要迁移；`packageManager` 只作为诊断与恢复字段放在事务日志的 `data`
里。

按插件根类型（`rootKind`）分流：

| `rootKind` | 卸载动作 | 启用动作 |
| --- | --- | --- |
| `builtin` | 只写状态，不删文件、不跑包管理器 | 只清状态 |
| `local` | 只写状态，不删文件、不跑包管理器 | 只清状态 |
| `dependency` | 跑项目包管理器 `remove`，写卸载记录 | 有 spec 则重新安装；没有则报不可重装 |
| `user`（项目模式） | 只写状态 | 只清状态 |
| `user`（打包模式） | 由 bundle 来源物理移除目录，写卸载记录 | 有 spec 则重新安装 |

卸载外部插件时记录包名、版本、来源与原始 spec，供「已卸载」列表一键重装。没有
记录或记录缺少 spec 时，插件仍显示为已卸载，但 `reinstallable` 为 false，需要
重新提供插件包。卸载项目依赖插件时，手工安装、没有 `installed` 元数据的记录用
`包名@已安装版本` 合成 spec。

### 3. 包管理器检测，冲突时不静默回退

项目模式新增一个纯逻辑的包管理器检测器：输入项目根，输出
`{ name, command }`，`name` 是 `npm | pnpm | yarn | bun`。检测器只读文件，不执行
命令。检测顺序：

1. 显式 `yarnPath`（保留最高优先级，通过
   `process.execPath <yarnPath>` 执行）。
2. `package.json#packageManager`：取第一个 `@` 之前的名字；名字必须是四个受支持
   的管理器之一，否则报错。
3. 唯一的 lockfile：`pnpm-lock.yaml` → pnpm，`yarn.lock` → yarn，
   `bun.lock` / `bun.lockb` → bun，`package-lock.json` /
   `npm-shrinkwrap.json` → npm。
4. 多个 lockfile 指向不同管理器时，用 `node_modules` 证据消歧：
   `node_modules/.pnpm` → pnpm，`node_modules/.package-lock.json` → npm，
   `node_modules/.yarn-integrity` → yarn。证据必须命中候选之一；命中多个或一个
   都不命中视为歧义。
5. 没有 lockfile 时，同样用 `node_modules` 证据判断，证据唯一才采用。
6. 没有任何信号时回退 npm。

歧义时抛错，错误信息列出检测到的 lockfile/证据与候选管理器，并说明如何修正
（删除多余 lockfile、补 `packageManager`、或清理 `node_modules`）。**不静默回退
到 npm**。四个管理器统一使用 `add <spec>` / `remove <name>`；执行失败时错误信息
带上检测到的管理器名称和实际命令。事务日志记录本次使用的包管理器，恢复时优先
使用日志里的值；旧日志没有该字段时回退 npm。

不自动删除项目里已有的 `package-lock.json`；本次只保证新操作不再创建它。

### 4. 入口与文档

`DELETE /api/plugins/:id` 的语义从「删除插件并删除配置」改为「卸载并保留配置」；
新增 `POST /api/plugins/:id/enable`。设置页分为「已启用 / 已卸载」两组，每行
标出来源，只提供「卸载」与「启用」。CLI 新增 `cordis-app enable <id>`，
`remove` 与设置页共用同一套卸载语义，`list` 显示来源与已启用/已卸载状态，
`add` 成功后清除已卸载状态。`GLOSSARY.md`、`README.md` 与
`docs/plugin-bundles.md` 同步记录该模型。

## Alternatives

**继续固定 npm。** 这能保持现有实现不变，但 pnpm、yarn、bun 项目会被悄悄切换
依赖维护方式，产生第二种 lockfile；用户只能事后发现并手工清理。问题不在某个
命令写错，而在框架无视项目已经声明的包管理器。

**引入「停用」状态。** 停用与卸载在用户看来都是「这个插件现在不工作」，多一个
状态只会让按钮、清单和过滤规则翻倍，却没有对应的新能力。两状态已经能表达用户
的全部意图。

**把随包插件物理删除。** 随包产物位于只读安装目录，运行期不应写入；即使能删，
重新启用时也无法从产物恢复。逻辑移除既能立即生效，又能保留一键装回的能力。

**检测冲突时回退 npm。** 静默回退会把项目配置错误隐藏起来，并可能在 pnpm 项目里
生成 `package-lock.json`。明确报错能让用户看到检测到的信号并修正配置。

## Consequences

正面：

- pnpm、yarn、bun 项目的安装/卸载使用项目自己的包管理器，lockfile 与依赖维护
  方式保持一致，不再意外生成 `package-lock.json`。
- 用户能区分随包、项目本地与外部插件，并知道卸载各自会发生什么；随包插件可以
  卸载，只是逻辑移除，不会破坏只读产物。
- 外部插件卸载后仍有卸载记录，设置页与 CLI 都能一键装回；不能重装时给出明确
  原因，而不是静默失败。
- 已卸载插件在 loader、前端清单、静态资源与失败列表中都被过滤，界面不会残留
  坏入口；插件配置保留，重新启用后无需重新配置。
- 包管理器检测是纯函数，冲突与回退规则可以精确单测。

代价：

- `app.json` 增加第二个与插件相关的字段；项目模式下 `app.json.uninstalledPlugins`
  与状态文件存在两份信息，需要按「`app.json` 为集合真源、状态文件为明细」的
  规则协调，不一致时还要清理过期记录。
- 包管理器信号冲突时项目会直接报错，用户必须修正 lockfile、`packageManager` 或
  `node_modules`；这是有意的硬失败，但会增加一次配置成本。
- 本次之前安装的签名插件包没有记录原始 spec，卸载后 `reinstallable` 为 false，
  需要重新提供插件包。
- 重新启用后插件排在启用列表末尾；需要固定顺序的项目要手动调整
  `app.json.plugins`。
- `DELETE /api/plugins/:id` 的语义发生变化：从删除并删除配置改为卸载并保留配置；
  依赖旧语义的调用方需要调整。
- 打包模式的卸载状态只写在用户数据目录，不进入只读的 `dist/app.json`；团队
  共享的是项目模式的 `app.json.uninstalledPlugins`，打包形态的卸载状态不会随
  产物分发。
