package native_test

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/cordis-app/shell/native"
)

// recordedCall 是一次被记录的外部命令调用。
type recordedCall struct {
	Name string
	Args []string
}

// fakeRunner 是外部命令的测试替身：路径选择、通知与系统探测都通过它观察，
// 测试不会弹出真实对话框或发送真实通知。
type fakeRunner struct {
	mu         sync.Mutex
	runCalls   []recordedCall
	startCalls []recordedCall
	runFn      func(name string, args []string) native.CommandResult
	startFn    func(name string, args []string) error
}

func (f *fakeRunner) Run(_ context.Context, name string, args ...string) native.CommandResult {
	f.mu.Lock()
	f.runCalls = append(f.runCalls, recordedCall{Name: name, Args: append([]string(nil), args...)})
	fn := f.runFn
	f.mu.Unlock()
	if fn != nil {
		return fn(name, args)
	}
	return native.CommandResult{}
}

func (f *fakeRunner) Start(name string, args ...string) error {
	f.mu.Lock()
	f.startCalls = append(f.startCalls, recordedCall{Name: name, Args: append([]string(nil), args...)})
	fn := f.startFn
	f.mu.Unlock()
	if fn != nil {
		return fn(name, args)
	}
	return nil
}

func (f *fakeRunner) calls() (runs, starts []recordedCall) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recordedCall(nil), f.runCalls...), append([]recordedCall(nil), f.startCalls...)
}

// platformServer 用给定平台选项注册命令并启动测试用的原生 HTTP 服务。
func platformServer(t *testing.T, opts native.Options, runner *fakeRunner) *httptest.Server {
	t.Helper()
	if opts.Runner == nil {
		opts.Runner = runner
	}
	if opts.GOOS == "" {
		opts.GOOS = "darwin"
	}
	if opts.Arch == "" {
		opts.Arch = "arm64"
	}
	reg := native.NewRegistry()
	native.RegisterAll(reg, opts)
	handler := native.NewHandler(native.Config{
		Token:     "test-token",
		Registry:  reg,
		Platform:  opts.GOOS,
		Arch:      opts.Arch,
		HasWindow: opts.HasWindow,
	})
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	return srv
}

// invokeResult 是测试关心的 envelope 字段。
type invokeResult struct {
	OK       bool            `json:"ok"`
	Code     string          `json:"code"`
	Message  string          `json:"message"`
	Platform string          `json:"platform"`
	Value    json.RawMessage `json:"value"`
}

func invoke(t *testing.T, srv *httptest.Server, command string, input any) invokeResult {
	t.Helper()
	body, err := json.Marshal(map[string]any{"command": command, "input": input})
	if err != nil {
		t.Fatalf("序列化请求失败: %v", err)
	}
	resp, payload := postInvoke(t, srv, "test-token", string(body))
	if resp.StatusCode != 200 {
		t.Fatalf("%s 状态码 = %d，期望业务结果仍是 200: %s", command, resp.StatusCode, payload)
	}
	var result invokeResult
	if err := json.Unmarshal(payload, &result); err != nil {
		t.Fatalf("解析 %s 的 envelope 失败: %v (%s)", command, err, payload)
	}
	return result
}

