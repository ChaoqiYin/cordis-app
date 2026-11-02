/**
 * 项目自定义的插件包来源。
 *
 * 打包形态默认只接受本地文件或 `file://` 的 `.cordis-plugin`。需要从别处
 * 获取时，项目在 `app.json.pluginSource` 声明一个模块，由它实现
 * `readArchive(spec, ctx)`。这和 `bundle.readArchive` 是同一个契约，区别只在
 * 注入时机：前者由项目清单声明，后者由嵌入方在启动参数里传入。
 *
 * 模块是项目代码，和项目 server 入口一样受信任；HTTP 请求只能传 `spec`，
 * 不能指定模块位置或替换实现。
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 来源模块可见的运行期上下文；只读，且不含安装器实例。 */
export interface PluginSourceContext {
  /** 项目根：`cordis-app start` 时仍是项目目录，不是 dist。 */
  projectRoot: string
  /** 本次运行读取的 app.json 绝对路径。 */
  appJsonPath: string
  /** 可写用户数据根；打包形态的签名插件安装事实也在这里。 */
  userDataDir: string
  frameworkVersion: string
}

/**
 * 读取一个插件包归档。
 *
 * 返回值必须是 `Uint8Array`（`Buffer` 可以）。`spec` 原样来自安装请求，
 * 实现必须自行限制允许的取值——框架不会替它做白名单。
 */
export type ProjectReadArchive = (
  spec: string,
  ctx: PluginSourceContext,
) => Promise<Uint8Array>

/**
 * 把清单里的相对路径解析成模块绝对路径。
 *
 * `pluginSource` 只允许指向 app.json 所在目录之内：打包产物释放到可写目录
 * 后，清单旁边的文件才是随包分发的代码；允许 `../` 会让一个项目清单
 * 意外加载数据目录里的任意模块。
 */
export function resolvePluginSourcePath(appJsonPath: string, declared: string): string {
  if (declared.trim() === '') {
    throw new Error('app.json.pluginSource 不能是空字符串')
  }
  if (isAbsolute(declared)) {
    throw new Error(`app.json.pluginSource 必须是相对路径：${declared}`)
  }

  const root = dirname(appJsonPath)
  const path = resolve(root, declared)
  const rel = relative(root, path)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`app.json.pluginSource 不能指向 app.json 所在目录之外：${declared}`)
  }
  return path
}

/**
 * 加载项目声明的来源模块。
 *
 * 加载失败是硬错误：清单声明了来源却加载不到，说明构建漏产物或模块导出
 * 写错了；静默回退到默认实现会让用户以为自定义来源生效，实际仍在读本地文件。
 */
export async function loadProjectPluginSource(path: string): Promise<ProjectReadArchive> {
  if (!existsSync(path)) {
    throw new Error(`找不到插件来源模块：${path}。先执行 cordis-app build。`)
  }

  let mod: unknown
  try {
    mod = await import(pathToFileURL(path).href)
  } catch (error) {
    throw new Error(`加载插件来源模块失败：${path}：${(error as Error).message}`, {
      cause: error,
    })
  }

  const readArchive = (mod as { readArchive?: unknown } | null)?.readArchive
  if (typeof readArchive !== 'function') {
    throw new Error(`插件来源模块 ${path} 必须导出 readArchive(spec, ctx) 函数`)
  }

  // 统一在边界上校验返回值：来源模块是项目代码，错误类型不该拖到签名校验
  // 或 tar 解析阶段才以难懂的方式暴露。
  return async (spec, ctx) => {
    const archive = await (readArchive as ProjectReadArchive)(spec, ctx)
    if (!(archive instanceof Uint8Array)) {
      throw new Error(`插件来源模块 ${path} 的 readArchive 必须返回 Uint8Array`)
    }
    return archive
  }
}
