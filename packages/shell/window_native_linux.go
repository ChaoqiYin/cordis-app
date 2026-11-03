//go:build linux

package main

/*
#cgo pkg-config: gtk+-3.0
#include <gtk/gtk.h>

// 窗口句柄来自 webview_go 的 Window()，即 GtkWindow*。

static void cordisWindowMinimize(void *handle) {
	if (handle == NULL) return;
	gtk_window_iconify(GTK_WINDOW(handle));
}

static void cordisWindowMaximize(void *handle) {
	if (handle == NULL) return;
	gtk_window_maximize(GTK_WINDOW(handle));
}

static void cordisWindowRestore(void *handle) {
	if (handle == NULL) return;
	GtkWindow *window = GTK_WINDOW(handle);
	if (gtk_window_is_maximized(window)) {
		gtk_window_unmaximize(window);
	}
	gtk_window_deiconify(window);
}

static void cordisWindowClose(void *handle) {
	if (handle == NULL) return;
	gtk_window_close(GTK_WINDOW(handle));
}

static void cordisWindowState(
	void *handle, int *maximized, int *minimized, int *focused,
	int *width, int *height) {
	if (handle == NULL) {
		*maximized = 0;
		*minimized = 0;
		*focused = 0;
		*width = 0;
		*height = 0;
		return;
	}
	GtkWindow *window = GTK_WINDOW(handle);
	*maximized = gtk_window_is_maximized(window) ? 1 : 0;
	*focused = gtk_window_is_active(window) ? 1 : 0;

	// GTK3 没有 gtk_window_is_minimized；图标化状态记录在 GdkWindow 上。
	*minimized = 0;
	GdkWindow *gdkWindow = gtk_widget_get_window(GTK_WIDGET(window));
	if (gdkWindow != NULL) {
		*minimized =
			(gdk_window_get_state(gdkWindow) & GDK_WINDOW_STATE_ICONIFIED) ? 1 : 0;
	}

	gtk_window_get_size(window, width, height);
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

// platformWindowFocus 复用 gtk_window_present：最小化时还原，正常/最大化时
// 只提层，不改窗口状态。
func platformWindowFocus(handle unsafe.Pointer) {
	focusWindow(handle)
}

func platformWindowClose(handle unsafe.Pointer) {
	C.cordisWindowClose(handle)
}

func platformWindowState(handle unsafe.Pointer) native.WindowState {
	var maximized, minimized, focused, width, height C.int
	C.cordisWindowState(handle, &maximized, &minimized, &focused, &width, &height)
	return native.WindowState{
		Maximized: maximized != 0,
		Minimized: minimized != 0,
		Focused:   focused != 0,
		Size: native.WindowSize{
			Width:  int(width),
			Height: int(height),
		},
	}
}
