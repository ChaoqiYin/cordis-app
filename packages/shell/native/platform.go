package native

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"runtime"
)

// CommandResult 是一次外部命令执行的结果。
//
// Runner 把「启动外部工具」从命令实现里隔离出来：测试用假实现观察参数映射，
// 不会弹出真实对话框、发送通知或打开外部程序。
type CommandResult struct {
	Stdout []byte
	Stderr []byte
	Err    error
}

// Runner 是外部命令的执行器。Run 等待命令结束并收集输出，用于路径选择、
// 系统探测等需要结果的操作；Start 只负责启动，用于打开链接、通知、揭示文件
// 等不关心退出码的操作。
type Runner interface {
	Run(ctx context.Context, name string, args ...string) CommandResult
	Start(name string, args ...string) error
}

// execRunner 是 Runner 的默认实现。
type execRunner struct{}

func (execRunner) Run(ctx context.Context, name string, args ...string) CommandResult {
	cmd := exec.CommandContext(ctx, name, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return CommandResult{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), Err: err}
}

func (execRunner) Start(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	// 不 Wait：外部程序由系统接管，父进程不应陪它一起退出。
	go func() { _ = cmd.Wait() }()
	return nil
}

// Options 是平台命令注册所需的全部可替换依赖。
//
// 零值表示使用真实运行环境：GOOS/Arch 取 runtime，Runner 执行真实进程，
// Exists/Stat 访问真实文件系统。测试只需替换需要观察或控制的部分。
type Options struct {
	// GOOS / Arch 是报告给调用方的平台与架构；缺省取 runtime。
	GOOS string
	Arch string
	// HasWindow 表示外壳是否有窗口；--url 降级模式为 false。
	HasWindow bool
	// Window 是窗口命令的原语实现，由外壳注入。HasWindow 为 false 或
	// Window 为 nil 时，window.* 不注册，调用返回 unsupported。
	Window Window
	// Runner 执行外部命令。
	Runner Runner
	// Exists 判断绝对路径是否存在；用于探测 zenity/kdialog 等外部工具。
	Exists func(path string) bool
	// Stat 读取路径信息；用于校验 defaultPath 与 showItemInFolder 的输入。
	Stat func(path string) (os.FileInfo, error)
}

func (o Options) withDefaults() Options {
	if o.GOOS == "" {
		o.GOOS = runtime.GOOS
	}
	if o.Arch == "" {
		o.Arch = runtime.GOARCH
	}
	if o.Runner == nil {
		o.Runner = execRunner{}
	}
	if o.Exists == nil {
		o.Exists = func(path string) bool {
			_, err := os.Stat(path)
			return err == nil
		}
	}
	if o.Stat == nil {
		o.Stat = os.Stat
	}
	return o
}

// RegisterAll 按 Options.GOOS 注册当前平台真正可用的命令。
//
// 外部工具缺失时对应命令不注册，因而不会出现在 /info.commands；调用方据此
// 判断能力，而不是调用后才发现 unsupported。system.info 永远可用。
func RegisterAll(reg *Registry, opts Options) {
	if reg == nil {
		panic("native: RegisterAll 的 registry 为 nil")
	}
	opts = opts.withDefaults()
	switch opts.GOOS {
	case "darwin":
		registerDarwin(reg, opts)
	case "windows":
		registerWindows(reg, opts)
	case "linux":
		registerLinux(reg, opts)
	default:
		registerWindow(reg, opts)
		registerSystemInfo(reg, opts)
	}
}

// firstExisting 返回候选绝对路径中第一个存在的项。
func firstExisting(opts Options, candidates ...string) string {
	for _, candidate := range candidates {
		if opts.Exists(candidate) {
			return candidate
		}
	}
	return ""
}

// globPatterns 把扩展名列表转成对话框工具需要的 `*.ext` 形式。
func globPatterns(extensions []string) []string {
	patterns := make([]string, 0, len(extensions))
	for _, extension := range extensions {
		patterns = append(patterns, "*."+extension)
	}
	return patterns
}

// registerSystemInfo 在所有平台注册系统信息命令。
func registerSystemInfo(reg *Registry, opts Options) {
	reg.Register(CommandSystemInfo, func(ctx context.Context, _ json.RawMessage) (any, error) {
		return systemInfo(ctx, opts)
	})
}
