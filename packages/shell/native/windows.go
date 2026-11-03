package native

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Windows 平台的外部工具同样使用绝对路径。文件对话框走 COM，不依赖这些工具。
const (
	windowsPowerShell = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	windowsRundll32   = `C:\Windows\System32\rundll32.exe`
	windowsExplorer   = `C:\Windows\explorer.exe`
)

// pathKind 区分三个路径选择命令，Windows COM 对话框实现据此选择 CLSID 与选项。
type pathKind int

const (
	pathOpen pathKind = iota
	pathDirectory
	pathSave
)

func registerWindows(reg *Registry, opts Options) {
	reg.Register(CommandPathChooseOpen, func(ctx context.Context, input json.RawMessage) (any, error) {
		return windowsChoosePath(ctx, opts, pathOpen, input)
	})
	reg.Register(CommandPathChooseDirectory, func(ctx context.Context, input json.RawMessage) (any, error) {
		return windowsChoosePath(ctx, opts, pathDirectory, input)
	})
	reg.Register(CommandPathChooseSave, func(ctx context.Context, input json.RawMessage) (any, error) {
		return windowsChoosePath(ctx, opts, pathSave, input)
	})

	if opts.Exists(windowsPowerShell) {
		reg.Register(CommandNotificationShow, func(ctx context.Context, input json.RawMessage) (any, error) {
			return windowsNotification(ctx, opts, input)
		})
	}

	if opts.Exists(windowsRundll32) {
		reg.Register(CommandShellOpenExternal, openExternalHandler(opts, commandSpec{
			Name: windowsRundll32,
			Args: []string{"url.dll,FileProtocolHandler"},
		}))
	}

	if opts.Exists(windowsExplorer) {
		reg.Register(CommandShellShowItemInFolder, showItemInFolderHandler(opts, windowsExplorer, showItemWindows))
	}

	registerSystemInfo(reg, opts)
}

// windowsNotification 用 PowerShell 的 NotifyIcon 气泡通知。
//
// 不用 WinRT toast：Go 进程没有 AppUserModelID，CreateToastNotifier 会失败。
// 脚本启动后自行停留数秒再退出，因此用 Start 而不是 Run。
func windowsNotification(ctx context.Context, opts Options, input json.RawMessage) (any, error) {
	var in notificationShowInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	script := `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notification = New-Object System.Windows.Forms.NotifyIcon
$notification.Icon = [System.Drawing.SystemIcons]::Information
$notification.BalloonTipTitle = ` + powershellString(in.Title) + `
$notification.BalloonTipText = ` + powershellString(in.Body) + `
$notification.Visible = $true
$notification.ShowBalloonTip(5000)
Start-Sleep -Seconds 6
$notification.Dispose()
`
	if err := opts.Runner.Start(windowsPowerShell, powershellArgs(script)...); err != nil {
		return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("无法发送通知: %v", err)}
	}
	return struct{}{}, nil
}

func powershellArgs(script string) []string {
	return []string{"-NoProfile", "-NonInteractive", "-Command", script}
}

// powershellString 生成 PowerShell 单引号字面量；单引号本身用两个单引号转义。
func powershellString(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// windowsRelease 返回与 Node os.release() 一致的 Windows 版本号。
func windowsRelease(ctx context.Context, opts Options) string {
	if !opts.Exists(windowsPowerShell) {
		return ""
	}
	script := `[System.Environment]::OSVersion.Version.ToString()`
	result := opts.Runner.Run(ctx, windowsPowerShell, powershellArgs(script)...)
	if result.Err != nil {
		return ""
	}
	return strings.TrimSpace(string(result.Stdout))
}

// windowsTheme 读 HKCU 的 AppsUseLightTheme：1 浅色、0 深色。
func windowsTheme(ctx context.Context, opts Options) string {
	if !opts.Exists(windowsPowerShell) {
		return themeUnknown
	}
	script := `$value = (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
if ($value -eq 0) { 'dark' } elseif ($value -eq 1) { 'light' } else { 'unknown' }`
	result := opts.Runner.Run(ctx, windowsPowerShell, powershellArgs(script)...)
	if result.Err != nil {
		return themeUnknown
	}
	switch strings.ToLower(strings.TrimSpace(string(result.Stdout))) {
	case themeDark:
		return themeDark
	case themeLight:
		return themeLight
	default:
		return themeUnknown
	}
}
