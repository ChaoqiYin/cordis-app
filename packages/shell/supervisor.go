package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// handshakePrefix 必须与 protocol 包的 HANDSHAKE_PREFIX 一致。
//
// 这是外壳与 Node 之间唯一的字符串契约。改它等于改协议版本，两侧必须同时改。
const handshakePrefix = "@@CORDIS_APP@@"

// stopGrace 是「请它退出」与「强行杀掉」之间的等待时间。
const stopGrace = 5 * time.Second

// handshake 是 supervisor 写到 stdout 的那一行 JSON。
type handshake struct {
	Ready   bool   `json:"ready"`
	Port    int    `json:"port"`
	Token   string `json:"token"`
	Version string `json:"version"`
	// Failures 是加载失败的插件。外壳只负责告诉用户，不做任何重试——
	// 插件失败的原因（缺依赖、入口抛错）外壳无从判断。
	Failures []struct {
		ID     string `json:"id"`
		Reason string `json:"reason"`
	} `json:"failures"`
}

// address 是外壳唯一需要从握手里取出的东西。
type address struct {
	port  int
	token string
	url   string
}

// supervisor 持有子进程与它的输出管道。
//
// 关键约束：stdout 与 stderr 都必须被持续消费。
// 只读 stdout 会让 supervisor 的日志把管道缓冲区写满，表现为「应用卡死但不报错」。
type supervisor struct {
	cmd *exec.Cmd

	ready  chan address
	exited chan struct{}
	once   sync.Once
}

func startSupervisor(l layout) (*supervisor, error) {
	args := []string{
		l.supervisorJS,
		"--data", l.dataDir,
		"--resources", l.resourcesDir,
	}

	cmd := exec.Command(l.nodeBin, args...)
	// 工作目录固定：supervisor 与 worker 用相对路径解析任何东西时，
	// 都不能受「用户从哪个目录启动外壳」影响。
	cmd.Dir = l.installDir
	cmd.Env = supervisorEnv(l)
	setProcessGroup(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("无法接管 supervisor 的 stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("无法接管 supervisor 的 stderr: %w", err)
	}

	s := &supervisor{
		cmd:    cmd,
		ready:  make(chan address, 1),
		exited: make(chan struct{}),
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 supervisor 失败: %w", err)
	}
	attachToJob(cmd)

	// stdout：只认握手行，其余内容按日志转出
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			if !strings.HasPrefix(line, handshakePrefix) {
				fmt.Fprintln(os.Stderr, "[supervisor]", line)
				continue
			}
			addr, err := parseHandshake(line)
			if err != nil {
				fmt.Fprintf(os.Stderr, "[supervisor] 握手行无法解析: %v\n", err)
				continue
			}
			// worker 重启后 supervisor 会再发一行，端口与 token 不变。
			// 通道容量是 1，重复投递直接丢弃：外壳只在启动时读一次。
			select {
			case s.ready <- addr:
			default:
			}
		}
	}()

	// stderr：必须读，哪怕只是转发——见上面的 pipe 陷阱
	go func() {
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			fmt.Fprintln(os.Stderr, scanner.Text())
		}
	}()

	go func() {
		_ = cmd.Wait()
		close(s.exited)
	}()

	return s, nil
}

// supervisorEnv 构造子进程环境，不继承用户的 shell。
//
// 开发环境不走 PATH 裁剪：`go run` 时 node 本来就来自 PATH，裁掉它会连
// supervisor 都起不来。裁剪只对正式安装生效，那里有随包分发的 node。
func supervisorEnv(l layout) []string {
	env := os.Environ()
	env = append(env,
		"CORDIS_APP_DATA="+l.dataDir,
		"CORDIS_APP_RESOURCES="+l.resourcesDir,
	)
	// 用户 shell 里残留的调试或注入配置会污染 worker
	env = filterEnv(env, "NODE_OPTIONS", "NODE_PATH")

	if l.packaged {
		// Windows 上 PATH 不能只留 bin/：系统 DLL 的查找依赖 System32 等目录，
		// 清空会让 node 甚至外壳自己都起不来。差异由 binPath 的两个实现承担。
		original := os.Getenv("PATH")
		env = filterEnv(env, "PATH")
		env = append(env, "PATH="+binPath(filepath.Join(l.installDir, "bin"), original))

		// 重定向家目录与临时目录，避免插件把状态写进用户主目录。
		// 具体是哪些变量由平台决定——写 HOME 在 Windows 上毫无作用。
		extra := homeVars(l.dataDir)
		env = filterEnv(env, extra.keys...)
		env = append(env, extra.values...)
	}
	return env
}

func filterEnv(env []string, drop ...string) []string {
	out := env[:0]
	for _, entry := range env {
		key := entry
		if i := strings.IndexByte(entry, '='); i >= 0 {
			key = entry[:i]
		}
		skip := false
		for _, d := range drop {
			if key == d {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, entry)
		}
	}
	return out
}

func parseHandshake(line string) (address, error) {
	var hs handshake
	if err := json.Unmarshal([]byte(strings.TrimPrefix(line, handshakePrefix)), &hs); err != nil {
		return address{}, err
	}
	if !hs.Ready || hs.Port <= 0 {
		return address{}, fmt.Errorf("握手行缺少 ready 或 port")
	}
	for _, f := range hs.Failures {
		fmt.Fprintf(os.Stderr, "插件 %s 加载失败: %s\n", f.ID, f.Reason)
	}
	// token 放在 fragment 而不是 query：fragment 不进服务端访问日志，
	// 也不随 Referer 外泄。前端读走后会从地址栏抹掉。
	return address{
		port:  hs.Port,
		token: hs.Token,
		url:   "http://127.0.0.1:" + strconv.Itoa(hs.Port) + "/#token=" + url.QueryEscape(hs.Token),
	}, nil
}

// waitReady 等第一行握手。超时即失败——启动路径不能无限等待。
func (s *supervisor) waitReady(ctx context.Context) (address, error) {
	select {
	case addr := <-s.ready:
		return addr, nil
	case <-s.exited:
		return address{}, fmt.Errorf("supervisor 在就绪前退出")
	case <-ctx.Done():
		return address{}, ctx.Err()
	}
}

// waitExit 阻塞到 supervisor 退出，让降级路径下的进程生命周期与它一致。
func (s *supervisor) waitExit() {
	<-s.exited
}

// stop 终止整棵进程树。
//
// 只杀 supervisor 会留下 worker 成为孤儿——worker 持有监听端口，下次启动会撞上
// EADDRINUSE。所以必须按平台回收整组进程（见 proctree_*.go）。
func (s *supervisor) stop() {
	s.once.Do(func() {
		if s.cmd == nil || s.cmd.Process == nil {
			return
		}
		terminateProcessTree(s.cmd)
		select {
		case <-s.exited:
		case <-time.After(stopGrace):
			killProcessTree(s.cmd)
		}
	})
}
