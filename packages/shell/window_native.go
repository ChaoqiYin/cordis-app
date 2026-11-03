//go:build darwin || windows || linux

package main

import (
	"context"
	"errors"
	"sync"
	"unsafe"

	webview "github.com/webview/webview_go"

	"github.com/cordis-app/shell/native"
)

// errWindowUnavailable 表示窗口还没创建或已经销毁。它只会在启动与退出
// 的短暂窗口内出现，映射到 internal，而不是假装能力缺失。
var errWindowUnavailable = errors.New("窗口尚未创建")

// windowBackend 是窗口控制器依赖的 webview 子集。抽出接口是为了让 Dispatch
// 的投递与等待语义可以在测试里观察，不需要真的开一个窗口。
type windowBackend interface {
	Dispatch(f func())
	Window() unsafe.Pointer
	SetTitle(title string)
	SetSize(width, height int, hint webview.Hint)
}

// windowController 把 native.Window 的实现接到 webview 的 UI 线程上。
//
// native server 的 handler 跑在 HTTP goroutine 里，而 Cocoa/GTK/Win32 都要求
// 窗口操作发生在 UI 线程；所有动作与状态读取都经 Dispatch 投递。handler
// 自己阻塞在完成通道上不会阻塞 w.Run()，因为 UI 线程只执行实际的原生调用。
type windowController struct {
	mu      sync.RWMutex
	backend windowBackend
}

func newWindowController() *windowController {
	return &windowController{}
}

// attach 在窗口创建后调用；detach 必须在 Destroy 之前调用，避免命令投递到
// 已经销毁的原生窗口。
func (c *windowController) attach(backend windowBackend) {
	c.mu.Lock()
	c.backend = backend
	c.mu.Unlock()
}

func (c *windowController) detach() {
	c.mu.Lock()
	c.backend = nil
	c.mu.Unlock()
}

// dispatch 把 fn 投递到 UI 线程，并等待它执行完毕或 ctx 结束。等待只发生在
// 调用方线程，不占用 UI 线程。
func (c *windowController) dispatch(ctx context.Context, fn func(windowBackend)) error {
	c.mu.RLock()
	backend := c.backend
	c.mu.RUnlock()
	if backend == nil {
		return errWindowUnavailable
	}

	done := make(chan struct{})
	backend.Dispatch(func() {
		defer close(done)
		fn(backend)
	})

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *windowController) SetTitle(ctx context.Context, title string) error {
	return c.dispatch(ctx, func(backend windowBackend) {
		backend.SetTitle(title)
	})
}

func (c *windowController) SetSize(ctx context.Context, width, height int) error {
	return c.dispatch(ctx, func(backend windowBackend) {
		backend.SetSize(width, height, webview.HintNone)
	})
}

func (c *windowController) Minimize(ctx context.Context) error {
	return c.dispatch(ctx, func(backend windowBackend) {
		platformWindowMinimize(backend.Window())
	})
}

func (c *windowController) Maximize(ctx context.Context) error {
	return c.dispatch(ctx, func(backend windowBackend) {
		platformWindowMaximize(backend.Window())
	})
}

func (c *windowController) Restore(ctx context.Context) error {
	return c.dispatch(ctx, func(backend windowBackend) {
		platformWindowRestore(backend.Window())
	})
}

func (c *windowController) Focus(ctx context.Context) error {
	return c.dispatch(ctx, func(backend windowBackend) {
		platformWindowFocus(backend.Window())
	})
}

func (c *windowController) Close(ctx context.Context) error {
	return c.dispatch(ctx, func(backend windowBackend) {
		platformWindowClose(backend.Window())
	})
}

func (c *windowController) State(ctx context.Context) (native.WindowState, error) {
	result := make(chan native.WindowState, 1)
	err := c.dispatch(ctx, func(backend windowBackend) {
		result <- platformWindowState(backend.Window())
	})
	if err != nil {
		return native.WindowState{}, err
	}
	// dispatch 只在闭包执行完毕后返回，因此这里不会阻塞。
	return <-result, nil
}

// 编译期确认控制器满足 native 包契约。
var _ native.Window = (*windowController)(nil)
