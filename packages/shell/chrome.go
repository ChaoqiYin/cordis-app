//go:build darwin || windows || linux

package main

// reloadAction 返回窗口 chrome 的「重新载入」动作。
//
// 菜单回调由平台在 UI 线程上触发，因此这里必须直接调用 ReloadOnUIThread：
// 再从 UI 线程 Dispatch 回 UI 线程会自锁。窗口尚未 attach 或已经销毁时，
// ReloadOnUIThread 返回 busy，动作静默结束，不触碰后端。
func reloadAction(controller *windowController) func() {
	return func() {
		_ = controller.ReloadOnUIThread()
	}
}
