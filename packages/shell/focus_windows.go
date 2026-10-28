//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

var (
	user32                  = syscall.NewLazyDLL("user32.dll")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
)

// swRestore 把最小化的窗口还原。
const swRestore = 9

// focusWindow 把 HWND 提到最前。
//
// 只 SetForegroundWindow 不够：窗口若最小化，它会被激活但仍是图标状态。
// 先 ShowWindow(SW_RESTORE) 再前置，才是用户按下图标期望看到的结果。
func focusWindow(handle unsafe.Pointer) {
	if handle == nil {
		return
	}
	hwnd := uintptr(handle)
	_, _, _ = procShowWindow.Call(hwnd, swRestore)
	_, _, _ = procSetForegroundWindow.Call(hwnd)
}
