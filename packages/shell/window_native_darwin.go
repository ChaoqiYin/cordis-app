//go:build darwin

package main

/*
#cgo darwin LDFLAGS: -framework Cocoa
#include <CoreGraphics/CoreGraphics.h>
#include <objc/message.h>
#include <objc/runtime.h>

// 所有窗口操作都通过 objc_msgSend 直接发消息，不引入 .m 文件；窗口句柄来自
// webview_go 的 Window()，即 NSWindow*。

static BOOL cordisIsMiniaturized(id window) {
	return ((BOOL (*)(id, SEL))objc_msgSend)(window, sel_registerName("isMiniaturized"));
}

static BOOL cordisIsZoomed(id window) {
	return ((BOOL (*)(id, SEL))objc_msgSend)(window, sel_registerName("isZoomed"));
}

// cancelPendingZoom 取消 maximize 在恢复动画后排队执行的 zoom:。
//
// 窗口在 deminiaturize: 的动画中直接 zoom: 会被 AppKit 丢弃，因此 maximize
// 把 zoom: 排到下一轮 run loop。期间用户又调用 minimize/restore/close 时，
// 必须撤销排队动作，否则窗口状态会在命令返回后自行改变。
static void cordisCancelPendingZoom(id window) {
	((void (*)(id, SEL, id, SEL, id))objc_msgSend)(
		(id)objc_getClass("NSObject"),
		sel_registerName("cancelPreviousPerformRequestsWithTarget:selector:object:"),
		window, sel_registerName("zoom:"), nil);
}

static void cordisWindowMinimize(void *handle) {
	if (handle == NULL) return;
	cordisCancelPendingZoom((id)handle);
	((void (*)(id, SEL, id))objc_msgSend)(
		(id)handle, sel_registerName("miniaturize:"), nil);
}

static void cordisWindowMaximize(void *handle) {
	if (handle == NULL) return;
	id window = (id)handle;
	cordisCancelPendingZoom(window);
	if (cordisIsMiniaturized(window)) {
		((void (*)(id, SEL, id))objc_msgSend)(
			window, sel_registerName("deminiaturize:"), nil);
		// 恢复动画期间 zoom: 会被丢弃；排到下一轮 run loop 再最大化。
		if (!cordisIsZoomed(window)) {
			((void (*)(id, SEL, SEL, id, double))objc_msgSend)(
				window,
				sel_registerName("performSelector:withObject:afterDelay:"),
				sel_registerName("zoom:"),
				nil,
				0.2);
		}
		return;
	}
	// zoom: 是切换语义，已最大化时再发一次会还原，因此必须先判断。
	if (!cordisIsZoomed(window)) {
		((void (*)(id, SEL, id))objc_msgSend)(
			window, sel_registerName("zoom:"), nil);
	}
}

static void cordisWindowRestore(void *handle) {
	if (handle == NULL) return;
	id window = (id)handle;
	cordisCancelPendingZoom(window);
	if (cordisIsMiniaturized(window)) {
		((void (*)(id, SEL, id))objc_msgSend)(
			window, sel_registerName("deminiaturize:"), nil);
	}
	if (cordisIsZoomed(window)) {
		((void (*)(id, SEL, id))objc_msgSend)(
			window, sel_registerName("zoom:"), nil);
	}
}

static void cordisWindowClose(void *handle) {
	if (handle == NULL) return;
	cordisCancelPendingZoom((id)handle);
	((void (*)(id, SEL, id))objc_msgSend)(
		(id)handle, sel_registerName("performClose:"), nil);
}

static int cordisWindowIsZoomed(void *handle) {
	if (handle == NULL) return 0;
	return cordisIsZoomed((id)handle) ? 1 : 0;
}

static int cordisWindowIsMiniaturized(void *handle) {
	if (handle == NULL) return 0;
	return cordisIsMiniaturized((id)handle) ? 1 : 0;
}

static int cordisWindowIsKey(void *handle) {
	if (handle == NULL) return 0;
	return ((BOOL (*)(id, SEL))objc_msgSend)(
		(id)handle, sel_registerName("isKeyWindow")) ? 1 : 0;
}

static void cordisWindowSize(void *handle, int *width, int *height) {
	if (handle == NULL) {
		*width = 0;
		*height = 0;
		return;
	}
	CGRect frame = ((CGRect (*)(id, SEL))objc_msgSend)(
		(id)handle, sel_registerName("frame"));
	*width = (int)frame.size.width;
	*height = (int)frame.size.height;
}
*/
import "C"

import (
	"unsafe"

	"github.com/cordis-app/shell/native"
)

func platformWindowMinimize(handle unsafe.Pointer) {
	C.cordisWindowMinimize(handle)
}

func platformWindowMaximize(handle unsafe.Pointer) {
	C.cordisWindowMaximize(handle)
}

func platformWindowRestore(handle unsafe.Pointer) {
	C.cordisWindowRestore(handle)
}

// platformWindowFocus 复用现有的前台化实现：makeKeyAndOrderFront + 激活应用。
// 它不会改变最大化状态。
func platformWindowFocus(handle unsafe.Pointer) {
	focusWindow(handle)
}

func platformWindowClose(handle unsafe.Pointer) {
	C.cordisWindowClose(handle)
}

func platformWindowState(handle unsafe.Pointer) native.WindowState {
	var width, height C.int
	C.cordisWindowSize(handle, &width, &height)
	return native.WindowState{
		Maximized: C.cordisWindowIsZoomed(handle) != 0,
		Minimized: C.cordisWindowIsMiniaturized(handle) != 0,
		Focused:   C.cordisWindowIsKey(handle) != 0,
		Size: native.WindowSize{
			Width:  int(width),
			Height: int(height),
		},
	}
}
