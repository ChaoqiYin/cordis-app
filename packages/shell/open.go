package main

import (
	"fmt"
	"os/exec"
	"runtime"
)

// openExternal 用系统默认浏览器打开 URL。
//
// 这是 WebView 缺失时的降级路径，与「浏览器模式」共用同一套行为——它不返回
// 进程句柄，也不等待浏览器退出：用户关掉浏览器不代表应用该退出。
func openExternal(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		// rundll32 比 `cmd /c start` 少一层 shell：URL 里的 & 不会被 cmd 当分隔符
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("无法启动系统浏览器: %w", err)
	}
	// 不 Wait：子进程被 shell 接管后与我们无关，Wait 反而会在某些平台上
	// 让父进程跟着收到同名信号。
	go func() { _ = cmd.Wait() }()
	return nil
}
