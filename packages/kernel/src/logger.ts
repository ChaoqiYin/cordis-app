/**
 * 框架自带的日志实现。
 *
 * 刻意不依赖 @cordisjs/logger：内核只需要「分级、带名字、写 stderr」这一件事，
 * 而 worker 的 stdout 必须保持干净（只由 supervisor 使用），所以日志一律走 stderr。
 */

export type LogLevel = 'debug' | 'info' | 'success' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  success: 25,
  warn: 30,
  error: 40,
}

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  success: 'OK   ',
  warn: 'WARN ',
  error: 'ERROR',
}

export interface LoggerOptions {
  /** 最低输出级别，默认 info */
  level?: LogLevel
  /** 输出目标，默认 stderr */
  write?: (line: string) => void
  /** 是否输出时间戳，默认 true */
  timestamps?: boolean
}

export interface Logger {
  readonly name: string
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  success(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  /** 派生一个带子名的 logger */
  extend(name: string): Logger
}

export interface LoggerFactory {
  /** 按名字取 logger */
  (name: string): Logger
  /** 工厂自身也可直接记日志，等价于以 `root` 为名 */
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  success(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  setLevel(level: LogLevel): void
  readonly level: LogLevel
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg
      if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`
      try {
        return JSON.stringify(arg)
      } catch {
        return String(arg)
      }
    })
    .join(' ')
}

export function createLoggerFactory(options: LoggerOptions = {}): LoggerFactory {
  let threshold = LEVEL_ORDER[options.level ?? 'info']
  const write = options.write ?? ((line: string) => process.stderr.write(line + '\n'))
  const timestamps = options.timestamps ?? true

  const factory = ((name: string): Logger => {
    const emit = (level: LogLevel, args: unknown[]) => {
      if (LEVEL_ORDER[level] < threshold) return
      const time = timestamps ? new Date().toISOString().slice(11, 23) + ' ' : ''
      write(`${time}${LEVEL_LABEL[level]} ${name} ${formatArgs(args)}`)
    }
    return {
      name,
      debug: (...args) => emit('debug', args),
      info: (...args) => emit('info', args),
      success: (...args) => emit('success', args),
      warn: (...args) => emit('warn', args),
      error: (...args) => emit('error', args),
      extend: (sub) => factory(`${name}:${sub}`),
    }
  }) as LoggerFactory

  // 工厂自身直接记日志时，使用一个中性的名字
  const root = factory('root')
  factory.debug = root.debug
  factory.info = root.info
  factory.success = root.success
  factory.warn = root.warn
  factory.error = root.error

  factory.setLevel = (level) => {
    threshold = LEVEL_ORDER[level]
  }
  Object.defineProperty(factory, 'level', {
    get: () => (Object.keys(LEVEL_ORDER) as LogLevel[]).find((k) => LEVEL_ORDER[k] === threshold) ?? 'info',
  })

  return factory
}
