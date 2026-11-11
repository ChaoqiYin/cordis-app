//go:build darwin || windows || linux

package main

import (
	"fmt"
	"os"
	"sync"

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
func runWindow(url string, sh *supervisor, debug bool, title string, nativeWindow *windowController) {
	w := webview.New(debug)
	if w == nil {
		fmt.Fprintln(os.Stderr, "无法创建窗口")
		return
	}
	// 控制器先挂上再开跑：worker 可能在窗口显示前就调用 window.*。
	// defer 后进先出：detach 先于 Destroy，避免命令投递到已销毁的原生窗口。
	nativeWindow.attach(w)
	defer w.Destroy()
	defer nativeWindow.detach()

	// 窗口 chrome 在控制器 attach 之后安装一次：菜单动作要能在窗口销毁后
	// 安全返回 busy。所有运行形态都安装，不区分 dev 与打包形态。
	//
	// 菜单回调由平台在 UI 线程上触发，因此必须直接调用 ReloadOnUIThread：
	// 再从 UI 线程 Dispatch 回 UI 线程会自锁。
	installWindowChrome(func() { _ = nativeWindow.ReloadOnUIThread() })

	// 窗口关闭后 w.Run 返回，但后台 goroutine 可能仍在等待 supervisor 或
	// 激活请求。dispatchWindow 用 closed 标记把投递与 Destroy 串行化：
	// Run 返回后不再向已销毁的 webview 投递（窗口关闭时的 SIGSEGV 来源）。
	var dispatchMu sync.Mutex
	windowClosed := false
	dispatchWindow := func(fn func()) {
		dispatchMu.Lock()
		defer dispatchMu.Unlock()
		if windowClosed {
			return
		}
		w.Dispatch(fn)
	}

	w.SetTitle(title)
	w.SetSize(windowWidth, windowHeight, webview.HintNone)
	w.Navigate(url)

	// supervisor 先退出（崩溃或正常结束）时，窗口不能留在原地：用户会看到
	// 一个永远连不上的页面，却没有任何线索。
	go func() {
		sh.waitExit()
		dispatchWindow(func() {
			w.SetTitle(title + "（服务已停止）")
			w.Eval(`document.body.innerHTML =
				'<div style="font:15px/1.7 -apple-system,Segoe UI,sans-serif;padding:48px;color:#666">' +
				'后台服务已停止，请重新启动应用。</div>'`)
		})
	}()

	// 第二次双击图标：把已有窗口提到前台，而不是再起一个实例。
	go func() {
		for range activateRequest {
			dispatchWindow(func() {
				focusWindow(w.Window())
			})
		}
	}()

	// 事件循环必须占用主线程；webview 包的 init 已经 LockOSThread。
	w.Run()

	// Run 返回即窗口生命周期结束：先挡住后续投递，再让 defer 顺序销毁。
	dispatchMu.Lock()
	windowClosed = true
	dispatchMu.Unlock()
}
