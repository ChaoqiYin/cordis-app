package native_test

import (
	"encoding/json"
	"os"
	"os/exec"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cordis-app/shell/native"
)

// tempDir 是测试里真实存在的默认目录；路径选择命令只做参数映射，不访问用户数据。
func tempDir(t *testing.T) string {
	t.Helper()
	return t.TempDir()
}

func TestDarwinChooseOpenMapsFiltersMultipleAndDefaultPath(t *testing.T) {
	dir := tempDir(t)
	runner := &fakeRunner{}
	runner.runFn = func(name string, args []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte("/tmp/a.csv\n/tmp/b.txt\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:      "darwin",
		HasWindow: true,
		Exists:    func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseOpen, map[string]any{
		"multiple": true,
		"title":    "选择数据文件",
		"filters": []map[string]any{
			{"name": "表格", "extensions": []string{"csv", "txt"}},
		},
		"defaultPath": dir,
	})
	if !result.OK {
		t.Fatalf("path.chooseOpen 失败: %+v", result)
	}
	var output struct {
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if want := []string{"/tmp/a.csv", "/tmp/b.txt"}; !reflect.DeepEqual(output.Paths, want) {
		t.Fatalf("paths = %v，期望 %v", output.Paths, want)
	}

	runs, _ := runner.calls()
	if len(runs) != 1 {
		t.Fatalf("外部命令调用次数 = %d，期望 1", len(runs))
	}
	call := runs[0]
	if call.Name != "/usr/bin/osascript" {
		t.Fatalf("命令 = %q，期望 /usr/bin/osascript", call.Name)
	}
	args := call.Args
	if len(args) != 7 || args[0] != "-e" || args[2] != "--" {
		t.Fatalf("osascript 参数形状 = %#v", args)
	}
	script := args[1]
	for _, fragment := range []string{
		"choose file",
		"of type typeList",
		"default location (POSIX file defaultPathText)",
		"with multiple selections allowed",
		"POSIX path of",
	} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("脚本缺少 %q:\n%s", fragment, script)
		}
	}
	wantArgs := []string{"1", "选择数据文件", dir, "csv,txt"}
	if !reflect.DeepEqual(args[3:], wantArgs) {
		t.Fatalf("脚本参数 = %v，期望 %v", args[3:], wantArgs)
	}
}

