/**
 * 外观接口。
 *
 * 外壳能力不对外开放，唯一例外是这个范围极窄的外观接口。浏览器模式下
 * 这些调用同样生效（改的是页面自己的 CSS 变量），不会造成功能缺失。
 */

const THEME_KEY = 'cordis-app/theme'

export type Theme = 'dark' | 'light' | 'auto'

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'auto') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // 隐私模式下忽略
  }
}

export function applyAccent(color: string): void {
  const root = document.documentElement
  root.style.setProperty('--accent', color)
  try {
    localStorage.setItem('cordis-app/accent', color)
  } catch {
    // 忽略
  }
}

/** 启动时恢复上次的外观设置。 */
export function restoreAppearance(): Theme {
  let theme: Theme = 'auto'
  try {
    theme = (localStorage.getItem(THEME_KEY) as Theme) ?? 'auto'
    const accent = localStorage.getItem('cordis-app/accent')
    if (accent) document.documentElement.style.setProperty('--accent', accent)
  } catch {
    // 忽略
  }
  applyTheme(theme)
  return theme
}
