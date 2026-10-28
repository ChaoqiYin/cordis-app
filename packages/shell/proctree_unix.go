//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// setProcessGroup 让 supervisor 成为新进程组的组长。
//
// 这样外壳要停止它时可以 `kill(-pgid)` 一次性覆盖 supervisor 与它 fork 出来的
// worker。Unix 没有 Job Object 那种「父进程死了子进程跟着死」的内核保证，
// 进程组是这里唯一能用的等价物（架构文档 2.3）。
func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}

// terminateProcessTree 向整个进程组发 SIGTERM，给它机会优雅收尾。
func terminateProcessTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	// 负 pid 表示「发给这个进程组」；组长就是 supervisor 自己
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM); err != nil {
		_ = cmd.Process.Signal(syscall.SIGTERM)
	}
}

// killProcessTree 是最后的兜底：SIGTERM 没让进程组退出就 SIGKILL。
func killProcessTree(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}

// attachToJob 在 Unix 上没有对应物——进程组已经保证了回收。
func attachToJob(*exec.Cmd) {}

// binPath 在 Unix 上只留 bin/：解析到的 node、包管理器必须是随包分发的那一份。
//
// 副作用是插件调用 git、ffmpeg 之类的外部命令会失败。这是刻意的（架构文档 11.6）：
// 让「依赖系统已安装工具」在开发期暴露，而不是在另一台机器上才崩。
func binPath(binDir, _ string) string {
	return binDir
}
