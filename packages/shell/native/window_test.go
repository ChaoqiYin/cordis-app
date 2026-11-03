package native_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"reflect"
	"strconv"
	"sync"
	"testing"

	"github.com/cordis-app/shell/native"
)

// fakeWindow 记录窗口原语的调用，并允许测试指定状态与错误。它替代真实
// webview 窗口，使命令分派、参数校验与输出形状都能在无 UI 的地方验证。
type fakeWindow struct {
	mu    sync.Mutex
	calls []string
	state native.WindowState
	err   error
}

func (f *fakeWindow) record(call string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	return f.err
}

func (f *fakeWindow) recorded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeWindow) SetTitle(_ context.Context, title string) error {
	return f.record("SetTitle:" + title)
}

func (f *fakeWindow) SetSize(_ context.Context, width, height int) error {
	return f.record("SetSize:" + strconv.Itoa(width) + "x" + strconv.Itoa(height))
}

func (f *fakeWindow) Minimize(context.Context) error { return f.record("Minimize") }
func (f *fakeWindow) Maximize(context.Context) error { return f.record("Maximize") }
func (f *fakeWindow) Restore(context.Context) error  { return f.record("Restore") }
func (f *fakeWindow) Focus(context.Context) error    { return f.record("Focus") }
func (f *fakeWindow) Close(context.Context) error    { return f.record("Close") }

func (f *fakeWindow) State(context.Context) (native.WindowState, error) {
	if err := f.record("State"); err != nil {
		return native.WindowState{}, err
	}
	return f.state, nil
}

// windowServer 注册一个带假窗口的 darwin 平台服务。Exists 恒为 false，
// 因此 /info.commands 里只有窗口命令与 system.info，断言不受外部工具影响。
func windowServer(t *testing.T, hasWindow bool, window native.Window) (*httptest.Server, *fakeWindow) {
	t.Helper()
	fake, _ := window.(*fakeWindow)
	return platformServer(t, native.Options{
		GOOS:      "darwin",
		HasWindow: hasWindow,
		Window:    window,
		Exists:    func(string) bool { return false },
	}, &fakeRunner{}), fake
}

func TestWindowCommandsUnsupportedWithoutWindow(t *testing.T) {
	cases := []struct {
		name      string
		hasWindow bool
		window    native.Window
	}{
		{name: "hasWindow 为 false", hasWindow: false, window: &fakeWindow{}},
		{name: "没有窗口实现", hasWindow: true, window: nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv, fake := windowServer(t, tc.hasWindow, tc.window)
			for _, command := range []string{
				native.CommandWindowSetTitle,
				native.CommandWindowSetSize,
				native.CommandWindowMinimize,
				native.CommandWindowMaximize,
				native.CommandWindowRestore,
				native.CommandWindowFocus,
				native.CommandWindowClose,
				native.CommandWindowState,
			} {
				result := invoke(t, srv, command, map[string]any{})
				if result.OK || result.Code != native.CodeUnsupported {
					t.Fatalf("%s = %+v，期望 unsupported", command, result)
				}
				if result.Platform != "darwin" {
					t.Fatalf("%s platform = %q，期望 darwin", command, result.Platform)
				}
			}
			if fake != nil && len(fake.recorded()) != 0 {
				t.Fatalf("无窗口时不应调用窗口实现: %v", fake.recorded())
			}
		})
	}
}

func TestWindowCommandsRegisteredInContractOrder(t *testing.T) {
	srv, _ := windowServer(t, true, &fakeWindow{})
	want := []string{
		native.CommandWindowSetTitle,
		native.CommandWindowSetSize,
		native.CommandWindowMinimize,
		native.CommandWindowMaximize,
		native.CommandWindowRestore,
		native.CommandWindowFocus,
		native.CommandWindowClose,
		native.CommandWindowState,
		native.CommandSystemInfo,
	}
	if got := infoCommands(t, srv); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands = %v，期望 %v", got, want)
	}
}

func TestWindowSetTitleDispatchesTitle(t *testing.T) {
	srv, fake := windowServer(t, true, &fakeWindow{})
	result := invoke(t, srv, native.CommandWindowSetTitle, map[string]any{"title": "新标题"})
	if !result.OK {
		t.Fatalf("window.setTitle 失败: %+v", result)
	}
	if got := fake.recorded(); !reflect.DeepEqual(got, []string{"SetTitle:新标题"}) {
		t.Fatalf("调用 = %v，期望 [SetTitle:新标题]", got)
	}
}

func TestWindowSetTitleRejectsMissingOrNullTitle(t *testing.T) {
	for _, input := range []any{
		map[string]any{},
		map[string]any{"title": nil},
	} {
		srv, fake := windowServer(t, true, &fakeWindow{})
		result := invoke(t, srv, native.CommandWindowSetTitle, input)
		if result.OK || result.Code != native.CodeInvalid {
			t.Fatalf("input = %v，结果 = %+v，期望 invalid", input, result)
		}
		if len(fake.recorded()) != 0 {
			t.Fatalf("参数非法时不应调用窗口实现: %v", fake.recorded())
		}
	}
}

func TestWindowSetTitleAllowsEmptyTitle(t *testing.T) {
	srv, fake := windowServer(t, true, &fakeWindow{})
	result := invoke(t, srv, native.CommandWindowSetTitle, map[string]any{"title": ""})
	if !result.OK {
		t.Fatalf("空标题应当是合法输入: %+v", result)
	}
	if got := fake.recorded(); !reflect.DeepEqual(got, []string{"SetTitle:"}) {
		t.Fatalf("调用 = %v，期望 [SetTitle:]", got)
	}
}

