//go:build darwin

package main

import "C"

import "sync"

// chromeReload 保存菜单「重新载入」动作。安装发生在 UI 线程、回调也运行在
// UI 线程，但仍用锁保护，避免将来安装与触发跨线程时出现数据竞争。
var (
	chromeReloadMu sync.RWMutex
	chromeReloadFn func()
)

func setChromeReload(fn func()) {
	chromeReloadMu.Lock()
	chromeReloadFn = fn
	chromeReloadMu.Unlock()
}

// cordisReloadCallback 由 ObjC 菜单动作在 UI 线程上调用，直接执行重新载入，
// 不再 Dispatch 回 UI 线程。
//
//export cordisReloadCallback
func cordisReloadCallback() {
	chromeReloadMu.RLock()
	fn := chromeReloadFn
	chromeReloadMu.RUnlock()
	if fn != nil {
		fn()
	}
}
