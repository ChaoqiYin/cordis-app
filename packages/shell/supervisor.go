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

// supervisorArgs 构造 supervisor 的命令行参数。
//
// 项目根一律用 --project（可写数据目录），不再使用含义模糊的 --data。
// 开发形态默认只传项目根与资源根；带 --shell 时 CLI 会补齐固定端口、
// watcher 产物与开发开关。打包形态补上发布契约里的全部字段。
func supervisorArgs(l layout) []string {
	args := []string{
		l.supervisorJS,
		"--project", l.projectRoot,
		"--resources", l.resourcesDir,
	}
	if !l.packaged {
		if l.workerPort > 0 {
			args = append(args, "--port", strconv.Itoa(l.workerPort))
		}
		if l.serverEntry != "" {
			args = append(args, "--server-entry", l.serverEntry)
		}
		if l.localPluginsDir != "" {
			args = append(args, "--local-plugins", l.localPluginsDir)
		}
		if l.dev {
			args = append(args, "--dev")
		}
		return args
	}
	return append(args,
		"--server-entry", l.serverEntry,
		"--app-json", l.appJson,
		"--user-plugins", l.userPluginsDir,
		"--mode", l.mode,
		"--worker", l.workerJS,
	)
}

// windowURL 决定窗口加载的地址。
//
// 没有开发 UI 时就是 supervisor 的静态页面；开发 UI 存在时窗口加载 Vite，
// 握手 token 仍然从 fragment 传进去，代理后面的 worker 用同一套鉴权。
// 降级路径（系统浏览器）也走这里，两种打开方式拿到的是同一个地址。
func windowURL(addr address, devUIURL string) string {
	if devUIURL == "" {
		return addr.url
	}
	return strings.TrimRight(devUIURL, "/") + "/#token=" + url.QueryEscape(addr.token)
}

// nativeEndpoint 是外壳生成的回环原生服务地址与凭据。
//
// 两个变量在启动 supervisor 之前就已确定，worker 重启不会改变它们；supervisor
// 只负责把它们原样转发给 worker。
type nativeEndpoint struct {
	url   string
	token string
}

// 环境变量名必须与 packages/protocol/src/native.ts 的 ENV_NATIVE_URL /
// ENV_NATIVE_TOKEN 逐字一致。
const (
	nativeURLEnv   = "CORDIS_APP_NATIVE_URL"
	nativeTokenEnv = "CORDIS_APP_NATIVE_TOKEN"
)

func startSupervisor(l layout, nativeEp nativeEndpoint) (*supervisor, error) {
	args := supervisorArgs(l)

	cmd := exec.Command(l.nodeBin, args...)
	// 工作目录固定：supervisor 与 worker 用相对路径解析任何东西时，
	// 都不能受「用户从哪个目录启动外壳」影响。打包形态用可写数据目录，
	// 不依赖只读的安装目录。
	cmd.Dir = l.installDir
	if l.packaged {
		cmd.Dir = l.dataDir
	}
	cmd.Env = supervisorEnv(l, nativeEp)
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
func supervisorEnv(l layout, nativeEp nativeEndpoint) []string {
	env := os.Environ()

	// 必须先移除外层注入的 CORDIS_APP_*：用户 shell 里残留的调试配置不能
	// 劫持项目根、资源根或原生端点。之后只写外壳自己的值，保证每个键只出现一次。
	env = filterEnv(env,
		"NODE_OPTIONS", "NODE_PATH",
		"CORDIS_APP_DATA", "CORDIS_APP_RESOURCES",
		"CORDIS_APP_PROJECT", "CORDIS_APP_BUNDLE_PUBLIC_KEY",
		nativeURLEnv, nativeTokenEnv,
	)

	env = append(env,
		"CORDIS_APP_DATA="+l.dataDir,
		"CORDIS_APP_PROJECT="+l.projectRoot,
		"CORDIS_APP_RESOURCES="+l.resourcesDir,
	)

	if nativeEp.url != "" {
		env = append(env, nativeURLEnv+"="+nativeEp.url)
	}
	if nativeEp.token != "" {
		env = append(env, nativeTokenEnv+"="+nativeEp.token)
	}

	if key := bundlePublicKey(l); key != "" {
		env = append(env, "CORDIS_APP_BUNDLE_PUBLIC_KEY="+key)
	}

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

// bundlePublicKey 解析可信公钥：启动环境 > 随包 PEM > 不注入。
//
// 环境变量的值是 PEM 内容而不是路径——worker 直接把它当 publicKey 用。
// 两个来源都没有（或随包文件读不出来）时只警告、不失败：没有公钥是合法
// 配置，worker 会保持 fail-closed，拒绝安装签名插件包。
func bundlePublicKey(l layout) string {
	if key := os.Getenv("CORDIS_APP_BUNDLE_PUBLIC_KEY"); key != "" {
		return key
	}
	if l.bundlePublicKeyFile == "" {
		warnMissingPublicKey()
		return ""
	}
	data, err := os.ReadFile(l.bundlePublicKeyFile)
	if err != nil {
		warnMissingPublicKey()
		return ""
	}
	return string(data)
}

func warnMissingPublicKey() {
	fmt.Fprintln(os.Stderr,
		"警告：启动环境与随包 PEM 都没有提供插件包签名公钥；"+
			"worker 将保持 fail-closed，拒绝安装签名插件包。")
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
