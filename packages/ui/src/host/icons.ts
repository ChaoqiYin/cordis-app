/**
 * 内置图标集。
 *
 * 插件只写图标名（`icon: 'palette'`），具体图形由框架决定——这样插件不必
 * 打包图标库，也保证视觉风格统一。找不到名字时用一个中性占位，而不是空白：
 * 空白会让人以为插件坏了。
 */

import { createElement, type ReactNode } from 'react'

const PATHS: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z',
  palette:
    'M12 3a9 9 0 1 0 0 18h1.5a2.5 2.5 0 0 0 0-5H13a2 2 0 0 1 0-4h4a4 4 0 0 0 0-8zM7.5 9a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5m4-2a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8.4 4a8.4 8.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a8 8 0 0 0-2-1.2L15.5 3h-4l-.4 2.6a8 8 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a8.4 8.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a8 8 0 0 0 2 1.2l.4 2.6h4l.4-2.6a8 8 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6a8.4 8.4 0 0 0 .1-1.2',
  puzzle:
    'M9 3a2 2 0 0 1 2 2v1h2V5a2 2 0 1 1 4 0v1h2a2 2 0 0 1 2 2v2h-1a2 2 0 1 0 0 4h1v2a2 2 0 0 1-2 2h-2v-1a2 2 0 1 0-4 0v1h-2a2 2 0 0 1-2-2v-2H8a2 2 0 1 1 0-4h1V7a2 2 0 0 1 2-2h1V5a2 2 0 0 1 2-2',
  terminal: 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1m3 5 3 3-3 3m6 0h4',
  file: 'M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2m7 1v5h5',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1m-1 6a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
}

export function hasIcon(name: string): boolean {
  return name in PATHS
}

/** 描边风格，16×16 网格，`currentColor` 跟随文字色。 */
export function Icon(props: { name?: string; size?: number; className?: string }): ReactNode {
  const path = props.name ? PATHS[props.name] : undefined
  const size = props.size ?? 16
  if (!path) return createElement('span', { className: props.className, style: { width: size, height: size } })
  return createElement(
    'svg',
    {
      className: props.className,
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.75,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    createElement('path', { d: path }),
  )
}
