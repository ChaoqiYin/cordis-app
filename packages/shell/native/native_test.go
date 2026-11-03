package native_test

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cordis-app/shell/native"
)

// noop 是只关心传输层时使用的假命令实现：它不做任何平台操作。
func noop(context.Context, json.RawMessage) (any, error) { return struct{}{}, nil }

// invokeClient 带超时，避免实现缺失时测试永久挂起。
var invokeClient = &http.Client{Timeout: 3 * time.Second}

// newTestHandler 构造一个使用固定凭据与固定平台信息的 handler，避免测试依赖
// 真实运行平台；平台/架构只有在生产路径才由 runtime 填充。
func newTestHandler(t *testing.T, reg *native.Registry, configure ...func(*native.Config)) http.Handler {
	t.Helper()
	cfg := native.Config{
		Token:     "test-token",
		Registry:  reg,
		Platform:  "testos",
		Arch:      "testarch",
		HasWindow: true,
	}
	for _, fn := range configure {
		fn(&cfg)
	}
	return native.NewHandler(cfg)
}

func TestInfoReportsContractAndRegisteredCommands(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("path.chooseOpen", noop)
	reg.Register("system.info", noop)

	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/info")
	if err != nil {
		t.Fatalf("GET /info 失败: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", resp.StatusCode)
	}

	var info struct {
		ContractVersion int      `json:"contractVersion"`
		Platform        string   `json:"platform"`
		Arch            string   `json:"arch"`
		HasWindow       bool     `json:"hasWindow"`
		Commands        []string `json:"commands"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatalf("解析 /info 响应失败: %v", err)
	}

	if info.ContractVersion != 1 {
		t.Fatalf("contractVersion = %d，期望 1", info.ContractVersion)
	}
	if info.Platform != "testos" || info.Arch != "testarch" {
		t.Fatalf("platform/arch = %s/%s，期望 testos/testarch", info.Platform, info.Arch)
	}
	if !info.HasWindow {
		t.Fatal("hasWindow 应当为 true")
	}
	want := []string{"path.chooseOpen", "system.info"}
	if !reflect.DeepEqual(info.Commands, want) {
		t.Fatalf("commands = %v，期望 %v", info.Commands, want)
	}
}

// doInvoke 是 postInvoke 的可并发版本：它不调用 testing.T，便于在 goroutine 中使用。
func doInvoke(srv *httptest.Server, token, body string) (*http.Response, []byte, error) {
	req, err := http.NewRequest(http.MethodPost, srv.URL+"/invoke", strings.NewReader(body))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := invokeClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, err
	}
	return resp, payload, nil
}

// postInvoke 发送 POST /invoke；token 为空表示不带 Authorization。
func postInvoke(t *testing.T, srv *httptest.Server, token, body string) (*http.Response, []byte) {
	t.Helper()
	resp, payload, err := doInvoke(srv, token, body)
	if err != nil {
		t.Fatalf("POST /invoke 失败: %v", err)
	}
	return resp, payload
}

func TestInvokeRejectsMissingOrWrongToken(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("system.info", noop)
	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()

	body := `{"command":"system.info","input":{}}`

	for _, tc := range []struct {
		name  string
		token string
	}{
		{name: "缺失 token", token: ""},
		{name: "错误 token", token: "wrong-token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, _ := postInvoke(t, srv, tc.token, body)
			if resp.StatusCode != http.StatusUnauthorized {
				t.Fatalf("状态码 = %d，期望 401", resp.StatusCode)
			}
		})
	}

	resp, _ := postInvoke(t, srv, "test-token", body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("正确 token 的状态码 = %d，期望 200", resp.StatusCode)
	}
}

func TestInvokeReturnsSuccessEnvelope(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("system.info", func(context.Context, json.RawMessage) (any, error) {
		return map[string]any{"platform": "darwin", "hasWindow": true}, nil
	})
	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()

	resp, payload := postInvoke(t, srv, "test-token", `{"command":"system.info","input":{}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望 200", resp.StatusCode)
	}

	var envelope struct {
		OK    bool `json:"ok"`
		Value struct {
			Platform  string `json:"platform"`
			HasWindow bool   `json:"hasWindow"`
		} `json:"value"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		t.Fatalf("解析 envelope 失败: %v (%s)", err, payload)
	}
	if !envelope.OK {
		t.Fatalf("ok = false，期望成功 envelope: %s", payload)
	}
	if envelope.Value.Platform != "darwin" || !envelope.Value.HasWindow {
		t.Fatalf("value = %+v，期望 darwin/true", envelope.Value)
	}
}

func TestInvokeMapsBusinessErrorsToEnvelope(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("test.cancelled", func(context.Context, json.RawMessage) (any, error) {
		return nil, &native.Error{Code: native.CodeCancelled}
	})
	reg.Register("test.unsupported", func(context.Context, json.RawMessage) (any, error) {
		return nil, &native.Error{Code: native.CodeUnsupported, Message: "未找到 zenity/kdialog", Platform: "linux"}
	})
	reg.Register("test.invalid", func(context.Context, json.RawMessage) (any, error) {
		return nil, &native.Error{Code: native.CodeInvalid, Message: "width 必须为正数"}
	})
	reg.Register("test.busy", func(context.Context, json.RawMessage) (any, error) {
		return nil, &native.Error{Code: native.CodeBusy}
	})
	reg.Register("test.internal", func(context.Context, json.RawMessage) (any, error) {
		return nil, errors.New("boom")
	})
	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()

	for _, tc := range []struct {
		name     string
		command  string
		wantCode string
	}{
		{name: "cancelled 映射", command: "test.cancelled", wantCode: native.CodeCancelled},
		{name: "unsupported 映射", command: "test.unsupported", wantCode: native.CodeUnsupported},
		{name: "invalid 映射", command: "test.invalid", wantCode: native.CodeInvalid},
		{name: "busy 映射", command: "test.busy", wantCode: native.CodeBusy},
		{name: "internal 映射", command: "test.internal", wantCode: native.CodeInternal},
		{name: "未知命令映射为 invalid", command: "does.notExist", wantCode: native.CodeInvalid},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp, payload := postInvoke(t, srv, "test-token",
				`{"command":"`+tc.command+`","input":{}}`)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("状态码 = %d，期望业务错误仍是 200", resp.StatusCode)
			}
			var failure struct {
				OK       bool   `json:"ok"`
				Code     string `json:"code"`
				Message  string `json:"message"`
				Platform string `json:"platform"`
			}
			if err := json.Unmarshal(payload, &failure); err != nil {
				t.Fatalf("解析 envelope 失败: %v (%s)", err, payload)
			}
			if failure.OK {
				t.Fatalf("ok = true，期望失败 envelope: %s", payload)
			}
			if failure.Code != tc.wantCode {
				t.Fatalf("code = %q，期望 %q", failure.Code, tc.wantCode)
			}
		})
	}
}

func TestUnsupportedCarriesPlatformDetail(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("test.unsupported", func(context.Context, json.RawMessage) (any, error) {
		return nil, &native.Error{Code: native.CodeUnsupported, Message: "未找到 zenity/kdialog", Platform: "linux"}
	})
	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()

	_, payload := postInvoke(t, srv, "test-token", `{"command":"test.unsupported","input":{}}`)

	var failure struct {
		Code     string `json:"code"`
		Message  string `json:"message"`
		Platform string `json:"platform"`
	}
	if err := json.Unmarshal(payload, &failure); err != nil {
		t.Fatalf("解析 envelope 失败: %v (%s)", err, payload)
	}
	if failure.Code != native.CodeUnsupported {
		t.Fatalf("code = %q，期望 unsupported", failure.Code)
	}
	if failure.Platform != "linux" || failure.Message != "未找到 zenity/kdialog" {
		t.Fatalf("message/platform = %q/%q", failure.Message, failure.Platform)
	}
}

func TestConcurrentPathChooseReturnsBusy(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var startOnce, releaseOnce sync.Once
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }

	reg := native.NewRegistry()
	reg.Register("path.chooseOpen", func(context.Context, json.RawMessage) (any, error) {
		startOnce.Do(func() { close(started) })
		<-release
		return map[string]any{"paths": []string{"/tmp/a.csv"}}, nil
	})
	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()
	defer releaseAll()

	first := make(chan error, 1)
	go func() {
		resp, payload, err := doInvoke(srv, "test-token", `{"command":"path.chooseOpen","input":{}}`)
		if err != nil {
			first <- err
			return
		}
		if resp.StatusCode != http.StatusOK || !strings.Contains(string(payload), `"ok":true`) {
			first <- errors.New("第一个路径选择没有成功: " + string(payload))
			return
		}
		first <- nil
	}()

	<-started

	resp, payload := postInvoke(t, srv, "test-token", `{"command":"path.chooseOpen","input":{}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("第二个请求状态码 = %d，期望业务错误仍是 200", resp.StatusCode)
	}
	var failure struct {
		OK   bool   `json:"ok"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(payload, &failure); err != nil {
		t.Fatalf("解析 envelope 失败: %v (%s)", err, payload)
	}
	if failure.OK || failure.Code != native.CodeBusy {
		t.Fatalf("第二个路径选择 = %+v，期望 busy", failure)
	}

	releaseAll()
	if err := <-first; err != nil {
		t.Fatal(err)
	}
}

func TestWindowCommandsAreSerialized(t *testing.T) {
	var active int32
	entered := make(chan struct{}, 2)
	release := make(chan struct{}, 2)
	reg := native.NewRegistry()
	reg.Register("window.state", func(context.Context, json.RawMessage) (any, error) {
		if atomic.AddInt32(&active, 1) != 1 {
			t.Errorf("窗口命令发生了并发执行")
		}
		entered <- struct{}{}
		<-release
		atomic.AddInt32(&active, -1)
		return struct{}{}, nil
	})
	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()
	// 测试中途失败时也要放行仍在等待的 handler，否则 srv.Close 会一直等。
	defer func() {
		for i := 0; i < 2; i++ {
			select {
			case release <- struct{}{}:
			default:
			}
		}
	}()

	results := make(chan error, 2)
	invoke := func() {
		_, _, err := doInvoke(srv, "test-token", `{"command":"window.state","input":{}}`)
		results <- err
	}

	go invoke()
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("第一个窗口命令没有开始执行")
	}

	go invoke()
	select {
	case <-entered:
		t.Fatal("第二个窗口命令在第一个结束前就开始执行")
	case <-time.After(100 * time.Millisecond):
	}

	release <- struct{}{}
	select {
	case <-entered:
	case <-time.After(2 * time.Second):
		t.Fatal("第一个窗口命令结束后，第二个没有开始执行")
	}
	release <- struct{}{}

	for i := 0; i < 2; i++ {
		if err := <-results; err != nil {
			t.Fatalf("窗口命令请求失败: %v", err)
		}
	}
}

func TestNonInteractiveCommandTimesOut(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("window.minimize", func(context.Context, json.RawMessage) (any, error) {
		time.Sleep(80 * time.Millisecond)
		return struct{}{}, nil
	})
	srv := httptest.NewServer(newTestHandler(t, reg, func(cfg *native.Config) {
		cfg.Timeout = 20 * time.Millisecond
	}))
	defer srv.Close()

	resp, payload := postInvoke(t, srv, "test-token", `{"command":"window.minimize","input":{}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望业务错误仍是 200", resp.StatusCode)
	}
	var failure struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(payload, &failure); err != nil {
		t.Fatalf("解析 envelope 失败: %v (%s)", err, payload)
	}
	if failure.Code != native.CodeTimeout {
		t.Fatalf("code = %q，期望 timeout", failure.Code)
	}
}

func TestInteractiveCommandHasNoRPCTimeout(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("path.chooseDirectory", func(context.Context, json.RawMessage) (any, error) {
		time.Sleep(60 * time.Millisecond)
		return map[string]any{"paths": []string{"/tmp"}}, nil
	})
	srv := httptest.NewServer(newTestHandler(t, reg, func(cfg *native.Config) {
		cfg.Timeout = 20 * time.Millisecond
	}))
	defer srv.Close()

	_, payload := postInvoke(t, srv, "test-token", `{"command":"path.chooseDirectory","input":{}}`)

	var envelope struct {
		OK bool `json:"ok"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		t.Fatalf("解析 envelope 失败: %v (%s)", err, payload)
	}
	if !envelope.OK {
		t.Fatalf("交互命令不应受 5 秒 RPC 超时约束: %s", payload)
	}
}

func TestStartListensOnLoopbackWithRandomToken(t *testing.T) {
	reg := native.NewRegistry()
	reg.Register("system.info", noop)

	srv, err := native.Start(native.Config{Registry: reg, HasWindow: false})
	if err != nil {
		t.Fatalf("启动原生服务失败: %v", err)
	}
	defer srv.Close()

	parsed, err := url.Parse(srv.URL())
	if err != nil {
		t.Fatalf("原生服务 URL 非法: %v", err)
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" || parsed.Port() == "" {
		t.Fatalf("URL = %q，期望监听 127.0.0.1 的随机端口", srv.URL())
	}

	raw, err := hex.DecodeString(srv.Token())
	if err != nil {
		t.Fatalf("token 不是十六进制: %v", err)
	}
	if len(raw) != 32 {
		t.Fatalf("token 长度 = %d 字节，期望 32", len(raw))
	}

	resp, err := http.Get(srv.URL() + "/info")
	if err != nil {
		t.Fatalf("GET /info 失败: %v", err)
	}
	defer resp.Body.Close()
	var info struct {
		HasWindow bool     `json:"hasWindow"`
		Commands  []string `json:"commands"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatalf("解析 /info 失败: %v", err)
	}
	if info.HasWindow {
		t.Fatal("--url 降级形态的 hasWindow 应当为 false")
	}
	if !reflect.DeepEqual(info.Commands, []string{"system.info"}) {
		t.Fatalf("commands = %v，期望 [system.info]", info.Commands)
	}

	if err := srv.Close(); err != nil {
		t.Fatalf("关闭原生服务失败: %v", err)
	}
	// Close 必须幂等：信号处理器与 defer 可能各调一次。
	if err := srv.Close(); err != nil {
		t.Fatalf("重复关闭应当幂等: %v", err)
	}
}

func TestKnownButUnregisteredCommandIsUnsupported(t *testing.T) {
	// 契约里的命令在本平台没有实现时，调用方应得到 unsupported 并能读到
	// platform，而不是把它当成拼错的命令（invalid）。
	reg := native.NewRegistry()
	srv := httptest.NewServer(newTestHandler(t, reg))
	defer srv.Close()

	resp, payload := postInvoke(t, srv, "test-token", `{"command":"window.state","input":{}}`)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("状态码 = %d，期望业务错误仍是 200", resp.StatusCode)
	}

	var failure struct {
		OK       bool   `json:"ok"`
		Code     string `json:"code"`
		Platform string `json:"platform"`
	}
	if err := json.Unmarshal(payload, &failure); err != nil {
		t.Fatalf("解析 envelope 失败: %v (%s)", err, payload)
	}
	if failure.OK || failure.Code != native.CodeUnsupported {
		t.Fatalf("envelope = %+v，期望 unsupported", failure)
	}
	if failure.Platform != "testos" {
		t.Fatalf("platform = %q，期望 testos", failure.Platform)
	}
}