func infoCommands(t *testing.T, srv *httptest.Server) []string {
	t.Helper()
	resp, err := srv.Client().Get(srv.URL + "/info")
	if err != nil {
		t.Fatalf("GET /info 失败: %v", err)
	}
	defer resp.Body.Close()
	var info struct {
		Commands []string `json:"commands"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		t.Fatalf("解析 /info 失败: %v", err)
	}
	return info.Commands
}

func TestDarwinSystemInfoReportsReleaseThemeAndWindow(t *testing.T) {
	runner := &fakeRunner{}
	runner.runFn = func(name string, args []string) native.CommandResult {
		switch name {
		case "/usr/bin/uname":
			return native.CommandResult{Stdout: []byte("25.5.0\n")}
		case "/usr/bin/defaults":
			return native.CommandResult{Stdout: []byte("Dark\n")}
		default:
			return native.CommandResult{Err: exitError{code: 2}}
		}
	}
	srv := platformServer(t, native.Options{
		GOOS:      "darwin",
		Arch:      "arm64",
		HasWindow: true,
		Exists:    func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandSystemInfo, map[string]any{})
	if !result.OK {
		t.Fatalf("system.info 失败: %+v", result)
	}
	var output struct {
		Platform  string `json:"platform"`
		Arch      string `json:"arch"`
		Release   string `json:"release"`
		Theme     string `json:"theme"`
		HasWindow bool   `json:"hasWindow"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if output.Platform != "darwin" || output.Arch != "arm64" || !output.HasWindow {
		t.Fatalf("平台字段 = %+v", output)
	}
	if output.Release != "25.5.0" {
		t.Fatalf("release = %q，期望 25.5.0", output.Release)
	}
	if output.Theme != "dark" {
		t.Fatalf("theme = %q，期望 dark", output.Theme)
	}
}

func TestDarwinSystemInfoDegradesToUnknownTheme(t *testing.T) {
	runner := &fakeRunner{}
	runner.runFn = func(name string, _ []string) native.CommandResult {
		if name == "/usr/bin/uname" {
			return native.CommandResult{Stdout: []byte("25.5.0\n")}
		}
		return native.CommandResult{Err: exitError{code: 2}}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandSystemInfo, map[string]any{})
	if !result.OK {
		t.Fatalf("system.info 失败: %+v", result)
	}
	var output struct {
		Theme string `json:"theme"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if output.Theme != "unknown" {
		t.Fatalf("theme = %q，期望 unknown", output.Theme)
	}
}

func TestShellOpenExternalAllowsOnlySupportedSchemes(t *testing.T) {
	valid := []string{"https://example.com/doc", "http://127.0.0.1:3000/", "mailto:dev@example.com"}
	for _, target := range valid {
		t.Run(target, func(t *testing.T) {
			runner := &fakeRunner{}
			srv := platformServer(t, native.Options{
				GOOS:   "darwin",
				Exists: func(string) bool { return true },
			}, runner)

			result := invoke(t, srv, native.CommandShellOpenExternal, map[string]any{"url": target})
			if !result.OK {
				t.Fatalf("shell.openExternal(%s) 失败: %+v", target, result)
			}
			_, starts := runner.calls()
			if len(starts) != 1 {
				t.Fatalf("启动次数 = %d，期望 1", len(starts))
			}
			if starts[0].Name != "/usr/bin/open" {
				t.Fatalf("命令 = %q，期望 /usr/bin/open", starts[0].Name)
			}
			if want := []string{target}; !reflect.DeepEqual(starts[0].Args, want) {
				t.Fatalf("参数 = %v，期望 %v", starts[0].Args, want)
			}
		})
	}

	for _, target := range []string{"file:///etc/passwd", "javascript:alert(1)", "ftp://example.com", "not a url"} {
		t.Run("reject "+target, func(t *testing.T) {
			runner := &fakeRunner{}
			srv := platformServer(t, native.Options{
				GOOS:   "darwin",
				Exists: func(string) bool { return true },
			}, runner)

			result := invoke(t, srv, native.CommandShellOpenExternal, map[string]any{"url": target})
			if result.OK || result.Code != native.CodeInvalid {
				t.Fatalf("shell.openExternal(%s) = %+v，期望 invalid", target, result)
			}
			if _, starts := runner.calls(); len(starts) != 0 {
				t.Fatalf("非法 scheme 不应启动外部程序: %#v", starts)
			}
		})
	}
}

func TestDarwinShowItemInFolderRevealsWithOpenR(t *testing.T) {
	dir := tempDir(t)
	file := dir + "/report.csv"
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandShellShowItemInFolder, map[string]any{"path": file})
	if !result.OK {
		t.Fatalf("shell.showItemInFolder 失败: %+v", result)
	}
	_, starts := runner.calls()
	if len(starts) != 1 || starts[0].Name != "/usr/bin/open" {
		t.Fatalf("启动调用 = %#v", starts)
	}
	if want := []string{"-R", file}; !reflect.DeepEqual(starts[0].Args, want) {
		t.Fatalf("参数 = %v，期望 %v", starts[0].Args, want)
	}
}

func TestShowItemInFolderRejectsMissingPath(t *testing.T) {
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandShellShowItemInFolder, map[string]any{"path": "/definitely/not/here"})
	if result.OK || result.Code != native.CodeInvalid {
		t.Fatalf("不存在的路径 = %+v，期望 invalid", result)
	}
	if _, starts := runner.calls(); len(starts) != 0 {
		t.Fatalf("路径不存在时不应启动外部程序: %#v", starts)
	}
}

func existsOnly(paths ...string) func(string) bool {
	allowed := make(map[string]bool, len(paths))
	for _, path := range paths {
		allowed[path] = true
	}
	return func(path string) bool { return allowed[path] }
}

func TestLinuxRegistersCommandsOnlyWhenToolsExist(t *testing.T) {
	full := platformServer(t, native.Options{
		GOOS:   "linux",
		Exists: existsOnly("/usr/bin/zenity", "/usr/bin/notify-send", "/usr/bin/xdg-open"),
	}, &fakeRunner{})
	want := []string{
		native.CommandPathChooseOpen,
		native.CommandPathChooseDirectory,
		native.CommandPathChooseSave,
		native.CommandNotificationShow,
		native.CommandShellOpenExternal,
		native.CommandShellOpenPath,
		native.CommandShellShowItemInFolder,
		native.CommandSystemInfo,
	}
	if got := infoCommands(t, full); !reflect.DeepEqual(got, want) {
		t.Fatalf("完整工具集的 commands = %v，期望 %v", got, want)
	}

	bare := platformServer(t, native.Options{
		GOOS:   "linux",
		Exists: func(string) bool { return false },
	}, &fakeRunner{})
	if got := infoCommands(t, bare); !reflect.DeepEqual(got, []string{native.CommandSystemInfo}) {
		t.Fatalf("缺少外部工具时 commands = %v，期望只有 system.info", got)
	}
}

func TestLinuxZenityChooseOpenMapsArguments(t *testing.T) {
	dir := tempDir(t)
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte("/tmp/a.csv\n/tmp/b.txt\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "linux",
		Exists: existsOnly("/usr/bin/zenity"),
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseOpen, map[string]any{
		"multiple":    true,
		"title":       "选择数据",
		"defaultPath": dir,
		"filters":     []map[string]any{{"name": "表格", "extensions": []string{"csv", "txt"}}},
	})
	if !result.OK {
		t.Fatalf("zenity path.chooseOpen 失败: %+v", result)
	}
	runs, _ := runner.calls()
	if len(runs) != 1 || runs[0].Name != "/usr/bin/zenity" {
		t.Fatalf("外部命令调用 = %#v", runs)
	}
	want := []string{
		"--file-selection",
		"--title", "选择数据",
		"--multiple",
		"--separator", "\n",
		"--filename", dir,
		"--file-filter", "表格 | *.csv *.txt",
	}
	if !reflect.DeepEqual(runs[0].Args, want) {
		t.Fatalf("zenity 参数 = %#v，期望 %#v", runs[0].Args, want)
	}
}

func TestLinuxZenityChooseSaveAndCancel(t *testing.T) {
	dir := tempDir(t)
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte(dir + "/report.csv\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "linux",
		Exists: existsOnly("/usr/bin/zenity"),
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseSave, map[string]any{
		"defaultName": "report.csv",
		"defaultPath": dir,
	})
	if !result.OK {
		t.Fatalf("zenity path.chooseSave 失败: %+v", result)
	}
	runs, _ := runner.calls()
	want := []string{
		"--file-selection", "--save", "--confirm-overwrite",
		"--title", "保存文件",
		"--filename", dir + "/report.csv",
	}
	if !reflect.DeepEqual(runs[0].Args, want) {
		t.Fatalf("zenity 参数 = %#v，期望 %#v", runs[0].Args, want)
	}

	cancelledRunner := &fakeRunner{}
	cancelledRunner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Err: exitError{code: 1}}
	}
	cancelled := platformServer(t, native.Options{
		GOOS:   "linux",
		Exists: existsOnly("/usr/bin/zenity"),
	}, cancelledRunner)
	if got := invoke(t, cancelled, native.CommandPathChooseOpen, map[string]any{}); got.OK || got.Code != native.CodeCancelled {
		t.Fatalf("zenity 取消 = %+v，期望 cancelled", got)
	}
}

func TestLinuxFallsBackToKdialog(t *testing.T) {
	dir := tempDir(t)
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte("/tmp/a.csv\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "linux",
		Exists: existsOnly("/usr/bin/kdialog"),
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseOpen, map[string]any{
		"defaultPath": dir,
		"filters":     []map[string]any{{"name": "表格", "extensions": []string{"csv"}}},
	})
	if !result.OK {
		t.Fatalf("kdialog path.chooseOpen 失败: %+v", result)
	}
	runs, _ := runner.calls()
	if len(runs) != 1 || runs[0].Name != "/usr/bin/kdialog" {
		t.Fatalf("外部命令调用 = %#v", runs)
	}
	want := []string{"--title", "选择文件", "--getopenfilename", dir, "表格 (*.csv)"}
	if !reflect.DeepEqual(runs[0].Args, want) {
		t.Fatalf("kdialog 参数 = %#v，期望 %#v", runs[0].Args, want)
	}
}

func TestLinuxNotificationAndShellUseAbsoluteTools(t *testing.T) {
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS:   "linux",
		Exists: existsOnly("/usr/bin/notify-send", "/usr/bin/xdg-open"),
	}, runner)

	if result := invoke(t, srv, native.CommandNotificationShow, map[string]any{"title": "标题", "body": "正文"}); !result.OK {
		t.Fatalf("notification.show 失败: %+v", result)
	}
	if result := invoke(t, srv, native.CommandShellOpenExternal, map[string]any{"url": "https://example.com"}); !result.OK {
		t.Fatalf("shell.openExternal 失败: %+v", result)
	}
	runs, starts := runner.calls()
	if len(runs) != 1 || runs[0].Name != "/usr/bin/notify-send" {
		t.Fatalf("通知调用 = %#v", runs)
	}
	if want := []string{"标题", "正文"}; !reflect.DeepEqual(runs[0].Args, want) {
		t.Fatalf("notify-send 参数 = %v，期望 %v", runs[0].Args, want)
	}
	if len(starts) != 1 || starts[0].Name != "/usr/bin/xdg-open" {
		t.Fatalf("打开链接调用 = %#v", starts)
	}
}

func TestLinuxSystemInfoUsesUnameAndGsettings(t *testing.T) {
	runner := &fakeRunner{}
	runner.runFn = func(name string, args []string) native.CommandResult {
		switch name {
		case "/usr/bin/uname":
			return native.CommandResult{Stdout: []byte("6.8.0-40-generic\n")}
		case "/usr/bin/gsettings":
			return native.CommandResult{Stdout: []byte("'prefer-dark'\n")}
		default:
			return native.CommandResult{Err: exitError{code: 2}}
		}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "linux",
		Arch:   "amd64",
		Exists: existsOnly("/usr/bin/uname", "/usr/bin/gsettings"),
	}, runner)

	result := invoke(t, srv, native.CommandSystemInfo, map[string]any{})
	if !result.OK {
		t.Fatalf("system.info 失败: %+v", result)
	}
	var output struct {
		Release string `json:"release"`
		Theme   string `json:"theme"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if output.Release != "6.8.0-40-generic" || output.Theme != "dark" {
		t.Fatalf("release/theme = %q/%q", output.Release, output.Theme)
	}
}

func TestWindowsRegistersCommandsBasedOnTools(t *testing.T) {
	full := platformServer(t, native.Options{
		GOOS: "windows",
		Exists: existsOnly(
			`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
			`C:\Windows\System32\rundll32.exe`,
			`C:\Windows\explorer.exe`,
		),
	}, &fakeRunner{})
	want := []string{
		native.CommandPathChooseOpen,
		native.CommandPathChooseDirectory,
		native.CommandPathChooseSave,
		native.CommandNotificationShow,
		native.CommandShellOpenExternal,
		native.CommandShellOpenPath,
		native.CommandShellShowItemInFolder,
		native.CommandSystemInfo,
	}
	if got := infoCommands(t, full); !reflect.DeepEqual(got, want) {
		t.Fatalf("Windows 完整工具集 commands = %v，期望 %v", got, want)
	}

	bare := platformServer(t, native.Options{
		GOOS:   "windows",
		Exists: func(string) bool { return false },
	}, &fakeRunner{})
	wantBare := []string{
		native.CommandPathChooseOpen,
		native.CommandPathChooseDirectory,
		native.CommandPathChooseSave,
		native.CommandSystemInfo,
	}
	if got := infoCommands(t, bare); !reflect.DeepEqual(got, wantBare) {
		t.Fatalf("Windows 缺少外部工具 commands = %v，期望 %v", got, wantBare)
	}
}

func TestWindowsNotificationEscapesPowerShellStrings(t *testing.T) {
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS:   "windows",
		Exists: existsOnly(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`),
	}, runner)

	result := invoke(t, srv, native.CommandNotificationShow, map[string]any{
		"title": "O'Brien 的构建",
		"body":  "全部通过",
	})
	if !result.OK {
		t.Fatalf("Windows notification.show 失败: %+v", result)
	}
	_, starts := runner.calls()
	if len(starts) != 1 {
		t.Fatalf("启动次数 = %d，期望 1", len(starts))
	}
	call := starts[0]
	if call.Name != `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` {
		t.Fatalf("命令 = %q", call.Name)
	}
	if len(call.Args) < 4 || call.Args[0] != "-NoProfile" || call.Args[1] != "-NonInteractive" || call.Args[2] != "-Command" {
		t.Fatalf("PowerShell 参数形状 = %#v", call.Args)
	}
	script := call.Args[3]
	if !strings.Contains(script, "O''Brien 的构建") {
		t.Fatalf("标题里的单引号没有被转义:\n%s", script)
	}
	if !strings.Contains(script, "全部通过") || !strings.Contains(script, "ShowBalloonTip") {
		t.Fatalf("通知脚本不完整:\n%s", script)
	}
}

func TestWindowsShellCommandsUseAbsoluteTools(t *testing.T) {
	dir := tempDir(t)
	file := dir + "/report.csv"
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS: "windows",
		Exists: existsOnly(
			`C:\Windows\System32\rundll32.exe`,
			`C:\Windows\explorer.exe`,
		),
	}, runner)

	if result := invoke(t, srv, native.CommandShellOpenExternal, map[string]any{"url": "https://example.com"}); !result.OK {
		t.Fatalf("Windows shell.openExternal 失败: %+v", result)
	}
	if result := invoke(t, srv, native.CommandShellShowItemInFolder, map[string]any{"path": file}); !result.OK {
		t.Fatalf("Windows shell.showItemInFolder 失败: %+v", result)
	}
	_, starts := runner.calls()
	if len(starts) != 2 {
		t.Fatalf("启动次数 = %d，期望 2", len(starts))
	}
	if starts[0].Name != `C:\Windows\System32\rundll32.exe` {
		t.Fatalf("打开链接命令 = %q", starts[0].Name)
	}
	if want := []string{"url.dll,FileProtocolHandler", "https://example.com"}; !reflect.DeepEqual(starts[0].Args, want) {
		t.Fatalf("打开链接参数 = %v，期望 %v", starts[0].Args, want)
	}
	if starts[1].Name != `C:\Windows\explorer.exe` {
		t.Fatalf("定位文件命令 = %q", starts[1].Name)
	}
	if want := []string{"/select," + file}; !reflect.DeepEqual(starts[1].Args, want) {
		t.Fatalf("定位文件参数 = %v，期望 %v", starts[1].Args, want)
	}
}

