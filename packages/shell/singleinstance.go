package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"
)

// lockFileName 是单实例锁文件。它同时承担两个职责：互斥（谁先启动）与寻址
// （第二个实例该把「激活」发给谁）。
//
// 不用操作系统的互斥原语（Unix flock / Windows 命名互斥体），是因为那套东西
// 在「进程被强杀后锁是否释放」上两个平台行为不同，而锁文件 + pid 存活检查 +
// 尝试连接激活端口，三个信号一起判断，跨平台语义完全一致。
const lockFileName = "shell.lock"

// mkdirPerm 与 data 目录的其他部分保持一致。
const mkdirPerm = 0o755

type lockRecord struct {
	PID  int `json:"pid"`
	Port int `json:"port"`
}

// instance 是「本进程是唯一实例」的凭据。release 会删掉锁文件并关闭监听。
type instance struct {
	path string
	ln   net.Listener
}

// acquireSingleInstanceLock 尝试成为唯一实例。
//
// 返回 alreadyRunning=true 表示已有一个活着的实例被通知「把窗口提到前台」，
// 调用方应当立即退出——不是错误，是正常的第二次双击。
func acquireSingleInstanceLock(dataDir string) (*instance, bool, error) {
	if err := os.MkdirAll(dataDir, mkdirPerm); err != nil {
		return nil, false, fmt.Errorf("无法创建数据目录: %w", err)
	}
	path := filepath.Join(dataDir, lockFileName)

	// 竞争只可能发生在同一个用户几乎同时双击两次，三次重试绰绰有余。
	// 不无限重试：真的抢不到就该报错，而不是挂在这里。
	for attempt := 0; attempt < 3; attempt++ {
		if rec, ok := readLockRecord(path); ok {
			if err := requestActivate(rec.Port); err == nil {
				return nil, true, nil
			}
			// 连不上说明那个 pid 已经不在了。锁文件是上一次被强杀留下的。
			_ = os.Remove(path)
			continue
		}

		// 必须先绑端口再写锁：否则第二个实例读到锁时端口还不存在，
		// 会把「正在启动」误判成「已死」。
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, false, fmt.Errorf("无法创建激活端口: %w", err)
		}
		port := ln.Addr().(*net.TCPAddr).Port

		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			_ = ln.Close()
			if errors.Is(err, os.ErrExist) {
				continue // 被别人抢先写了，回到循环顶部去通知它
			}
			return nil, false, fmt.Errorf("无法写入锁文件: %w", err)
		}

		body, _ := json.Marshal(lockRecord{PID: os.Getpid(), Port: port})
		_, writeErr := file.Write(body)
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			_ = os.Remove(path)
			_ = ln.Close()
			return nil, false, fmt.Errorf("无法写入锁文件: %w", errors.Join(writeErr, closeErr))
		}

		return &instance{path: path, ln: ln}, false, nil
	}

	return nil, false, fmt.Errorf("无法获得单实例锁（%s）", path)
}

// serve 在后台接受「激活」请求。onActivate 会被串行调用。
func (i *instance) serve(onActivate func()) {
	go func() {
		for {
			conn, err := i.ln.Accept()
			if err != nil {
				return // 监听已关闭，正常退出
			}
			// 请求内容不重要：能连上就代表「再来一次」。
			_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
			var buf [64]byte
			_, _ = conn.Read(buf[:])
			_ = conn.Close()
			onActivate()
		}
	}()
}

func (i *instance) release() {
	_ = i.ln.Close()
	_ = os.Remove(i.path)
}

func readLockRecord(path string) (lockRecord, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return lockRecord{}, false
	}
	var rec lockRecord
	if err := json.Unmarshal(data, &rec); err != nil || rec.Port <= 0 {
		// 写了一半就被杀：内容不可信，当作残留处理
		return lockRecord{}, false
	}
	return rec, true
}

// requestActivate 通知已有实例把窗口提到前台。
func requestActivate(port int) error {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	_, err = conn.Write([]byte("activate\n"))
	return err
}
