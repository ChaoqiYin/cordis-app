/**
 * 应用启动。
 *
 * 顺序是固定的，每一步都依赖前一步的产物：
 *   1. 恢复外观设置（在首屏渲染前，避免闪一下浅色）
 *   2. 从 URL fragment 取 token（用过即抹）
 *   3. 拉插件清单 —— 它需要 token
 *   4. 逐个加载插件前端入口
 *   5. 建 WebSocket，进入「可重连」状态
 *   6. 渲染
 *
 * 第 3 步失败要停在启动页：没有清单就没有页面，硬渲染出一个空壳只会让人
 * 误以为插件全坏了。
 */

import { createRoot } from 'react-dom/client'
import type { ReactNode } from 'react'
import './styles.css'
import { App } from './App.js'
import { MANIFEST_PATH, type ClientManifest } from '@cordis-app/protocol/client'
import {
  ClientRuntime,
  RuntimeContext,
  bootstrapToken,
  connect,
  restoreAppearance,
  type Connection,
} from 'cordis-app/client'

async function main(): Promise<void> {
  restoreAppearance()
  const token = bootstrapToken()
  const root = createRoot(document.getElementById('root')!)

  if (!token) {
    root.render(
      <BootError
        title="缺少会话 token"
        detail="请从应用或 CLI 提供的地址打开本页面（地址中带有 token 片段）。"
      />,
    )
    return
  }

  const runtime = new ClientRuntime({ token })

  try {
    await loadAllPlugins(runtime)
  } catch (error) {
    root.render(
      <BootError
        title="无法读取插件清单"
        detail={(error as Error).message}
        onRetry={() => window.location.reload()}
      />,
    )
    return
  }

  const connection = connect(runtime)
  mountStatusBar(connection)

  connection.onReconnected(async () => {
    // 重启后插件可能已增删，重新拉清单并重放加载；旧实例会被逐个替换
    try {
      await loadAllPlugins(runtime)
    } catch (error) {
      console.error('[cordis-app] 重连后刷新插件失败:', error)
    }
  })

  root.render(
    <RuntimeContext.Provider value={runtime}>
      <App />
    </RuntimeContext.Provider>,
  )
}

async function loadAllPlugins(runtime: ClientRuntime): Promise<void> {
  const manifest = await runtime.http.get<ClientManifest>(MANIFEST_PATH, { retries: 3 })
  // 插件之间互不阻塞：一个失败不该让其他插件的页面也消失
  await Promise.all(Object.values(manifest.plugins).map((entry) => runtime.loadPlugin(entry)))
}

/** 重启期间的状态条。挂在 body 上，不参与 React 树，与被等待的页面互不影响。 */
function mountStatusBar(connection: Connection): void {
  const node = document.createElement('div')
  node.className = 'reconnect-bar'
  node.hidden = true
  node.textContent = '正在重连…'
  document.body.appendChild(node)

  connection.onStateChange((state) => {
    if (state === 'ready') {
      node.hidden = true
    } else if (state === 'failed') {
      node.hidden = false
      node.textContent = '与服务的连接已断开，请刷新页面'
    } else {
      node.hidden = false
      node.textContent = '正在重连…'
    }
  })
}

function BootError(props: { title: string; detail: string; onRetry?: () => void }): ReactNode {
  return (
    <div className="boot-error">
      <h1>{props.title}</h1>
      <p>{props.detail}</p>
      {props.onRetry && (
        <button type="button" className="button" onClick={props.onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

void main()
