//go:build windows

package main

// installWindowChrome 在 Windows 上暂为空实现：真实菜单与 Ctrl+R 留给后续
// 平台实现。保留接线点只是为了所有平台共享同一套窗口生命周期。
func installWindowChrome(backend windowBackend, reload func()) {}
