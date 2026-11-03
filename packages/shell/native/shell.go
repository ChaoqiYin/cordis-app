package native

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"runtime"
	"strings"
)

// commandSpec 是一个外部工具调用：可执行文件的绝对路径与固定参数前缀。
type commandSpec struct {
	Name string
	Args []string
}

// OpenExternal 用系统默认处理器打开 URL。
//
// 外壳自身的浏览器降级路径也复用它，因此与 shell.openExternal 命令共享同一
// 套 scheme allowlist 与绝对路径规则。
func OpenExternal(raw string) error {
	if nativeErr := validateExternalURL(raw); nativeErr != nil {
		return fmt.Errorf("%s", nativeErr.Message)
	}
	spec, ok := defaultExternalOpener()
	if !ok {
		return fmt.Errorf("当前平台没有可用的打开链接工具")
	}
	args := append(append([]string(nil), spec.Args...), raw)
	return (execRunner{}).Start(spec.Name, args...)
}

func defaultExternalOpener() (commandSpec, bool) {
	switch runtime.GOOS {
	case "darwin":
		return commandSpec{Name: darwinOpen}, true
	case "windows":
		return commandSpec{Name: windowsRundll32, Args: []string{"url.dll,FileProtocolHandler"}}, true
	case "linux":
		opts := Options{}.withDefaults()
		if path := firstExisting(opts, splitCandidates(linuxXdgOpenCandidates)...); path != "" {
			return commandSpec{Name: path}, true
		}
		return commandSpec{}, false
	default:
		return commandSpec{}, false
	}
}

// showItemStyle 决定「在文件夹中显示」各平台使用哪种参数形式。
type showItemStyle int

const (
	showItemDarwin showItemStyle = iota
	showItemWindows
	showItemLinux
)

// validateExternalURL 只允许 http、https、mailto。
//
// 这是防页面/插件借外壳启动任意本地程序或其它 scheme 处理器的最小 allowlist；
// 其它 scheme 一律 invalid，不传给系统。
func validateExternalURL(raw string) *Error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return &Error{Code: CodeInvalid, Message: "非法 URL: " + err.Error()}
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https", "mailto":
		return nil
	}
	return &Error{Code: CodeInvalid, Message: "只允许打开 http、https、mailto 链接"}
}

// openExternalHandler 校验 URL scheme 后交给平台打开器。
func openExternalHandler(opts Options, spec commandSpec) Handler {
	return func(_ context.Context, input json.RawMessage) (any, error) {
		var in shellOpenExternalInput
		if err := decodeInput(input, &in); err != nil {
			return nil, err
		}
		if nativeErr := validateExternalURL(in.URL); nativeErr != nil {
			return nil, nativeErr
		}
		args := append(append([]string(nil), spec.Args...), in.URL)
		if err := opts.Runner.Start(spec.Name, args...); err != nil {
			return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("无法打开链接: %v", err)}
		}
		return struct{}{}, nil
	}
}

// showItemInFolderHandler 在文件管理器中定位路径。
func showItemInFolderHandler(opts Options, opener string, style showItemStyle) Handler {
	return func(_ context.Context, input json.RawMessage) (any, error) {
		var in shellShowItemInFolderInput
		if err := decodeInput(input, &in); err != nil {
			return nil, err
		}
		if strings.TrimSpace(in.Path) == "" {
			return nil, &Error{Code: CodeInvalid, Message: "path 不能为空"}
		}
		info, statErr := opts.Stat(in.Path)
		if statErr != nil {
			return nil, &Error{Code: CodeInvalid, Message: "路径不存在: " + in.Path}
		}

		var err error
		switch style {
		case showItemDarwin:
			err = opts.Runner.Start(opener, "-R", in.Path)
		case showItemWindows:
			err = opts.Runner.Start(opener, "/select,"+in.Path)
		default:
			target := in.Path
			if !info.IsDir() {
				target = filepath.Dir(in.Path)
			}
			err = opts.Runner.Start(opener, target)
		}
		if err != nil {
			return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("无法定位文件: %v", err)}
		}
		return struct{}{}, nil
	}
}
