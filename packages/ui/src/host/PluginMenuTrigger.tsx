/**
 * 在 body 自己的元素上触发某个菜单 id。
 *
 * body 不渲染菜单本体——那是 BodyHost 的职责；这里只把 `useMenu(menuId)`
 * 绑到子元素的 `onContextMenu` 上，并保留调用方已有的 handler。
 */

import { Children, cloneElement, type ReactElement, type ReactNode } from 'react'
import { useMenu } from 'cordis-app/client'

interface MenuEvent {
  preventDefault(): void
  clientX: number
  clientY: number
}

type TriggerChild = ReactElement<{ onContextMenu?: (event: MenuEvent) => void }>

export function PluginMenuTrigger(props: {
  menuId: string
  children?: TriggerChild
}): ReactNode {
  const trigger = useMenu(props.menuId)
  // Children.only 在运行时守住「只允许一个元素」，类型上允许 createElement 的第三参数写法
  const child = Children.only(props.children) as TriggerChild
  const existing = child.props.onContextMenu

  return cloneElement(child, {
    onContextMenu: (event: MenuEvent) => {
      existing?.(event)
      trigger(event)
    },
  })
}
