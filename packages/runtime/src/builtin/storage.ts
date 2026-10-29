/**
 * storage 内置插件：插件数据目录的受管读写。
 *
 * 单独成插件而不是塞进内核：内核只保证「配置能持久化」，用户数据
 * （上传的文件、缓存、数据库）的存放策略属于应用决策。默认实现把数据放在
 * `instances/default/data/<plugin-id>/`，应用可以换成走对象存储的实现，
 * 插件代码不变。
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { KernelContext, StorageService } from '@cordis-app/kernel'
import { safeJoin } from './http-utils.js'

export interface StorageOptions {
  /** 插件数据根目录，通常为 <instance>/data */
  root: string
}

function assertId(id: string): string {
  // 插件 id 会直接成为目录名，必须挡掉路径分隔符与相对片段
  if (!/^[a-zA-Z0-9@._-]+$/.test(id) || id === '.' || id === '..') {
    throw new Error(`非法的插件 id: ${id}`)
  }
  return id
}

export function apply(ctx: KernelContext, config: StorageOptions) {
  const base = (id: string) => join(config.root, assertId(id))

  const service: StorageService = {
    dir(id) {
      return base(id)
    },
    async read(id, file) {
      const path = safeJoin(base(id), file)
      if (!path) throw new Error(`非法的文件路径: ${file}`)
      try {
        return await readFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async write(id, file, data) {
      const path = safeJoin(base(id), file)
      if (!path) throw new Error(`非法的文件路径: ${file}`)
      await mkdir(join(path, '..'), { recursive: true })
      await writeFile(path, data)
    },
    async remove(id, file) {
      const path = safeJoin(base(id), file)
      if (!path) throw new Error(`非法的文件路径: ${file}`)
      await rm(path, { force: true, recursive: true })
    },
    async list(id) {
      const dir = base(id)
      try {
        return await readdir(dir)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
      }
    },
  }

  ctx.set('storage', service)
}
