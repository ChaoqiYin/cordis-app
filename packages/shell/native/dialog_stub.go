//go:build !windows

package native

import (
	"context"
	"encoding/json"
)

// windowsChoosePath 是 Windows COM 对话框在非 Windows 构建里的占位实现。
// 它只用于让 go test（在 darwin/linux 上）仍能编译并观察注册表；真实调用在
// Windows 上由 dialog_windows.go 接管。
func windowsChoosePath(_ context.Context, _ Options, _ pathKind, _ json.RawMessage) (any, error) {
	return nil, &Error{Code: CodeUnsupported, Message: "当前构建不支持 Windows 文件对话框"}
}
