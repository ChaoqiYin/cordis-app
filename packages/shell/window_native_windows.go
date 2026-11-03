//go:build windows

package main

import (
	"unsafe"

	"github.com/cordis-app/shell/native"
)

// user32 与 procShowWindow / procSetForegroundWindow / swRestore 在
// focus_windows.go 中声明；窗口命令复用同一组系统调用。
var (
	procPostMessage   = user32.NewProc("PostMessageW")
	procIsZoomed      = user32.NewProc("IsZoomed")
	procIsIconic      = user32.NewProc("IsIconic")
	procGetForeground = user32.NewProc("GetForegroundWindow")
	procGetWindowRect = user32.NewProc("GetWindowRect")
)

const (
	swMinimize = 6
	swMaximize = 3
	wmClose    = 0x0010
)

// winRect 对应 Win32 的 RECT。
type winRect struct {
	Left   int32
	Top    int32
	Right  int32
	Bottom int32
}

func platformWindowMinimize(handle unsafe.Pointer) {
	if handle == nil {
		return
	}
	_, _, _ = procShowWindow.Call(uintptr(handle), swMinimize)
}

func platformWindowMaximize(handle unsafe.Pointer) {
	if handle == nil {
		return
	}
	_, _, _ = procShowWindow.Call(uintptr(handle), swMaximize)
}

func platformWindowRestore(handle unsafe.Pointer) {
	if handle == nil {
		return
	}
	_, _, _ = procShowWindow.Call(uintptr(handle), swRestore)
}

// platformWindowFocus 只把窗口带到前台；仅当窗口处于最小化时才 SW_RESTORE。
//
// 不能无条件用现有的 focusWindow：ShowWindow(SW_RESTORE) 会把最大化的窗口
// 一并还原，而 focus 不应改变最大化状态。
func platformWindowFocus(handle unsafe.Pointer) {
	if handle == nil {
		return
	}
	hwnd := uintptr(handle)
	if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
		_, _, _ = procShowWindow.Call(hwnd, swRestore)
	}
	_, _, _ = procSetForegroundWindow.Call(hwnd)
}

func platformWindowClose(handle unsafe.Pointer) {
	if handle == nil {
		return
	}
	// 与点击关闭按钮走同一条消息，让 webview 的关闭流程处理循环退出。
	_, _, _ = procPostMessage.Call(uintptr(handle), wmClose, 0, 0)
}

func platformWindowState(handle unsafe.Pointer) native.WindowState {
	if handle == nil {
		return native.WindowState{}
	}
	hwnd := uintptr(handle)

	zoomed, _, _ := procIsZoomed.Call(hwnd)
	iconic, _, _ := procIsIconic.Call(hwnd)
	foreground, _, _ := procGetForeground.Call()

	var rect winRect
	gotRect, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect)))
	size := native.WindowSize{}
	if gotRect != 0 {
		size.Width = int(rect.Right - rect.Left)
		size.Height = int(rect.Bottom - rect.Top)
	}

	return native.WindowState{
		Maximized: zoomed != 0,
		Minimized: iconic != 0,
		Focused:   foreground == hwnd,
		Size:      size,
	}
}
