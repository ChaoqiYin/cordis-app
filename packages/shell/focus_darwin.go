//go:build darwin

package main

/*
#cgo darwin LDFLAGS: -framework Cocoa
#include <objc/message.h>
#include <objc/runtime.h>

// 用 objc_msgSend 直接发消息，不引入 .m 文件：整个外壳只需要两个消息。
static void cordisFocusWindow(void *handle) {
	if (handle == NULL) return;
	id window = (id)handle;

	id app = ((id (*)(id, SEL))objc_msgSend)(
		(id)objc_getClass("NSApplication"),
		sel_registerName("sharedApplication"));
	((void (*)(id, SEL, BOOL))objc_msgSend)(
		app, sel_registerName("activateIgnoringOtherApps:"), YES);

	((void (*)(id, SEL, id))objc_msgSend)(
		window, sel_registerName("makeKeyAndOrderFront:"), nil);
}
*/
import "C"

import "unsafe"

// focusWindow 把 NSWindow 提到最前。
//
// 必须调用 makeKeyAndOrderFront: 而不只是 activate：前者负责窗口层级，
// 后者只负责应用级激活。只做后者时窗口可能仍在别的窗口下面。
func focusWindow(handle unsafe.Pointer) {
	C.cordisFocusWindow(handle)
}
