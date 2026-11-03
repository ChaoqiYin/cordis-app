package native

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

// nativePathFilter 对应 protocol 里的 NativePathFilter：extensions 不含点，
// `*` 表示所有文件。
type nativePathFilter struct {
	Name       string   `json:"name"`
	Extensions []string `json:"extensions"`
}

type chooseOpenInput struct {
	Multiple    bool               `json:"multiple"`
	Filters     []nativePathFilter `json:"filters"`
	Title       string             `json:"title"`
	DefaultPath string             `json:"defaultPath"`
}

type chooseDirectoryInput struct {
	Multiple    bool   `json:"multiple"`
	Title       string `json:"title"`
	DefaultPath string `json:"defaultPath"`
}

type chooseSaveInput struct {
	Filters     []nativePathFilter `json:"filters"`
	DefaultName string             `json:"defaultName"`
	Title       string             `json:"title"`
	DefaultPath string             `json:"defaultPath"`
}

type notificationShowInput struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

type shellOpenExternalInput struct {
	URL string `json:"url"`
}

type shellShowItemInFolderInput struct {
	Path string `json:"path"`
}

type pathsOutput struct {
	Paths []string `json:"paths"`
}

type pathOutput struct {
	Path string `json:"path"`
}

// decodeInput 把请求体里的原始 JSON 解码到目标结构。缺失 input 视为空对象，
// 与 protocol 里「无输入使用 {}」的约定一致；非法 JSON 属于调用方错误。
func decodeInput(raw json.RawMessage, target any) error {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return &Error{Code: CodeInvalid, Message: "输入参数不是合法的 JSON: " + err.Error()}
	}
	return nil
}

// normalizeFilters 校验并规范化过滤项，返回用于各平台命令行的扩展名列表。
//
// extensions 来自调用方，最终会作为独立进程参数传给系统工具，不经过 shell；
// 这里只拒绝明显不合法的字符，避免过滤器语法被意外拆开。
func normalizeFilters(filters []nativePathFilter) ([]nativePathFilter, *Error) {
	normalized := make([]nativePathFilter, 0, len(filters))
	for _, filter := range filters {
		if len(filter.Extensions) == 0 {
			continue
		}
		extensions := make([]string, 0, len(filter.Extensions))
		for _, extension := range filter.Extensions {
			extension = strings.TrimSpace(strings.TrimPrefix(extension, "."))
			if extension == "" {
				return nil, &Error{Code: CodeInvalid, Message: "文件过滤器的扩展名不能为空"}
			}
			if extension != "*" {
				for _, r := range extension {
					if !isExtensionRune(r) {
						return nil, &Error{
							Code:    CodeInvalid,
							Message: fmt.Sprintf("扩展名 %q 含非法字符", extension),
						}
					}
				}
			}
			extensions = append(extensions, extension)
		}
		name := strings.TrimSpace(filter.Name)
		if name == "" {
			name = strings.Join(extensions, ", ")
		}
		normalized = append(normalized, nativePathFilter{Name: name, Extensions: extensions})
	}
	return normalized, nil
}

func isExtensionRune(r rune) bool {
	return r == '*' || r == '_' || r == '-' || r == '+' ||
		(r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}

// wildcardFilter 表示「所有文件」；任一过滤项含 `*` 时无需再给其他过滤条件。
func wildcardFilter(filters []nativePathFilter) bool {
	for _, filter := range filters {
		for _, extension := range filter.Extensions {
			if extension == "*" {
				return true
			}
		}
	}
	return false
}

// defaultDirectory 解析 defaultPath：目录原样返回，文件取其所在目录，
// 不存在的路径忽略。返回空表示没有可用的默认位置。
func defaultDirectory(opts Options, defaultPath string) string {
	if defaultPath == "" {
		return ""
	}
	info, err := opts.Stat(defaultPath)
	if err != nil {
		return ""
	}
	if info.IsDir() {
		return defaultPath
	}
	return filepath.Dir(defaultPath)
}

// errorFromResult 把外部命令的非零退出映射成业务错误。
//
// 用户取消是交互命令的正常结果：osascript、zenity、kdialog 都用退出码 1
// 表示取消，因此统一识别为 cancelled。
func errorFromResult(result CommandResult, command string) *Error {
	if result.Err == nil {
		return nil
	}
	if isCancelResult(result) {
		return &Error{Code: CodeCancelled}
	}
	message := strings.TrimSpace(string(result.Stderr))
	if message == "" {
		message = result.Err.Error()
	}
	return &Error{Code: CodeInternal, Message: command + " 失败: " + message}
}

func isCancelResult(result CommandResult) bool {
	if exitCode(result.Err) != 1 {
		return false
	}
	stderr := strings.ToLower(string(result.Stderr))
	return strings.Contains(stderr, "-128") ||
		strings.Contains(stderr, "cancel") ||
		strings.Contains(stderr, "取消")
}

func exitCode(err error) int {
	type exitCoder interface{ ExitCode() int }
	if coder, ok := err.(exitCoder); ok {
		return coder.ExitCode()
	}
	return -1
}

// splitLines 把外部工具的多行输出转换成路径列表，保留路径里的空格。
func splitLines(output []byte) []string {
	text := strings.ReplaceAll(string(output), "\r\n", "\n")
	paths := make([]string, 0)
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSuffix(line, "\r")
		if line != "" {
			paths = append(paths, line)
		}
	}
	return paths
}