func TestWindowSetSizeDispatchesPositiveDimensions(t *testing.T) {
	srv, fake := windowServer(t, true, &fakeWindow{})
	result := invoke(t, srv, native.CommandWindowSetSize, map[string]any{"width": 800, "height": 600})
	if !result.OK {
		t.Fatalf("window.setSize 失败: %+v", result)
	}
	if got := fake.recorded(); !reflect.DeepEqual(got, []string{"SetSize:800x600"}) {
		t.Fatalf("调用 = %v，期望 [SetSize:800x600]", got)
	}
}

func TestWindowSetSizeRejectsMissingOrNonPositiveDimensions(t *testing.T) {
	for _, input := range []any{
		map[string]any{},
		map[string]any{"width": 800},
		map[string]any{"height": 600},
		map[string]any{"width": 0, "height": 600},
		map[string]any{"width": 800, "height": -1},
		map[string]any{"width": 1.5, "height": 600},
	} {
		srv, fake := windowServer(t, true, &fakeWindow{})
		result := invoke(t, srv, native.CommandWindowSetSize, input)
		if result.OK || result.Code != native.CodeInvalid {
			t.Fatalf("input = %v，结果 = %+v，期望 invalid", input, result)
		}
		if len(fake.recorded()) != 0 {
			t.Fatalf("参数非法时不应调用窗口实现: %v", fake.recorded())
		}
	}
}

func TestWindowActionsDispatchToNativePrimitives(t *testing.T) {
	cases := []struct {
		command string
		want    string
	}{
		{command: native.CommandWindowMinimize, want: "Minimize"},
		{command: native.CommandWindowMaximize, want: "Maximize"},
		{command: native.CommandWindowRestore, want: "Restore"},
		{command: native.CommandWindowFocus, want: "Focus"},
		{command: native.CommandWindowClose, want: "Close"},
	}
	for _, tc := range cases {
		t.Run(tc.command, func(t *testing.T) {
			srv, fake := windowServer(t, true, &fakeWindow{})
			result := invoke(t, srv, tc.command, map[string]any{})
			if !result.OK {
				t.Fatalf("%s 失败: %+v", tc.command, result)
			}
			if got := fake.recorded(); !reflect.DeepEqual(got, []string{tc.want}) {
				t.Fatalf("调用 = %v，期望 [%s]", got, tc.want)
			}
		})
	}
}

func TestWindowStateReturnsCurrentState(t *testing.T) {
	fake := &fakeWindow{state: native.WindowState{
		Maximized: true,
		Minimized: false,
		Focused:   true,
		Size:      native.WindowSize{Width: 1440, Height: 900},
	}}
	srv, _ := windowServer(t, true, fake)

	result := invoke(t, srv, native.CommandWindowState, map[string]any{})
	if !result.OK {
		t.Fatalf("window.state 失败: %+v", result)
	}

	var state native.WindowState
	if err := json.Unmarshal(result.Value, &state); err != nil {
		t.Fatalf("解析状态失败: %v (%s)", err, result.Value)
	}
	if state != fake.state {
		t.Fatalf("state = %+v，期望 %+v", state, fake.state)
	}

	// 字段名必须与 protocol 的 NativeWindowState 逐字一致。
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(result.Value, &raw); err != nil {
		t.Fatalf("解析原始状态失败: %v", err)
	}
	for _, key := range []string{"maximized", "minimized", "focused", "size"} {
		if _, ok := raw[key]; !ok {
			t.Fatalf("缺少字段 %q: %s", key, result.Value)
		}
	}
	var size map[string]json.RawMessage
	if err := json.Unmarshal(raw["size"], &size); err != nil {
		t.Fatalf("解析 size 失败: %v", err)
	}
	if _, ok := size["width"]; !ok {
		t.Fatalf("size 缺少 width: %s", raw["size"])
	}
	if _, ok := size["height"]; !ok {
		t.Fatalf("size 缺少 height: %s", raw["size"])
	}
}

func TestWindowErrorsMapToBusinessCodes(t *testing.T) {
	t.Run("超时", func(t *testing.T) {
		srv, _ := windowServer(t, true, &fakeWindow{err: context.DeadlineExceeded})
		result := invoke(t, srv, native.CommandWindowMinimize, map[string]any{})
		if result.OK || result.Code != native.CodeTimeout {
			t.Fatalf("结果 = %+v，期望 timeout", result)
		}
	})

	t.Run("窗口未就绪", func(t *testing.T) {
		// 控制器在窗口尚未 attach 的时间窗内返回 busy；windowError 必须原样透传，
		// 不能把它降级成 internal。
		srv, _ := windowServer(t, true, &fakeWindow{
			err: &native.Error{Code: native.CodeBusy, Message: "等待窗口 attach"},
		})
		result := invoke(t, srv, native.CommandWindowMinimize, map[string]any{})
		if result.OK || result.Code != native.CodeBusy {
			t.Fatalf("结果 = %+v，期望 busy", result)
		}
	})

	t.Run("内部错误", func(t *testing.T) {
		srv, _ := windowServer(t, true, &fakeWindow{err: errors.New("UI 线程不可用")})
		result := invoke(t, srv, native.CommandWindowMinimize, map[string]any{})
		if result.OK || result.Code != native.CodeInternal {
			t.Fatalf("结果 = %+v，期望 internal", result)
		}
		if result.Message != "UI 线程不可用" {
			t.Fatalf("message = %q，期望底层错误信息", result.Message)
		}
	})
}
