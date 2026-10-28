//go:build linux

package main

/*
#cgo pkg-config: gtk+-3.0
#include <gtk/gtk.h>

static void cordisFocusWindow(void *handle) {
	if (handle == NULL) return;
	gtk_window_present(GTK_WINDOW(handle));
}
*/
import "C"

import "unsafe"

// focusWindow 用 gtk_window_present：它同时负责还原与提层，是 GTK 里
// 「把这个窗口给用户看」的标准语义。
func focusWindow(handle unsafe.Pointer) {
	C.cordisFocusWindow(handle)
}
