package main

import "testing"

// 菜单回调已经在 UI 线程上，动作必须直接走 ReloadOnUIThread：再 Dispatch
// 回 UI 线程会自锁，所以这里断言只执行脚本、没有额外投递。
func TestReloadActionReloadsOnUIThreadWithoutDispatch(t *testing.T) {
	backend := newFakeWindowBackend()
	controller := newWindowController()
	controller.attach(backend)

	reloadAction(controller)()

	evals := backend.evalSnapshot()
	if len(evals) != 1 || evals[0] != "location.reload()" {
		t.Fatalf("Eval 调用 = %v，期望只执行一次 location.reload()", evals)
	}
	if _, dispatches := backend.snapshot(); dispatches != 0 {
		t.Fatalf("Dispatch 次数 = %d，期望 0（菜单回调已在 UI 线程）", dispatches)
	}
}

// 窗口未 attach 或已销毁时，菜单动作只能静默失败：既不能 panic，也不能
// 触碰已经销毁的后端。
func TestReloadActionIsSafeAfterWindowDestroyed(t *testing.T) {
	controller := newWindowController()

	reloadAction(controller)()

	backend := newFakeWindowBackend()
	controller.attach(backend)
	controller.detach()

	reloadAction(controller)()

	if evals := backend.evalSnapshot(); len(evals) != 0 {
		t.Fatalf("窗口销毁后仍触碰了后端: %v", evals)
	}
}
