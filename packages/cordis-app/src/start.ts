/**
 * `cordis-app/start` —— 程序化启动入口。
 *
 * 只转出 `@cordis-app/runtime` 的 `startApp()` 与相关类型。supervisor 永远
 * 是子进程；调用方拿到的是端口、token 与生命周期句柄，不是进程内的 worker。
 */

export {
  startApp,
  StartAppError,
  type AppEvents,
  type AppExitEvent,
  type AppHandle,
  type SpawnSupervisor,
  type SpawnSupervisorOptions,
  type StartAppOptions,
  type SupervisorChild,
} from '@cordis-app/runtime'
