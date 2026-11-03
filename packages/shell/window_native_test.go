package main

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"
	"unsafe"

	webview "github.com/webview/webview_go"

	"github.com/cordis-app/shell/native"
)

// fakeWindowBackend 是 webview 的测试替身：它记录命令是否被投递到「UI 线程」，
// 并允许测试决定闭包何时执行。
type fakeWindowBackend struct {
	mu            sync.Mutex
	calls         []string
	dispatches    int
	runOnDispatch bool
	pending       []func()
}

func newFakeWindowBackend() *fakeWindowBackend {
	return &fakeWindowBackend{runOnDispatch: true}
}

func (f *fakeWindowBackend) Dispatch(fn func()) {
	f.mu.Lock()
	f.dispatches++
	run := f.runOnDispatch
	if !run {
		f.pending = append(f.pending, fn)
	}
	f.mu.Unlock()
	if run {
		fn()
	}
}

func (f *fakeWindowBackend) Window() unsafe.Pointer { return nil }

func (f *fakeWindowBackend) SetTitle(title string) {
	f.record("SetTitle:" + title)
}

func (f *fakeWindowBackend) SetSize(width, height int, _ webview.Hint) {
	f.record("SetSize:" + strconv.Itoa(width) + "x" + strconv.Itoa(height))
}

func (f *fakeWindowBackend) record(call string) {
	f.mu.Lock()
	f.calls = append(f.calls, call)
	f.mu.Unlock()
}

func (f *fakeWindowBackend) snapshot() (calls []string, dispatches int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...), f.dispatches
}

func TestWindowControllerDispatchesEveryCommandToUIThread(t *testing.T) {
	backend := newFakeWindowBackend()
	controller := newWindowController()
	controller.attach(backend)
	ctx := context.Background()

	if err := controller.SetTitle(ctx, "标题"); err != nil {
		t.Fatalf("SetTitle 失败: %v", err)
	}
	if err := controller.SetSize(ctx, 800, 600); err != nil {
		t.Fatalf("SetSize 失败: %v", err)
	}
	for name, action := range map[string]func(context.Context) error{
		"minimize": controller.Minimize,
		"maximize": controller.Maximize,
		"restore":  controller.Restore,
		"focus":    controller.Focus,
		"close":    controller.Close,
	} {
		if err := action(ctx); err != nil {
			t.Fatalf("%s 失败: %v", name, err)
		}
	}

	calls, dispatches := backend.snapshot()
	if dispatches != 7 {
		t.Fatalf("Dispatch 次数 = %d，期望 7（每个命令一次）", dispatches)
	}
	// 标题与尺寸经由 webview 自身的方法，其余动作在当前平台原语里以 nil
	// 句柄安全返回，因此只断言前两项的调用内容。
	if len(calls) != 2 || calls[0] != "SetTitle:标题" {
		t.Fatalf("calls = %v，期望首项 SetTitle:标题", calls)
	}
}

func TestWindowControllerStateWaitsForUIThreadResult(t *testing.T) {
	backend := newFakeWindowBackend()
	controller := newWindowController()
	controller.attach(backend)

	state, err := controller.State(context.Background())
	if err != nil {
		t.Fatalf("State 失败: %v", err)
	}
	if state != (native.WindowState{}) {
		t.Fatalf("nil 句柄的 state = %+v，期望零值", state)
	}

	_, dispatches := backend.snapshot()
	if dispatches != 1 {
		t.Fatalf("Dispatch 次数 = %d，期望 1", dispatches)
	}
}

func TestWindowControllerDispatchRespectsContextDeadline(t *testing.T) {
	backend := newFakeWindowBackend()
	backend.runOnDispatch = false // 模拟 UI 线程一直没轮到这条命令
	controller := newWindowController()
	controller.attach(backend)

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- controller.Minimize(ctx) }()

	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("错误 = %v，期望 DeadlineExceeded", err)
		}
	case <-time.After(time.Second):
		t.Fatal("命令 goroutine 没有被 ctx 唤醒，可能永久阻塞")
	}
}

func TestWindowControllerWithoutAttachedWindow(t *testing.T) {
	controller := newWindowController()
	if err := controller.Minimize(context.Background()); !errors.Is(err, errWindowUnavailable) {
		t.Fatalf("错误 = %v，期望 errWindowUnavailable", err)
	}
	if _, err := controller.State(context.Background()); !errors.Is(err, errWindowUnavailable) {
		t.Fatalf("State 错误 = %v，期望 errWindowUnavailable", err)
	}

	controller.attach(newFakeWindowBackend())
	controller.detach()
	if err := controller.Minimize(context.Background()); !errors.Is(err, errWindowUnavailable) {
		t.Fatalf("detach 后错误 = %v，期望 errWindowUnavailable", err)
	}
}
