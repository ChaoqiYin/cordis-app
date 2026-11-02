/**
 * 宿主提供的统一错误边界。
 *
 * 插件页面、插槽、默认 body 各自包一层：一个组件崩溃只影响它自己。
 * SSR 下 `componentDidCatch` 不会执行，但渲染路径本身不需要 DOM。
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** 插件 id；有值时错误文案会指出是哪个插件 */
  pluginId?: string
  /** 自定义标题，覆盖默认文案 */
  title?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const owner = this.props.pluginId ? `插件 ${this.props.pluginId}` : '应用'
    console.error(`[cordis-app] ${owner} 渲染失败:`, error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="notice notice-error">
        <strong>{this.props.title ?? this.title()}</strong>
        <p>{this.state.error.message}</p>
        <button type="button" className="button" onClick={() => this.setState({ error: null })}>
          重试
        </button>
      </div>
    )
  }

  private title(): string {
    return this.props.pluginId ? `插件 ${this.props.pluginId} 渲染失败` : '应用渲染失败'
  }
}
