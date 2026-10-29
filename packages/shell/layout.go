package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// layout 是外壳需要知道的全部磁盘位置。
//
// 刻意只保留「在哪找 node」「在哪找 supervisor」「UI 在哪」「数据放哪」四项：
// 外壳一旦开始理解 app.json 或插件目录，它就成了第二个配置解析器。
type layout struct {
	installDir   string
	dataDir      string
	resourcesDir string
	nodeBin      string
	supervisorJS string
	// packaged 表示这是「有 bin/ 目录的正式安装布局」而非仓库内 go run。
	// 它决定两件事：是否释放内嵌 UI、是否裁掉用户环境的 PATH。
	packaged bool
}

// discoverLayout 解析安装目录布局：
//
//	<install-dir>/
//	├── cordis-app[.exe]
//	├── bin/node[.exe]
//	├── bin/cordis-app-supervisor.js
//	└── resources/ui/
//
// 仓库内开发时（go run ./packages/shell）不存在这套布局，因此找不到就退回
// 「用当前 node + 仓库里的 supervisor 产物」，让 `go run` 也能跑起来。
func discoverLayout(dataFlag, resourcesFlag string) (layout, error) {
	exe, err := os.Executable()
	if err != nil {
		return layout{}, fmt.Errorf("无法定位可执行文件: %w", err)
	}
	installDir := filepath.Dir(exe)
	if override := os.Getenv("CORDIS_APP_INSTALL_DIR"); override != "" {
		installDir = override
	}
	// `go run` 把二进制放在临时目录，此时 installDir 毫无意义，直接用仓库根
	if isTempBinary(exe) {
		installDir = repoRoot()
	}

	nodeName := "node"
	supervisorName := "cordis-app-supervisor.js"
	if runtime.GOOS == "windows" {
		nodeName = "node.exe"
	}

	// packaged 的唯一判据是随包分发的 node 在不在。判断「安装目录下有没有 bin/」
	// 不够：仓库根下也有 bin/ 的可能是别的东西。
	packagedNode := filepath.Join(installDir, "bin", nodeName)
	nodeBin := packagedNode
	packaged := true
	if _, statErr := os.Stat(packagedNode); statErr != nil {
		packaged = false
		// 开发环境：用 PATH 上的 node
		nodeBin, err = exec.LookPath("node")
		if err != nil {
			return layout{}, fmt.Errorf("找不到 node 运行时（既没有 bin/%s，也不在 PATH 上）", nodeName)
		}
	}

	supervisorJS := filepath.Join(installDir, "bin", supervisorName)
	if _, statErr := os.Stat(supervisorJS); statErr != nil {
		// 仓库内：runtime 包的构建产物
		candidate := filepath.Join(repoRoot(), "packages", "runtime", "lib", "supervisor", "main.js")
		if _, err := os.Stat(candidate); err != nil {
			return layout{}, fmt.Errorf("找不到 supervisor 脚本（既没有 bin/%s，也没有构建产物）", supervisorName)
		}
		supervisorJS = candidate
	}

	dataDir := dataFlag
	if dataDir == "" {
		dataDir = os.Getenv("CORDIS_APP_DATA")
	}
	if dataDir == "" {
		dataDir = defaultDataDir()
	}

	resourcesDir := resourcesFlag
	if resourcesDir == "" {
		if packaged {
			resourcesDir = filepath.Join(installDir, "resources")
		} else {
			// 开发环境：直接吃 Vite 产物，不经过释放步骤
			resourcesDir = filepath.Join(repoRoot(), "packages", "ui", "dist")
		}
	}

	return layout{
		installDir:   installDir,
		dataDir:      dataDir,
		resourcesDir: resourcesDir,
		nodeBin:      nodeBin,
		supervisorJS: supervisorJS,
		packaged:     packaged,
	}, nil
}

// defaultDataDir 与 protocol 包的 defaultDataDir 保持一致。
//
// 这不是重复实现：外壳必须在启动 supervisor 之前就知道数据目录，才能加锁。
// 两处实现必须保持同一条解析规则，任何一侧改动都要同时改另一侧。
func defaultDataDir() string {
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("APPDATA")
		if base == "" {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(base, "cordis-app")
	case "darwin":
		home, _ := os.UserHomeDir()
		return filepath.Join(home, "Library", "Application Support", "cordis-app")
	default:
		base := os.Getenv("XDG_DATA_HOME")
		if base == "" {
			home, _ := os.UserHomeDir()
			base = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(base, "cordis-app")
	}
}

// repoRoot 通过向上找 pnpm-workspace.yaml 定位仓库根。
func repoRoot() string {
	dir, err := os.Getwd()
	if err != nil {
		return "."
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "pnpm-workspace.yaml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "."
		}
		dir = parent
	}
}

// isTempBinary 判断是否由 `go run` 启动（二进制在系统临时目录里）。
func isTempBinary(exe string) bool {
	tmp := os.TempDir()
	return len(exe) > len(tmp) && exe[:len(tmp)] == tmp
}
