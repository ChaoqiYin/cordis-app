/**
 * 连接状态条。
 *
 * 参考实现：DefaultBody 把它渲染在底部。项目 body 可以用
 * `useConnectionStatus()` 自己决定提示的措辞、位置与形态，完全不必使用这个
 * 组件——连接提示和布局一样，归 body。
 *
 * 文案按「原因」而不是「相位」选：同样处于 reconnecting，用户刚触发的插件
 * 变更和意外掉线应该读起来完全不同。未知原因一律回退为中性措辞。
 */

import type { ReactNode } from 'react'
import { useConnectionStatus, type ConnectionPhase } from 'cordis-app/client'

export function ConnectionStatusBar(): ReactNode {
  const { phase, reason } = useConnectionStatus()
  const message = describeConnection(phase, reason)
  if (!message) return null
  return <div className="reconnect-bar">{message}</div>
}

function describeConnection(
  phase: ConnectionPhase,
  reason: string | undefined,
): string | null {
  if (phase === 'failed') return '与服务的连接已断开，请刷新页面'
  // connecting 是首次连接与恢复后的短暂相位，不该出现提示
  if (phase !== 'reconnecting') return null

  switch (reason) {
    case 'plugin-change':
      return '正在应用插件变更…'
    case 'restart':
      return '正在重启服务…'
    case 'shutdown':
      // 外部信号分不清是停止还是重启，等不到恢复会落到 failed
      return '正在等待服务恢复…'
    default:
      // 旧版 worker、广播丢失或未知原因
      return '正在重连…'
  }
}
