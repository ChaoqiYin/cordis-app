/**
 * 右键菜单的渲染端。
 *
 * 与触发分离：插件用 `useMenu(id)` 拿下触发器，菜单本体由框架统一渲染。
 * 这样菜单的定位、关闭行为、边缘翻转只需要写一次，插件拿到的是一致体验。
 */

import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './icons.js'
import { useMenuAction, useMenuItems, useMenuState, useRuntime } from 'cordis-app/client'

const MARGIN = 8

export function ContextMenu(): ReactNode {
  const runtime = useRuntime()
  const state = useMenuState()
  const items = useMenuItems(state?.menuId ?? null)
  const run = useMenuAction()
  const ref = useRef<HTMLDivElement>(null)

  /** 贴着点击位置展开；靠近视口边缘时翻到另一侧，避免被裁掉。 */
  useEffect(() => {
    const node = ref.current
    if (!node || !state) return
    const rect = node.getBoundingClientRect()
    let left = state.x
    let top = state.y
    if (left + rect.width + MARGIN > window.innerWidth) left = Math.max(MARGIN, state.x - rect.width)
    if (top + rect.height + MARGIN > window.innerHeight) top = Math.max(MARGIN, state.y - rect.height)
    node.style.left = `${left}px`
    node.style.top = `${top}px`
    node.style.visibility = 'visible'
  }, [state, items.length])

  /** Esc 与窗口失焦/滚动都要关闭；滚动后菜单会飘在原处，关掉比重新定位更符合预期。 */
  useEffect(() => {
    if (!state) return
    const close = () => runtime.closeMenu()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [state, runtime])

  if (!state || items.length === 0) return null

  const close = () => runtime.closeMenu()

  return (
    <>
      {/* 透明遮罩承担「点外面关闭」，插件不需要参与关闭逻辑 */}
      <div
        className="menu-scrim"
        onClick={close}
        onContextMenu={(event) => {
          event.preventDefault()
          close()
        }}
      />
      <div
        ref={ref}
        className="menu"
        role="menu"
        style={{ left: state.x, top: state.y, visibility: 'hidden' }}
      >
        {items.map((item, index) =>
          item.kind === 'separator' ? (
            <div key={`separator-${item.seq}-${index}`} className="menu-separator" role="separator" />
          ) : (
            <button
              key={`${item.id}-${index}`}
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={item.disabled}
              onClick={() => {
                close()
                run(item.id)
              }}
            >
              <Icon name={item.icon} className="menu-item-icon" />
              <span className="menu-item-label">{item.label ?? item.id}</span>
            </button>
          ),
        )}
      </div>
    </>
  )
}