func TestDarwinChooseOpenSingleWithoutFilters(t *testing.T) {
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte("/tmp/only.csv\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseOpen, map[string]any{})
	if !result.OK {
		t.Fatalf("path.chooseOpen 失败: %+v", result)
	}
	var output struct {
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if want := []string{"/tmp/only.csv"}; !reflect.DeepEqual(output.Paths, want) {
		t.Fatalf("paths = %v，期望 %v", output.Paths, want)
	}

	runs, _ := runner.calls()
	script := runs[0].Args[1]
	if strings.Contains(script, "of type") {
		t.Fatalf("未给过滤器时不应出现 of type:\n%s", script)
	}
	if strings.Contains(script, "multiple selections allowed") {
		t.Fatalf("未要求多选时不应出现 multiple selections allowed:\n%s", script)
	}
	if strings.Contains(script, "default location") {
		t.Fatalf("未给 defaultPath 时不应出现 default location:\n%s", script)
	}
	if want := []string{"0", "选择文件", "", ""}; !reflect.DeepEqual(runs[0].Args[3:], want) {
		t.Fatalf("脚本参数 = %v，期望 %v", runs[0].Args[3:], want)
	}
}

func TestDarwinChooseOpenCancelIsCancelled(t *testing.T) {
	runner := &fakeRunner{}
	// exec.ExitError 的 ProcessState 在测试里难以构造，用只暴露 ExitCode 的
	// 错误即可覆盖取消判定。
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{
			Stderr: []byte("execution error: User canceled. (-128)\n"),
			Err:    exitError{code: 1},
		}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseOpen, map[string]any{})
	if result.OK || result.Code != native.CodeCancelled {
		t.Fatalf("取消结果 = %+v，期望 cancelled", result)
	}
}

func TestDarwinChooseDirectorySupportsMultiple(t *testing.T) {
	dir := tempDir(t)
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte("/tmp/alpha\n/tmp/beta\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseDirectory, map[string]any{
		"multiple":    true,
		"title":       "选择目录",
		"defaultPath": dir,
	})
	if !result.OK {
		t.Fatalf("path.chooseDirectory 失败: %+v", result)
	}
	var output struct {
		Paths []string `json:"paths"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if want := []string{"/tmp/alpha", "/tmp/beta"}; !reflect.DeepEqual(output.Paths, want) {
		t.Fatalf("paths = %v，期望 %v", output.Paths, want)
	}

	runs, _ := runner.calls()
	if len(runs) != 1 || runs[0].Name != "/usr/bin/osascript" {
		t.Fatalf("外部命令调用 = %#v", runs)
	}
	script := runs[0].Args[1]
	if !strings.Contains(script, "choose folder") {
		t.Fatalf("脚本缺少 choose folder:\n%s", script)
	}
	if strings.Contains(script, "of type") {
		t.Fatalf("目录选择不应出现 of type:\n%s", script)
	}
	for _, fragment := range []string{"with multiple selections allowed", "default location (POSIX file defaultPathText)"} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("脚本缺少 %q:\n%s", fragment, script)
		}
	}
	if want := []string{"1", "选择目录", dir}; !reflect.DeepEqual(runs[0].Args[3:], want) {
		t.Fatalf("脚本参数 = %v，期望 %v", runs[0].Args[3:], want)
	}
}

func TestDarwinChooseSaveUsesDefaultNameAndLocation(t *testing.T) {
	dir := tempDir(t)
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte("/tmp/报告.csv\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseSave, map[string]any{
		"title":       "保存报告",
		"defaultName": "报告.csv",
		"defaultPath": dir,
		"filters":     []map[string]any{{"name": "CSV", "extensions": []string{"csv"}}},
	})
	if !result.OK {
		t.Fatalf("path.chooseSave 失败: %+v", result)
	}
	var output struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(result.Value, &output); err != nil {
		t.Fatalf("解析输出失败: %v", err)
	}
	if output.Path != "/tmp/报告.csv" {
		t.Fatalf("path = %q，期望 /tmp/报告.csv", output.Path)
	}

	runs, _ := runner.calls()
	if len(runs) != 1 {
		t.Fatalf("外部命令调用次数 = %d，期望 1", len(runs))
	}
	script := runs[0].Args[1]
	if strings.Contains(script, "of type") {
		t.Fatalf("choose file name 不支持 of type，不应出现:\n%s", script)
	}
	for _, fragment := range []string{"choose file name", "default name defaultNameText", "default location (POSIX file defaultPathText)"} {
		if !strings.Contains(script, fragment) {
			t.Fatalf("脚本缺少 %q:\n%s", fragment, script)
		}
	}
	if want := []string{"保存报告", "报告.csv", dir}; !reflect.DeepEqual(runs[0].Args[3:], want) {
		t.Fatalf("脚本参数 = %v，期望 %v", runs[0].Args[3:], want)
	}
}

func TestDarwinChooseSaveDerivesNameAndDirectoryFromDefaultPath(t *testing.T) {
	dir := tempDir(t)
	file := dir + "/已有文件.txt"
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte(file + "\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
		Stat: func(path string) (os.FileInfo, error) {
			return fakeFileInfo{dir: path == dir, name: "已有文件.txt"}, nil
		},
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseSave, map[string]any{"defaultPath": file})
	if !result.OK {
		t.Fatalf("path.chooseSave 失败: %+v", result)
	}
	runs, _ := runner.calls()
	if want := []string{"保存文件", "已有文件.txt", dir}; !reflect.DeepEqual(runs[0].Args[3:], want) {
		t.Fatalf("脚本参数 = %v，期望 %v", runs[0].Args[3:], want)
	}
}

// fakeFileInfo 只实现 defaultDirectory 与默认文件名推导需要的字段。
type fakeFileInfo struct {
	name string
	dir  bool
}

func (f fakeFileInfo) Name() string       { return f.name }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() os.FileMode  { return 0 }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.dir }
func (f fakeFileInfo) Sys() any           { return nil }

func TestChooseOpenRejectsIllegalExtension(t *testing.T) {
	runner := &fakeRunner{}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	result := invoke(t, srv, native.CommandPathChooseOpen, map[string]any{
		"filters": []map[string]any{{"name": "bad", "extensions": []string{"csv;rm -rf /"}}},
	})
	if result.OK || result.Code != native.CodeInvalid {
		t.Fatalf("非法扩展名结果 = %+v，期望 invalid", result)
	}
	if runs, _ := runner.calls(); len(runs) != 0 {
		t.Fatalf("输入非法时不应调用外部命令: %#v", runs)
	}
}

func TestDarwinAppleScriptsCompile(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("只有 darwin 提供 osacompile")
	}
	if _, err := os.Stat("/usr/bin/osacompile"); err != nil {
		t.Skip("未找到 /usr/bin/osacompile")
	}

	dir := tempDir(t)
	runner := &fakeRunner{}
	runner.runFn = func(string, []string) native.CommandResult {
		return native.CommandResult{Stdout: []byte("/tmp/x\n")}
	}
	srv := platformServer(t, native.Options{
		GOOS:   "darwin",
		Exists: func(string) bool { return true },
	}, runner)

	inputs := []struct {
		command string
		input   map[string]any
	}{
		{native.CommandPathChooseOpen, map[string]any{
			"multiple":    true,
			"title":       "脚本语法",
			"defaultPath": dir,
			"filters":     []map[string]any{{"name": "表格", "extensions": []string{"csv", "txt"}}},
		}},
		{native.CommandPathChooseOpen, map[string]any{}},
		{native.CommandPathChooseDirectory, map[string]any{"multiple": true, "defaultPath": dir}},
		{native.CommandPathChooseSave, map[string]any{"defaultName": "x.csv", "defaultPath": dir}},
		{native.CommandPathChooseSave, map[string]any{}},
	}
	for _, item := range inputs {
		if result := invoke(t, srv, item.command, item.input); !result.OK {
			t.Fatalf("%s 失败: %+v", item.command, result)
		}
	}

	runs, _ := runner.calls()
	if len(runs) != len(inputs) {
		t.Fatalf("脚本数量 = %d，期望 %d", len(runs), len(inputs))
	}
	for index, call := range runs {
		if call.Name != "/usr/bin/osascript" {
			t.Fatalf("第 %d 个脚本不是 osascript: %q", index, call.Name)
		}
		target := t.TempDir() + "/script.scpt"
		cmd := exec.Command("/usr/bin/osacompile", "-e", call.Args[1], "-o", target)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("第 %d 个 AppleScript 语法错误: %v\n%s\n脚本:\n%s", index, err, output, call.Args[1])
		}
	}
}

// exitError 是只关心退出码的测试错误。
type exitError struct{ code int }

func (e exitError) Error() string { return "exit status " + strconv.Itoa(e.code) }
func (e exitError) ExitCode() int { return e.code }
