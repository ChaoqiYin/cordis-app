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

// embeddedResources 是构建期 `pnpm stage:ui` 放进来的前端产物。
//
// 嵌入保证「外壳 + UI」作为一个不可分割的版本单元分发：不会出现外壳升级了、
// 磁盘上的 UI 还是旧的。释放到磁盘则是因为前端必须由 worker 的 static 插件
// 从目录里读——外壳不监听端口、不提供 HTTP，无从代劳（架构文档 11.1）。
//
//go:embed all:resources
var embeddedResources embed.FS

// versionFile 记录已释放产物的构建哈希。它在 ui/ 下面，与产物同生共死。
const versionFile = ".version"

// releaseResources 把内嵌产物释放到 <install-dir>/resources。
//
// 幂等：哈希一致就什么都不做，正常情况下只有升级后的第一次启动会写盘。
func releaseResources(l layout) error {
	root, err := fs.Sub(embeddedResources, "resources")
	if err != nil {
		return err
	}
	if _, err := fs.Stat(root, "ui/index.html"); err != nil {
		// 开发构建（go run）没有嵌入产物，直接用 packages/ui/dist。
		// 正式安装里没有嵌入产物则说明构建漏了 stage 步骤——必须说出来，
		// 否则用户只会看到一个空白窗口，没有任何线索。
		if l.packaged {
			if _, statErr := os.Stat(filepath.Join(l.resourcesDir, "ui", "index.html")); statErr != nil {
				fmt.Fprintln(os.Stderr, "警告：外壳未内嵌 UI 产物，且磁盘上也没有，界面将无法显示")
			}
		}
		return nil
	}

	hash, err := hashFS(root)
	if err != nil {
		return fmt.Errorf("计算内嵌产物哈希失败: %w", err)
	}

	uiDir := filepath.Join(l.resourcesDir, "ui")
	if current, err := os.ReadFile(filepath.Join(uiDir, versionFile)); err == nil {
		if strings.TrimSpace(string(current)) == hash {
			return nil
		}
	}

	if err := os.MkdirAll(l.resourcesDir, 0o755); err != nil {
		return fmt.Errorf("无法创建资源目录: %w", err)
	}
	if err := os.RemoveAll(uiDir); err != nil {
		return fmt.Errorf("无法清理旧资源: %w", err)
	}
	if err := writeFS(root, l.resourcesDir); err != nil {
		return fmt.Errorf("释放资源失败: %w", err)
	}
	return os.WriteFile(filepath.Join(uiDir, versionFile), []byte(hash+"\n"), 0o644)
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
