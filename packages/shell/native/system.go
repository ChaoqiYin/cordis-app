package native

import "context"

// 系统外观。无法探测时返回 unknown，不猜一个错误主题。
const (
	themeLight   = "light"
	themeDark    = "dark"
	themeUnknown = "unknown"
)

// systemInfoOutput 对应 protocol 的 NativeSystemInfo。
type systemInfoOutput struct {
	Platform  string `json:"platform"`
	Arch      string `json:"arch"`
	Release   string `json:"release"`
	Theme     string `json:"theme"`
	HasWindow bool   `json:"hasWindow"`
}

// systemInfo 汇总平台、架构、发行版本、外观与窗口状态。
//
// 发行版本与主题探测失败不应让整个命令失败：主题返回 unknown，发行版本留空，
// 调用方仍能拿到其余字段。
func systemInfo(ctx context.Context, opts Options) (any, error) {
	return systemInfoOutput{
		Platform:  opts.GOOS,
		Arch:      opts.Arch,
		Release:   platformRelease(ctx, opts),
		Theme:     platformTheme(ctx, opts),
		HasWindow: opts.HasWindow,
	}, nil
}

func platformRelease(ctx context.Context, opts Options) string {
	switch opts.GOOS {
	case "darwin":
		return darwinRelease(ctx, opts)
	case "windows":
		return windowsRelease(ctx, opts)
	case "linux":
		return linuxRelease(ctx, opts)
	default:
		return ""
	}
}

func platformTheme(ctx context.Context, opts Options) string {
	switch opts.GOOS {
	case "darwin":
		return darwinTheme(ctx, opts)
	case "windows":
		return windowsTheme(ctx, opts)
	case "linux":
		return linuxTheme(ctx, opts)
	default:
		return themeUnknown
	}
}
