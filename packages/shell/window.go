//go:build darwin || windows || linux

package main

import (
	"fmt"
	"os"

	webview "github.com/webview/webview_go"
)

// windowTitle 与 index.html 的 <title> 保持一致。
const windowTitle = "cordis-app"

// windowWidth / windowHeight 是首次打开时的默认尺寸。
const (
	windowWidth  = 1280
	windowHeight = 832
)

// activateRequest 用容量 1 的通道做「有则合并」：用户连点五次图标，
// 提一次就够了，积压五次要前台化没有意义。
var activateRequest = make(chan struct{}, 1)

// activateWindow 由单实例监听在收到第二个实例的激活请求时调用。
func activateWindow() {
	select {
	case activateRequest <- struct{}{}:
	default:
	}
}

// runWindow 开窗并进入事件循环，直到窗口关闭或 supervisor 退出。
//
// 外壳不做任何导航拦截或注入：页面就是普通的网页，它唯一知道的东西是 URL。
func runWindow(url string, sh *supervisor, debug bool) {
	w := webview.New(debug)
	if w == nil {
		fmt.Fprintln(os.Stderr, "无法创建窗口")
		return
	}
	defer w.Destroy()

	w.SetTitle(windowTitle)
	w.SetSize(windowWidth, windowHeight, webview.HintNone)
	w.Navigate(url)

	// supervisor 先退出（崩溃或正常结束）时，窗口不能留在原地：用户会看到
	// 一个永远连不上的页面，却没有任何线索。
	go func() {
		sh.waitExit()
		w.Dispatch(func() {
			w.SetTitle(windowTitle + "（服务已停止）")
			w.Eval(`document.body.innerHTML =
				'<div style="font:15px/1.7 -apple-system,Segoe UI,sans-serif;padding:48px;color:#666">' +
				'后台服务已停止，请重新启动应用。</div>'`)
		})
	}()

	// 第二次双击图标：把已有窗口提到前台，而不是再起一个实例。
	go func() {
		for range activateRequest {
			w.Dispatch(func() {
				focusWindow(w.Window())
			})
		}
	}()

	// 事件循环必须占用主线程；webview 包的 init 已经 LockOSThread。
	w.Run()
}
