package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseHandshake(t *testing.T) {
	t.Run("正常握手行", func(t *testing.T) {
		line := handshakePrefix + `{"ready":true,"port":4321,"token":"abc+/=","version":"1.0.0","failures":[]}`
		addr, err := parseHandshake(line)
		if err != nil {
			t.Fatalf("解析失败: %v", err)
		}
		if addr.port != 4321 {
			t.Fatalf("端口 = %d，期望 4321", addr.port)
		}
		// token 含 + / = 时必须转义：这些字符在 URL 里有特殊含义，
		// 直接拼进 fragment 会让前端解析出一半 token。
		if strings.Contains(addr.url, "abc+/=") {
			t.Fatalf("token 未转义: %s", addr.url)
		}
		if !strings.Contains(addr.url, "#token=") {
			t.Fatalf("token 应放在 fragment 里: %s", addr.url)
		}
	})

	t.Run("未就绪的行不当作就绪", func(t *testing.T) {
		_, err := parseHandshake(handshakePrefix + `{"ready":false,"port":4321,"token":"x"}`)
		if err == nil {
			t.Fatal("ready=false 应当报错")
		}
	})

	t.Run("缺端口的行不当作就绪", func(t *testing.T) {
		_, err := parseHandshake(handshakePrefix + `{"ready":true,"token":"x"}`)
		if err == nil {
			t.Fatal("port=0 应当报错")
		}
	})

	t.Run("非法 JSON 报错而非 panic", func(t *testing.T) {
		if _, err := parseHandshake(handshakePrefix + `{oops`); err == nil {
			t.Fatal("非法 JSON 应当报错")
		}
	})
}

func TestFilterEnv(t *testing.T) {
	env := []string{"PATH=/usr/bin", "NODE_OPTIONS=--inspect", "HOME=/root", "NODE_PATH=/x"}
	got := filterEnv(env, "NODE_OPTIONS", "NODE_PATH")
	want := []string{"PATH=/usr/bin", "HOME=/root"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("filterEnv = %v，期望 %v", got, want)
	}
}

func TestSupervisorStopIsIdempotent(t *testing.T) {
	// stop 会被 defer 与信号处理器各调一次；第二次必须是空操作，
	// 否则会在进程已 Wait 之后再去 kill，产生无意义报错。
	s := &supervisor{exited: make(chan struct{})}
	close(s.exited)
	s.stop()
	s.stop()
}

func TestSingleInstanceLock(t *testing.T) {
	dir := t.TempDir()

	first, already, err := acquireSingleInstanceLock(dir)
	if err != nil {
		t.Fatalf("第一次加锁失败: %v", err)
	}
	if already {
		t.Fatal("第一次加锁不该是 alreadyRunning")
	}
	defer first.release()

	record, ok := readLockRecord(filepath.Join(dir, lockFileName))
	if !ok {
		t.Fatal("锁文件应可读")
	}
	if record.PID != os.Getpid() {
		t.Fatalf("锁文件 pid = %d，期望 %d", record.PID, os.Getpid())
	}

	// 第二次拿到的是「已有实例」，而且确实发出了激活请求
	activated := make(chan struct{}, 1)
	first.serve(func() { activated <- struct{}{} })

	second, already, err := acquireSingleInstanceLock(dir)
	if err != nil {
		t.Fatalf("第二次加锁失败: %v", err)
	}
	if second != nil {
		t.Fatal("第二次不该拿到锁")
	}
	if !already {
		t.Fatal("第二次应当是 alreadyRunning")
	}

	select {
	case <-activated:
	case <-time.After(2 * time.Second):
		t.Fatal("已有实例没有收到激活请求")
	}
}

func TestSingleInstanceLockTakesOverStaleLock(t *testing.T) {
	dir := t.TempDir()
	// 模拟「上一次被强杀」：锁文件还在，但里面的端口没人监听
	stale := `{"pid":999999,"port":1}`
	if err := os.WriteFile(filepath.Join(dir, lockFileName), []byte(stale), 0o600); err != nil {
		t.Fatal(err)
	}

	inst, already, err := acquireSingleInstanceLock(dir)
	if err != nil {
		t.Fatalf("接管陈旧锁失败: %v", err)
	}
	if already || inst == nil {
		t.Fatal("陈旧的锁应当被接管，而不是当成已有实例")
	}
	inst.release()
}

func TestSingleInstanceReleaseRemovesLock(t *testing.T) {
	dir := t.TempDir()
	inst, _, err := acquireSingleInstanceLock(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, lockFileName)
	inst.release()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("释放后锁文件应当不存在")
	}
}

func TestWaitReadyWhenSupervisorExitsEarly(t *testing.T) {
	s := &supervisor{
		ready:  make(chan address, 1),
		exited: make(chan struct{}),
	}
	close(s.exited)

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	if _, err := s.waitReady(ctx); err == nil {
		t.Fatal("supervisor 提前退出时 waitReady 应当报错")
	}
}

func TestWaitReadyTimeout(t *testing.T) {
	s := &supervisor{ready: make(chan address, 1), exited: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()

	if _, err := s.waitReady(ctx); err == nil {
		t.Fatal("超时应当报错")
	}
}

func TestActivateRequestsCoalesce(t *testing.T) {
	// 用户连点五次图标，不该排队五次前台化——窗口只需要被提到最前一次。
	activateWindow()
	activateWindow()
	activateWindow()

	if len(activateRequest) != 1 {
		t.Fatalf("激活请求应被合并为 1 个，实际 %d 个", len(activateRequest))
	}
	<-activateRequest
}

func TestIsTempBinary(t *testing.T) {
	tmp := os.TempDir()
	if !isTempBinary(filepath.Join(tmp, "go-build123", "b001", "exe", "main")) {
		t.Fatal("临时目录下的二进制应当被识别")
	}
	if isTempBinary("/usr/local/bin/cordis-app") {
		t.Fatal("安装目录下的二进制不该被识别为临时二进制")
	}
}
