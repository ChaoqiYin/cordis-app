// Package native 实现桌面外壳暴露给 worker 的回环原生命令服务。
//
// 它只负责传输、鉴权、命令分发与并发约束；具体平台原语由调用方注册。契约的
// 字符串真源在 packages/protocol/src/native.ts，两侧必须逐字一致。
package native

import (
	"context"
	"encoding/json"
	"sync"
)

// ContractVersion 是原生能力契约版本。
//
// 必须与 packages/protocol/src/native.ts 的 NATIVE_CONTRACT_VERSION 一致；
// 不匹配时 worker 会关闭原生能力。
const ContractVersion = 1

// v1 命令名。必须与 packages/protocol/src/native.ts 的 NATIVE_COMMANDS
// 逐字一致；具体平台实现通过这些常量注册，避免手写字符串出现拼写漂移。
const (
	CommandPathChooseOpen        = "path.chooseOpen"
	CommandPathChooseDirectory   = "path.chooseDirectory"
	CommandPathChooseSave        = "path.chooseSave"
	CommandWindowSetTitle        = "window.setTitle"
	CommandWindowSetSize         = "window.setSize"
	CommandWindowMinimize        = "window.minimize"
	CommandWindowMaximize        = "window.maximize"
	CommandWindowRestore         = "window.restore"
	CommandWindowFocus           = "window.focus"
	CommandWindowClose           = "window.close"
	CommandWindowState           = "window.state"
	CommandNotificationShow      = "notification.show"
	CommandShellOpenExternal     = "shell.openExternal"
	CommandShellOpenPath         = "shell.openPath"
	CommandShellShowItemInFolder = "shell.showItemInFolder"
	CommandSystemInfo            = "system.info"
)

// contractCommands 是 v1 契约里的全部命令名。它用来区分两种失败：
// 契约里没有的名字是 invalid（调用方写错了），契约里有但本平台没有注册的
// 是 unsupported（能力缺失）。
var contractCommands = map[string]struct{}{
	CommandPathChooseOpen:        {},
	CommandPathChooseDirectory:   {},
	CommandPathChooseSave:        {},
	CommandWindowSetTitle:        {},
	CommandWindowSetSize:         {},
	CommandWindowMinimize:        {},
	CommandWindowMaximize:        {},
	CommandWindowRestore:         {},
	CommandWindowFocus:           {},
	CommandWindowClose:           {},
	CommandWindowState:           {},
	CommandNotificationShow:      {},
	CommandShellOpenExternal:     {},
	CommandShellOpenPath:         {},
	CommandShellShowItemInFolder: {},
	CommandSystemInfo:            {},
}

func isContractCommand(name string) bool {
	_, ok := contractCommands[name]
	return ok
}

// 业务错误码。必须与 packages/protocol/src/native.ts 的 NATIVE_ERROR_CODES
// 逐字一致；HTTP 4xx/5xx 只表示 transport 或鉴权失败，业务结果一律走这些码。
const (
	CodeCancelled   = "cancelled"
	CodeUnsupported = "unsupported"
	CodeDenied      = "denied"
	CodeBusy        = "busy"
	CodeInvalid     = "invalid"
	CodeTimeout     = "timeout"
	CodeInternal    = "internal"
)

// Error 是命令实现返回的业务错误。Message 与 Platform 只用于向调用方补充
// 说明，程序判断一律用 Code。
type Error struct {
	Code     string
	Message  string
	Platform string
}

func (e *Error) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return e.Code
}

// Handler 是一个原生命令的实现。input 是请求体里的原始 JSON，由具体命令
// 自行解码；返回的错误应优先使用 *Error 表达业务错误码。
type Handler func(ctx context.Context, input json.RawMessage) (any, error)

// Registry 保存命令名到实现的映射。
//
// 注册发生在服务开始监听之前，因此读路径只用读锁；命令顺序保持注册顺序，
// 它是 /info.commands 的稳定输出。
type Registry struct {
	mu       sync.RWMutex
	handlers map[string]Handler
	commands []string

	// chooseGate 保证同一时刻只有一个 path.choose*（容量 1）；
	// windowGate 让窗口命令串行执行。两者都在这里，而不是 handler 里，
	// 这样后续新增命令不需要各自重复实现约束。
	chooseGate chan struct{}
	windowGate chan struct{}
}

func NewRegistry() *Registry {
	return &Registry{
		handlers:   make(map[string]Handler),
		commands:   make([]string, 0),
		chooseGate: make(chan struct{}, 1),
		windowGate: make(chan struct{}, 1),
	}
}

// Register 注册一个命令。重复注册或空实现是编程错误，直接 panic：
// 它发生在启动阶段，越早暴露越好。
func (r *Registry) Register(name string, handler Handler) {
	if handler == nil {
		panic("native: 命令 " + name + " 的 handler 为 nil")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.handlers[name]; exists {
		panic("native: 命令重复注册: " + name)
	}
	r.handlers[name] = handler
	r.commands = append(r.commands, name)
}

// Commands 返回已注册的命令名，顺序与注册顺序一致。
func (r *Registry) Commands() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, len(r.commands))
	copy(out, r.commands)
	return out
}

func (r *Registry) lookup(name string) (Handler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	handler, ok := r.handlers[name]
	return handler, ok
}
