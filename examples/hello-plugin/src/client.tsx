/**
 * hello 插件的前端入口。
 *
 * 边界规则（架构文档 5.3）：命令式 API 只在入口处调用一次用于注册；组件内部
 * 一律用 Hooks。所以 `ctx.page` 在 activate 里调用，页面组件里只用
 * `usePluginData` 与普通 React Hooks。
 *
 * `cordis-app/client` 与 `react` 都是 external：浏览器经 import map 拿到框架
 * 提供的那一份实例。插件自己的依赖会被打进本文件，不需要额外分发。
 */

import { useEffect, useState } from 'react'
import { usePluginData, type ClientContext } from 'cordis-app/client'

interface HelloData {
  greeting?: string
}

interface HelloResponse {
  greeting: string
  visits: number
}

export default function activate(ctx: ClientContext) {
  /**
   * 组件定义在 activate 内部，才能闭包拿到 `ctx.http`。
   *
   * 这样是安全的：activate 每个插件只执行一次，组件引用在多次渲染之间保持
   * 不变，不会触发 React 的「组件类型每次渲染都不同」导致的整树重挂。
   */
  function HelloPage() {
    const data = usePluginData<HelloData>('hello')
    const [response, setResponse] = useState<HelloResponse>()
    const [error, setError] = useState<string>()

    useEffect(() => {
      let cancelled = false
      // ctx.http 自动附加 token，插件不碰 Authorization 头
      ctx.http.get<HelloResponse>('/api/hello').then(
        (value) => {
          if (!cancelled) setResponse(value)
        },
        (reason: unknown) => {
          if (!cancelled) setError((reason as Error).message)
        },
      )
      return () => {
        cancelled = true
      }
    }, [])

    return (
      <div style={{ padding: '32px 40px', maxWidth: 720, lineHeight: 1.7 }}>
        <h1 style={{ margin: '0 0 8px', fontSize: 24 }}>{data?.greeting ?? '你好'}</h1>
        <p style={{ margin: '0 0 24px', opacity: 0.75 }}>
          这一页由 hello 插件的服务端入口与前端入口共同提供。
        </p>

        {error ? (
          <p style={{ color: '#e5484d' }}>请求失败：{error}</p>
        ) : response ? (
          <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', margin: 0 }}>
            <dt style={{ opacity: 0.6 }}>服务端问候</dt>
            <dd style={{ margin: 0 }}>{response.greeting}</dd>
            <dt style={{ opacity: 0.6 }}>本插件被访问</dt>
            <dd style={{ margin: 0 }}>{response.visits} 次</dd>
            <dt style={{ opacity: 0.6 }}>数据存放</dt>
            <dd style={{ margin: 0 }}>instances/default/data/hello/</dd>
          </dl>
        ) : (
          <p style={{ opacity: 0.6 }}>正在请求服务端…</p>
        )}
      </div>
    )
  }

  ctx.page({
    path: '/hello',
    name: 'Hello',
    icon: 'puzzle',
    component: HelloPage,
  })
}