func TestWindowsSystemInfoUsesPowerShell(t *testing.T) {
	runner := &fakeRunner{}
	runner.runFn = func(name string, args []string) native.CommandResult {
		if name != `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` {
			return native.CommandResult{Err: exitError{code: 2}}
		}
		script := args[len(args)-1]
		if strings.Contains(script, "OSVersion") {
			return native.CommandResult{Stdout: []byte("10.0.22631\n")}
		}
		return native.CommandResult{Stdout: []byte("dark\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "windows",
		Arch:   "amd64",
		Exists: existsOnly(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`),
	}, runner)

	result := invoke(t, srv, native.CommandSystemInfo, map[string]any{})
	if !result.OK {
		t.Fatalf("Windows system.info 失败: %+v", result)
	}
	var output struct {
		Release string `json:"release"`
		Theme   string `json:"theme"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if output.Release != "10.0.22631" || output.Theme != "dark" {
		t.Fatalf("release/theme = %q/%q", output.Release, output.Theme)
	}
}

func TestDarwinNotificationMapsTitleAndBody(t *testing.T) {
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandNotificationShow, map[string]any{
		"title": "构建完成",
		"body":  "3 个任务全部通过",
	})
	if !result.OK {
		t.Fatalf("notification.show 失败: %+v", result)
	}
	runs, _ := runner.calls()
	if len(runs) != 1 {
		t.Fatalf("外部命令调用次数 = %d，期望 1", len(runs))
	}
	call := runs[0]
	if call.Name != "/usr/bin/osascript" {
		t.Fatalf("命令 = %q，期望 /usr/bin/osascript", call.Name)
	}
	if !strings.Contains(call.Args[1], "display notification") {
		t.Fatalf("脚本不包含 display notification:\n%s", call.Args[1])
	}
	if want := []string{"-e", call.Args[1], "--", "3 个任务全部通过", "构建完成"}; !reflect.DeepEqual(call.Args, want) {
		t.Fatalf("参数 = %#v，期望 %#v", call.Args, want)
	}
}

func TestDarwinRegistersPathNotificationShellAndSystemCommands(t *testing.T) {
	srv := platformServer(t, native.Options{
		GOOS:      "darwin",
		HasWindow: true,
		Exists:    func(string) bool { return true },
	}, &fakeRunner{})

	want := []string{
		native.CommandPathChooseOpen,
		native.CommandPathChooseDirectory,
		native.CommandPathChooseSave,
		native.CommandNotificationShow,
		native.CommandShellOpenExternal,
		native.CommandShellOpenPath,
		native.CommandShellShowItemInFolder,
		native.CommandSystemInfo,
	}
	if got := infoCommands(t, srv); !reflect.DeepEqual(got, want) {
		t.Fatalf("commands = %v，期望 %v", got, want)
	}
}

func TestShellOpenPathOpensExistingAbsolutePath(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "report.txt")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandShellOpenPath, map[string]any{"path": target})
	if !result.OK {
		t.Fatalf("shell.openPath 失败: %+v", result)
	}
	_, starts := runner.calls()
	if len(starts) != 1 {
		t.Fatalf("Start 调用次数 = %d，期望 1", len(starts))
	}
	if want := (recordedCall{Name: "/usr/bin/open", Args: []string{target}}); !reflect.DeepEqual(starts[0], want) {
		t.Fatalf("调用 = %#v，期望 %#v", starts[0], want)
	}
}

func TestShellOpenPathRejectsInvalidPaths(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "missing.txt")
	for name, input := range map[string]map[string]any{
		"空路径":  {"path": ""},
		"相对路径": {"path": "relative/file.txt"},
		"不存在":  {"path": missing},
	} {
		t.Run(name, func(t *testing.T) {
			srv := platformServer(t, native.Options{
				GOOS:   "darwin",
				Exists: func(string) bool { return true },
			}, &fakeRunner{})
			result := invoke(t, srv, native.CommandShellOpenPath, input)
			if result.OK || result.Code != "invalid" {
				t.Fatalf("shell.openPath = %+v，期望 invalid", result)
			}
		})
	}
}
