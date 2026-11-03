package native

import (
	"context"
	"encoding/json"
	"errors"
	"math"
)

// WindowSize 是 window.state 返回的窗口尺寸，对应 protocol 的 NativeWindowSize。
// 测量基准由各平台原生实现决定：darwin 用 NSWindow frame，windows 用
// GetWindowRect，linux 用 gtk_window_get_size。
type WindowSize struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// WindowState 是 window.state 的返回，对应 protocol 的 NativeWindowState。
//
// focused 的语义统一为「本窗口是否为当前活动窗口」：darwin 用 isKeyWindow，
// windows 用 GetForegroundWindow 与 HWND 比较，linux 用 gtk_window_is_active。
type WindowState struct {
	Maximized bool       `json:"maximized"`
	Minimized bool       `json:"minimized"`
	Focused   bool       `json:"focused"`
	Size      WindowSize `json:"size"`
}

// Window 是外壳窗口的原语接口。实现方负责把每个调用投递到 UI 线程；
// native 包只做参数校验、命令分派与错误映射，不依赖具体 UI 框架。
//
// 方法必须尊重 ctx：UI 线程不可用时返回错误，不能永久阻塞命令 goroutine。
type Window interface {
	SetTitle(ctx context.Context, title string) error
	SetSize(ctx context.Context, width, height int) error
	Minimize(ctx context.Context) error
	Maximize(ctx context.Context) error
	Restore(ctx context.Context) error
	Focus(ctx context.Context) error
	Close(ctx context.Context) error
	State(ctx context.Context) (WindowState, error)
}

type windowSetTitleInput struct {
	Title *string `json:"title"`
}

type windowSetSizeInput struct {
	Width  *int `json:"width"`
	Height *int `json:"height"`
}

// registerWindow 注册全部 window.* 命令。
//
// 没有窗口（--url 降级模式）时不注册：server 的 dispatch 会把契约里已知但
// 未注册的命令统一映射成 unsupported，调用方无需区分具体原因。
func registerWindow(reg *Registry, opts Options) {
	if !opts.HasWindow || opts.Window == nil {
		return
	}
	window := opts.Window

	reg.Register(CommandWindowSetTitle, func(ctx context.Context, input json.RawMessage) (any, error) {
		var in windowSetTitleInput
		if err := decodeInput(input, &in); err != nil {
			return nil, err
		}
		if in.Title == nil {
			return nil, &Error{Code: CodeInvalid, Message: "title 必须是字符串"}
		}
		if err := window.SetTitle(ctx, *in.Title); err != nil {
			return nil, windowError(err)
		}
		return struct{}{}, nil
	})

	reg.Register(CommandWindowSetSize, func(ctx context.Context, input json.RawMessage) (any, error) {
		var in windowSetSizeInput
		if err := decodeInput(input, &in); err != nil {
			return nil, err
		}
		if in.Width == nil || in.Height == nil {
			return nil, &Error{Code: CodeInvalid, Message: "width 与 height 必须是整数"}
		}
		if *in.Width <= 0 || *in.Height <= 0 {
			return nil, &Error{Code: CodeInvalid, Message: "width 与 height 必须为正数"}
		}
		// webview_go 最终把尺寸转成 C.int；超出范围会在原生侧截断。
		if *in.Width > math.MaxInt32 || *in.Height > math.MaxInt32 {
			return nil, &Error{Code: CodeInvalid, Message: "width 与 height 超出支持范围"}
		}
		if err := window.SetSize(ctx, *in.Width, *in.Height); err != nil {
			return nil, windowError(err)
		}
		return struct{}{}, nil
	})

	actions := []struct {
		name   string
		action func(context.Context) error
	}{
		{name: CommandWindowMinimize, action: window.Minimize},
		{name: CommandWindowMaximize, action: window.Maximize},
		{name: CommandWindowRestore, action: window.Restore},
		{name: CommandWindowFocus, action: window.Focus},
		{name: CommandWindowClose, action: window.Close},
	}
	for _, action := range actions {
		action := action
		reg.Register(action.name, func(ctx context.Context, _ json.RawMessage) (any, error) {
			if err := action.action(ctx); err != nil {
				return nil, windowError(err)
			}
			return struct{}{}, nil
		})
	}

	reg.Register(CommandWindowState, func(ctx context.Context, _ json.RawMessage) (any, error) {
		state, err := window.State(ctx)
		if err != nil {
			return nil, windowError(err)
		}
		return state, nil
	})
}

// windowError 把窗口实现的错误映射成业务错误码。平台实现通常直接返回
// ctx.Err() 或 *Error；其它错误没有更具体的语义，归为 internal。
func windowError(err error) *Error {
	var nativeErr *Error
	if errors.As(err, &nativeErr) && nativeErr != nil {
		return nativeErr
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return &Error{Code: CodeTimeout, Message: "等待 UI 线程处理窗口命令超时"}
	}
	if errors.Is(err, context.Canceled) {
		return &Error{Code: CodeInternal, Message: "窗口命令已取消"}
	}
	return &Error{Code: CodeInternal, Message: err.Error()}
}
