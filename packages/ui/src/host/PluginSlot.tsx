/**
 * 具名插槽出口。
 *
 * body 决定插槽放在布局的哪个位置；插件只声明 `type`。每个插槽项单独包
 * 错误边界，一个插件组件崩溃不会连带清空同一插槽里的其他项。
 */

import type { ComponentType, ReactNode } from 'react'
import { useSlots } from 'cordis-app/client'
import { ErrorBoundary } from './ErrorBoundary.js'

export function PluginSlot(props: { name: string; className?: string }): ReactNode {
  const slots = useSlots(props.name)
  if (slots.length === 0) return null

  return (
    <div className={props.className} data-slot={props.name}>
      {slots.map((slot, index) => {
        const Component = slot.component as ComponentType
        return (
          <ErrorBoundary pluginId={slot.pluginId} key={`${slot.pluginId}-${slot.seq}-${index}`}>
            <Component />
          </ErrorBoundary>
        )
      })}
    </div>
  )
}
