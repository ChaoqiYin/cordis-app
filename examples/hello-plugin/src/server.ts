/**
 * hello 插件的服务端入口。
 *
 * 这份文件演示插件作者需要的全部服务端写法：
 *   - `name` / `inject` 声明身份与依赖
 *   - `apply` 里用 `ctx.router` 注册路由、用 `ctx.storage` 读写自己的数据目录
 *   - `export const data` 把初始状态随清单一起送到前端，省掉一次「我是谁」请求
 *
 * 注意这里只有 `import type`：框架的运行时代码由 worker 提供，插件不得自带
 * 第二份。类型在构建时被擦除，产物里不会留下这条导入。
 */

import type { KernelContext } from '@cordis-app/kernel'

/** 与 plugin.json 的 id 一致。存储目录、清单键、前端 usePluginData 都按它索引。 */
const ID = 'hello'

export const name = ID

/** 服务就绪前 cordis 不会调用 apply，避免读到 undefined。 */
export const inject = ['router', 'storage', 'logger']

/** 随前端清单送达的初始状态（loader 会把它放进 ClientPluginEntry.data）。 */
export const data = { greeting: '你好，cordis-app' }

export function apply(ctx: KernelContext) {
  // logger 不做 printf 替换：参数会以空格拼在消息后面，所以这里用模板串
  ctx.logger.info(`[hello] 插件已加载，数据目录：${ctx.storage.dir(ID)}`)

  /**
   * 每次访问累加一次，结果写进插件自己的数据目录。
   *
   * 用 storage 而不是直接拼路径：存放位置是应用决策，换实现时插件代码不变。
   */
  ctx.router.get('/api/hello', async (_req, res) => {
    const previous = await ctx.storage.read(ID, 'visits.txt')
    const visits = Number.parseInt(previous?.toString() ?? '0', 10) + 1
    await ctx.storage.write(ID, 'visits.txt', String(visits))

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ greeting: data.greeting, visits }))
  })
}
