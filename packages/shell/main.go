// Package main 是桌面外壳。
//
// 职责被刻意压到最小（架构文档 2.3）：拉起 supervisor、读一行握手、开窗。
// 它不解析配置、不加载插件、不代理 HTTP、不在页面与后端之间传话——任何一项
// 都会让「浏览器模式」与「桌面模式」出现分叉，而后者本该只是前者的加壳版本。
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// startupTimeout 是等握手的上限。超过它说明已经卡住，继续等只会让用户
// 盯着一个没有窗口的进程。
const startupTimeout = 60 * time.Second

func main() {
	dataFlag := flag.String("data", "", "数据目录（默认按平台标准目录）")
	resourcesFlag := flag.String("resources", "", "UI 产物目录")
	urlOnly := flag.Bool("url", false, "只启动并打印访问地址，不开窗（等同浏览器模式）")
	debug := flag.Bool("debug", false, "打开 WebView 开发者工具")
	flag.Parse()

	l, err := discoverLayout(*dataFlag, *resourcesFlag)
	if err != nil {
		fatal(err)
	}

	// 释放内嵌 UI 必须在 supervisor 之前：worker 一启动就会去读 resources/ui。
	// 开发模式下 resourcesDir 指向 packages/ui/dist，那里是 Vite 的产出本身，
	// 释放只会把源码树写坏，所以只对正式安装布局执行。
	if l.packaged {
		if packageErr := releaseResources(l); packageErr != nil {
			fatal(packageErr)
		}
	}

	// 单实例锁必须最先拿：第二个实例的正确行为是「把已有窗口提到前台」，
	// 而不是再 fork 一个 supervisor 去抢同一个数据目录。
	inst, alreadyRunning, err := acquireSingleInstanceLock(l.dataDir)
	if err != nil {
		fatal(fmt.Errorf("获取单实例锁失败: %w", err))
	}
	if alreadyRunning {
		// acquire 已经替我们把激活请求发过去了，这里直接退出
		return
	}
	defer inst.release()

	sh, err := startSupervisor(l)
	if err != nil {
		fatal(err)
	}
	defer sh.stop()

	// 信号必须显式接管：Go 的默认行为是「收到 SIGTERM 立即退出」，
	// 而 defer 在这种情况下不会执行——supervisor 与 worker 会全部漏掉。
	// 这正是 Unix 上用进程组补足 Job Object 之外必须自己写的那一半。
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-signals
		sh.stop()
		inst.release()
		if sig == syscall.SIGTERM {
			os.Exit(143)
		}
		os.Exit(130)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), startupTimeout)
	defer cancel()

	addr, err := sh.waitReady(ctx)
	if err != nil {
		// 走到这里说明 supervisor 已经起来但没能握手：必须收回进程树再退出，
		// fatal 的 os.Exit 会跳过 defer。
		sh.stop()
		inst.release()
		fatal(fmt.Errorf("等待 supervisor 就绪失败: %w", err))
	}

	// 降级判定只做一次：webViewUnavailable 读的是注册表，没有理由反复查询，
	// 也避免两次判断结果不一致导致「提示了降级却仍去开窗」。
	degraded := *urlOnly || webViewUnavailable()

	// 第二个实例被激活时，把已有界面带到用户眼前。
	// 窗口模式下由 runWindow 安装的通道处理；浏览器模式下没有窗口可提，
	// 重新打开一次同一个 URL 就是最接近的语义。
	inst.serve(func() {
		if degraded {
			_ = openExternal(addr.url)
			return
		}
		activateWindow()
	})

	if degraded {
		// 降级路径：没装 WebView 运行时就用系统浏览器。功能完整，只少窗口装饰与托盘。
		if !*urlOnly {
			fmt.Fprintln(os.Stderr, "未找到可用的 WebView 运行时，改用系统浏览器打开")
		}
		fmt.Println(addr.url)
		if err := openExternal(addr.url); err != nil {
			fmt.Fprintf(os.Stderr, "无法自动打开浏览器: %v\n", err)
			fmt.Fprintln(os.Stderr, "请手动访问上面的地址")
		}
		sh.waitExit()
		return
	}

	runWindow(addr.url, sh, *debug)
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "cordis-app: %v\n", err)
	os.Exit(1)
}
