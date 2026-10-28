/**
 * Kernel —— cordis 的最小适配面。
 *
 * 只有本包依赖 cordis。cordis 的内部概念（Fiber / Scope / effect / registry）
 * 一律不外泄，插件作者与框架其余部分只看到下面这个接口。
 */

import { Context } from '@cordisjs/core'
import type { Logger } from './logger.js'

/**
 * 插件定义。与 cordis 的 Plugin 形状一致，但只保留框架承认的字段。
 *
 * 两种写法都支持：函数式（`export function apply`）与对象式（`export default { apply }`）。
 * 前者是文档推荐的写法，后者便于插件在对象上挂额外字段。
 */
export interface PluginObject {
  name?: string
  /** 依赖的服务名。未就绪时插件挂起，就绪后自动恢复。 */
  inject?: string[]
  /** 配置 schema（schemastery 产物）。 */
  Config?: unknown
  apply(ctx: any, config: any): void | Promise<void>
}

export interface PluginFunction {
  (ctx: any, config: any): void | Promise<void>
  name?: string
  inject?: string[]
  Config?: unknown
}

export type PluginDefinition = PluginObject | PluginFunction

/** 从两种写法里取出插件名。 */
export function pluginName(definition: PluginDefinition, fallback = 'anonymous'): string {
  if (typeof definition === 'function') return definition.name || fallback
  return definition.name || fallback
}

export type Disposable = () => void

/** 插件加载状态。cordis 的 ScopeStatus 映射到框架语义。 */
export type PluginStatus = 'pending' | 'loading' | 'active' | 'failed' | 'disposed'

export interface KernelOptions {
  logger?: Logger
}

export interface MountedPlugin {
  readonly name: string
  readonly status: PluginStatus
  /** 强制按新配置重载该插件（dispose → apply），不重启 worker。 */
  restart(config?: unknown): void
  dispose(): void
}

export interface Kernel {
  /** 挂载一个插件，返回可撤销句柄。 */
  plugin(definition: PluginDefinition, config?: unknown): MountedPlugin
  /** 注册服务，返回可撤销句柄。 */
  service<T>(name: string, factory: (ctx: KernelContext) => T): Disposable
  /** 取一个以名字隔离的作用域。同名多次调用返回同一个 Kernel。 */
  isolate(name: string): Kernel
  /** 事件总线。 */
  emit(event: string, ...args: unknown[]): void
  on(event: string, handler: (...args: unknown[]) => void): Disposable
  /** 等待所有挂起插件就绪（或失败）。 */
  ready(): Promise<void>
  /** 逆序释放本作用域挂载的插件与服务。根 Kernel 释放全部。 */
  dispose(): void
  /** 底层 cordis 上下文，仅供 runtime 的内置插件使用。 */
  readonly context: KernelContext
}

/**
 * 插件作者看到的上下文形状。
 *
 * 这里故意只声明框架保证存在的字段；具体服务（router / storage / ws …）
 * 由 services.ts 通过 declaration merging 补充。
 */
export interface KernelContext {
  [key: string]: any
}

const STATUS_MAP: Record<number, PluginStatus> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
}

/** 把一次性函数包成幂等的 disposer，避免重复调用时的副作用。 */
function once(fn: () => void): Disposable {
  let done = false
  return () => {
    if (done) return
    done = true
    fn()
  }
}

export function createKernel(options: KernelOptions = {}): Kernel {
  const root = new Context()
  const logger = options.logger

  root.on('internal/error', function (this: any, error: unknown) {
    logger?.error(`[${this.name ?? 'ctx'}]`, error)
  })
  root.on('internal/warning', function (this: any, ...args: unknown[]) {
    logger?.warn(`[${this.name ?? 'ctx'}]`, ...args)
  })

  /**
   * 每个 Kernel 只持有自己作用域内挂载的东西。
   *
   * 这一点很关键：若所有子作用域共用一个集合，任一 isolate 的 dispose()
   * 会连带释放别的 isolate 的插件。
   */
  function build(scope: KernelContext): Kernel {
    const own = new Set<MountedPlugin>()
    const children = new Map<string, Kernel>()

    return {
      context: scope,

      plugin(definition, config) {
        const name = pluginName(definition)
        const fork = scope.plugin(definition as any, config as any)
        let currentConfig = config

        const handle: MountedPlugin = {
          name,
          get status() {
            return STATUS_MAP[fork.status] ?? 'pending'
          },
          restart(next) {
            // cordis 的 update(config, forced=true) 走 dispose → apply，
            // 语义等同「插件级 restart」，代价远小于重启 worker。
            if (next !== undefined) currentConfig = next
            fork.runtime.update(currentConfig, true)
          },
          dispose() {
            fork.dispose()
            own.delete(handle)
          },
        }
        own.add(handle)
        return handle
      },

      service<T>(serviceName: string, factory: (ctx: KernelContext) => T) {
        // 用 effect 包住，让服务随 scope 一起销毁——这是「插件卸载不留残渣」的基础。
        const result = scope.effect((ctx: KernelContext) => {
          const value = factory(ctx)
          const remove = ctx.set(serviceName, value)
          return () => {
            remove()
          }
        })
        return typeof result === 'function' ? result : () => (result as any)?.dispose?.()
      },

      isolate(name) {
        let child = children.get(name)
        if (!child) {
          child = build(scope.isolate(name))
          children.set(name, child)
        }
        return child
      },

      emit(event, ...args) {
        scope.emit(event as any, ...args)
      },

      on(event, handler) {
        const off = scope.on(event as any, handler as any)
        return () => {
          off()
        }
      },

      async ready() {
        // lifecycle.start() 会等待所有插件的异步 apply 结束，并把失败者标为 FAILED。
        await scope.lifecycle.start()
      },

      dispose: once(() => {
        for (const handle of [...own].reverse()) handle.dispose()
        own.clear()
        for (const child of [...children.values()].reverse()) child.dispose()
        children.clear()
      }),
    }
  }

  return build(root as unknown as KernelContext)
}
