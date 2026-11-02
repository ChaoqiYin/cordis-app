package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// embeddedApp 是构建期由桌面打包脚本放进来的项目产物。
//
// 目录内容与项目的 dist/ 一一对应：
//
//	app.json
//	package.json            （Node 靠它把 server/*.js 按 ESM 解析）
//	server/index.js
//	resources/{ui,shared,plugins}
//	bundle-public-key.pem   （可选）
//
// 安装目录保持只读；运行期把整棵树释放到可写数据目录，worker 从那里读。
//
//go:embed all:app
var embeddedApp embed.FS

// requiredAppFiles 是打包形态必须具备的产物。缺任何一个都说明打包漏步，
// 必须直接失败并说清楚，而不是让用户面对一个空白窗口。
var requiredAppFiles = []string{
	"app.json",
	"server/index.js",
	"resources/ui/index.html",
}

// releaseFunc 把 src 释放到 dataDir 下并返回释放目录。
//
// 抽成函数类型是为了测试能注入假的释放实现；真实实现是 releaseApp。
type releaseFunc func(src fs.FS, dataDir string) (string, error)

// prepareApp 把内嵌应用释放到数据目录，并把 layout 的打包字段补齐。
// 开发形态不释放，原样返回。
func prepareApp(l layout, release releaseFunc) (layout, error) {
	if !l.packaged {
		return l, nil
	}
	root, err := fs.Sub(embeddedApp, "app")
	if err != nil {
		return l, fmt.Errorf("无法读取内嵌应用: %w", err)
	}
	return prepareAppFrom(l, root, release)
}

// prepareAppFrom 是 prepareApp 的可测试实现：src 可以是任意 fs.FS。
func prepareAppFrom(l layout, src fs.FS, release releaseFunc) (layout, error) {
	if !l.packaged {
		return l, nil
	}
	for _, name := range requiredAppFiles {
		if _, err := fs.Stat(src, name); err != nil {
			return l, fmt.Errorf("内嵌应用缺少 %s，请重新执行桌面打包", name)
		}
	}

	dir, err := release(src, l.dataDir)
	if err != nil {
		return l, err
	}

	l.releaseDir = dir
	l.projectRoot = l.dataDir
	l.appJson = filepath.Join(dir, "app.json")
	l.serverEntry = filepath.Join(dir, "server", "index.js")
	l.resourcesDir = filepath.Join(dir, "resources")
	l.userPluginsDir = filepath.Join(l.dataDir, "plugins")
	l.mode = modePackaged

	// 公钥是可选的：没有它 worker 保持 fail-closed，拒绝安装签名插件包。
	keyFile := filepath.Join(dir, "bundle-public-key.pem")
	if _, statErr := os.Stat(keyFile); statErr == nil {
		l.bundlePublicKeyFile = keyFile
	}
	return l, nil
}

// releaseApp 把内嵌应用释放到 <dataDir>/app/<内容哈希>。
//
// 哈希同时充当版本标记：同内容直接复用（第二次启动不写盘），内容变化生成
// 新目录并在成功后清理旧版本。
func releaseApp(src fs.FS, dataDir string) (string, error) {
	return releaseFS(src, dataDir)
}

// releaseFS 是通用的内容哈希释放实现：先写隐藏临时目录再原子改名，失败不会
// 留下半成品；清理失败不阻塞启动。
func releaseFS(src fs.FS, dataDir string) (string, error) {
	hash, err := hashFS(src)
	if err != nil {
		return "", fmt.Errorf("计算内嵌应用哈希失败: %w", err)
	}

	appRoot := filepath.Join(dataDir, "app")
	target := filepath.Join(appRoot, hash)
	if _, statErr := os.Stat(target); statErr == nil {
		cleanupAppDirs(appRoot, hash)
		return target, nil
	}

	if err := os.MkdirAll(appRoot, 0o755); err != nil {
		return "", fmt.Errorf("无法创建释放目录: %w", err)
	}

	// 临时目录必须是 appRoot 的孩子：同一文件系统内 rename 才是原子的。
	// 点前缀让清理逻辑能一眼认出上一次启动的残留。
	tmp, err := os.MkdirTemp(appRoot, ".tmp-*")
	if err != nil {
		return "", fmt.Errorf("无法创建临时释放目录: %w", err)
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.RemoveAll(tmp)
		}
	}()

	if err := writeFS(src, tmp); err != nil {
		return "", fmt.Errorf("释放应用产物失败: %w", err)
	}

	if err := os.Rename(tmp, target); err != nil {
		// Windows 上 rename 不会覆盖已存在的目标。如果目标已经出现（例如
		// 并发启动或上一次启动刚好完成），仍然视为成功。
		if _, statErr := os.Stat(target); statErr == nil {
			_ = os.RemoveAll(tmp)
			cleanupAppDirs(appRoot, hash)
			return target, nil
		}
		return "", fmt.Errorf("无法原子切换到释放目录: %w", err)
	}
	keep = true
	cleanupAppDirs(appRoot, hash)
	return target, nil
}

// cleanupAppDirs 清理 appRoot 下除当前版本外的所有条目（旧哈希目录与 .tmp-*）。
// 失败忽略：清理只是控制磁盘增长，不能阻断启动。
func cleanupAppDirs(appRoot, current string) {
	entries, err := os.ReadDir(appRoot)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.Name() == current {
			continue
		}
		if err := os.RemoveAll(filepath.Join(appRoot, entry.Name())); err != nil {
			return
		}
	}
}

// hashFS 对「路径 + 内容」求哈希。只看文件名不够——Vite 产物常常同名换内容。
func hashFS(root fs.FS) (string, error) {
	var files []string
	err := fs.WalkDir(root, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		files = append(files, p)
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(files)

	sum := sha256.New()
	for _, name := range files {
		data, err := fs.ReadFile(root, name)
		if err != nil {
			return "", err
		}
		// 路径与长度都要参与：否则「a 挪到 b」或「两文件内容互换」会撞出同一个哈希
		fmt.Fprintf(sum, "%s\x00%d\x00", name, len(data))
		sum.Write(data)
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

func writeFS(root fs.FS, target string) error {
	return fs.WalkDir(root, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		// 点文件是仓库里的占位（.gitkeep / .gitignore），不属于产物
		if strings.HasPrefix(d.Name(), ".") {
			return nil
		}
		dest := filepath.Join(target, filepath.FromSlash(p))
		if d.IsDir() {
			return os.MkdirAll(dest, 0o755)
		}
		data, err := fs.ReadFile(root, p)
		if err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0o644)
	})
}
