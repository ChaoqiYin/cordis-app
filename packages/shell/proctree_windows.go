//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

var (
	kernel32                     = syscall.NewLazyDLL("kernel32.dll")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procOpenProcess              = kernel32.NewProc("OpenProcess")
	procCloseHandle              = kernel32.NewProc("CloseHandle")

	// 外壳自己的 Job Object。全局一份即可——每个外壳进程只拉起一个 supervisor。
	shellJob syscall.Handle
)

const (
	processSetQuota         = 0x0100
	processTerminate        = 0x0001
	jobObjectExtendedLimits = 9

	// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE：外壳进程无论怎么死（包括被任务管理器
	// 强杀），关闭最后一个句柄时内核会连同整棵子进程树一起终止。
	jobObjectLimitKillOnJobClose = 0x2000
)

// jobObjectExtendedLimitInformation 的布局必须与 winnt.h 一致。
// 结构对不上时 SetInformationJobObject 会失败，而失败是静默的——外壳照常
// 运行，只是退出后再也收不回子进程。所以只写用得到的字段，其余留零。
type jobObjectExtendedLimitInformation struct {
	basicLimitInformation jobObjectBasicLimitInformation
	ioInfo                [6]uint64
	processMemoryLimit    uintptr
	jobMemoryLimit        uintptr
	peakProcessMemoryUsed uintptr
	peakJobMemoryUsed     uintptr
}

type jobObjectBasicLimitInformation struct {
	perProcessUserTimeLimit int64
	perJobUserTimeLimit     int64
	limitFlags              uint32
	minimumWorkingSetSize   uintptr
	maximumWorkingSetSize   uintptr
	activeProcessLimit      uint32
	affinity                uintptr
	priorityClass           uint32
	schedulingClass         uint32
}

// setProcessGroup 在 Windows 上没有进程组。
//
// 这里只设 CREATE_NEW_PROCESS_GROUP，让 supervisor 有自己的控制台事件通道；
// 真正的回收由 attachToJob 的 Job Object 完成。
func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP
}

// attachToJob 把 supervisor 放进外壳的 Job Object。
//
// 必须在 cmd.Start() 之后立刻调用：中间这段窗口里进程已经存在但还不受 Job 管，
// 外壳若在此期间崩溃，它就会漏出去。
func attachToJob(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	job, err := ensureJob()
	if err != nil {
		fmt.Fprintf(os.Stderr, "无法创建 Job Object，退出时可能留下子进程: %v\n", err)
		return
	}

	handle, _, callErr := procOpenProcess.Call(processSetQuota|processTerminate, 0, uintptr(cmd.Process.Pid))
	if handle == 0 {
		fmt.Fprintf(os.Stderr, "无法打开 supervisor 进程句柄: %v\n", callErr)
		return
	}
	defer procCloseHandle.Call(handle)

	if ok, _, callErr := procAssignProcessToJobObject.Call(uintptr(job), handle); ok == 0 {
		fmt.Fprintf(os.Stderr, "无法把 supervisor 加入 Job Object: %v\n", callErr)
	}
}

func ensureJob() (syscall.Handle, error) {
	if shellJob != 0 {
		return shellJob, nil
	}
	handle, _, callErr := procCreateJobObjectW.Call(0, 0)
	if handle == 0 {
		return 0, callErr
	}

	var info jobObjectExtendedLimitInformation
	info.basicLimitInformation.limitFlags = jobObjectLimitKillOnJobClose
	ok, _, callErr := procSetInformationJobObject.Call(
		handle,
		jobObjectExtendedLimits,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if ok == 0 {
		procCloseHandle.Call(handle)
		return 0, callErr
	}

	shellJob = syscall.Handle(handle)
	return shellJob, nil
}

// terminateProcessTree 在 Windows 上只能硬杀：进程没有可捕获的 SIGTERM。
// Job Object 的 KILL_ON_JOB_CLOSE 会覆盖整棵树，所以直接关句柄即可。
func terminateProcessTree(cmd *exec.Cmd) {
	if shellJob != 0 {
		if h := syscall.Handle(shellJob); h != 0 {
			procCloseHandle.Call(uintptr(h))
			shellJob = 0
		}
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func killProcessTree(cmd *exec.Cmd) {
	terminateProcessTree(cmd)
}

// binPath 在 Windows 上前置 bin/、保留原有目录。
//
// 系统 DLL 的查找依赖 System32 等目录，清空会让 node 甚至外壳自身启动失败。
// 这个差异是平台事实，不是设计取舍。
func binPath(binDir, original string) string {
	if original == "" {
		return binDir
	}
	return binDir + string(os.PathListSeparator) + original
}
