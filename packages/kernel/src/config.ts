/**
 * 配置持久化。
 *
 * 单一 config.json 位于实例根目录，写入采用原子替换（tmp → rename）。
 * 为什么单一文件而非一插件一文件，见架构文档 8.2。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type ConfigData = Record<string, unknown>

export interface ConfigStoreOptions {
  /** config.json 的绝对路径 */
  filePath: string
}

export class ConfigStore {
  readonly filePath: string
  private data: ConfigData = {}
  private loaded = false
  private readonly listeners = new Set<(id: string, value: unknown) => void>()

  constructor(options: ConfigStoreOptions) {
    this.filePath = options.filePath
  }

  /** 读取整个配置。文件缺失或损坏时返回空对象——配置永远不是启动的阻断点。 */
  load(): ConfigData {
    if (this.loaded) return this.data
    this.loaded = true
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed as ConfigData
      }
    } catch {
      this.data = {}
    }
    return this.data
  }

  get(id: string): unknown {
    return this.load()[id]
  }

  all(): ConfigData {
    return this.load()
  }

  /** 写入单个插件的配置并原子落盘，然后通知监听者。 */
  set(id: string, value: unknown): void {
    this.load()
    this.data = { ...this.data, [id]: value }
    this.flush()
    for (const listener of this.listeners) listener(id, value)
  }

  /** 删除插件配置（卸载插件时使用）。 */
  delete(id: string): void {
    this.load()
    if (!(id in this.data)) return
    const next = { ...this.data }
    delete next[id]
    this.data = next
    this.flush()
  }

  onChange(listener: (id: string, value: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private flush(): void {
    const dir = dirname(this.filePath)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.config.json.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
    renameSync(tmp, this.filePath)
  }
}
