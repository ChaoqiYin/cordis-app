package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// 运行形态。与 protocol 包的 RuntimeMode 取值保持一致。
const (
	modeProject  = "project"
	modePackaged = "packaged"
)

// layout 是外壳需要知道的全部磁盘位置。
//
// 外壳不做配置解析：打包形态的资源根、清单与服务端入口都由 prepareApp 从
// 已释放目录推导出来，外壳只负责把它们原样交给 supervisor。
type layout struct {
	installDir   string
	dataDir      string
	projectRoot  string
	resourcesDir string

	serverEntry         string
	appJson             string
	userPluginsDir      string
	bundlePublicKeyFile string
	nodeBin             string
	supervisorJS        string
	workerJS            string
	mode                string
	releaseDir          string
	packaged            bool

	// 以下字段只由 CLI 在开发形态（--shell）下设置，打包形态一律为空。
	// workerPort 是 CLI 预先分配并留给 Vite 代理的固定端口；
	// devUIURL 是 Vite 的地址，窗口加载它而不是 supervisor 的静态页面；
	// localPluginsDir 是 watcher 生成的本地插件根。
	workerPort      int
	devUIURL        string
	localPluginsDir string
	dev             bool
}

// discoverLayout 解析安装目录布局：
//
//	<install-dir>/
//	├── cordis-app[.exe]
//	└── bin/
//	    ├── node[.exe]
//	    ├── cordis-app-supervisor.mjs
//	    └── cordis-app-worker.mjs
//
// 仓库内开发时（go run ./packages/shell）不存在这套布局，因此找不到就退回
// 「用当前 node + 仓库里的 supervisor 产物」，让 `go run` 也能跑起来。
//
// CORDIS_APP_INSTALL_DIR 是测试 seam：它一旦设置就优先于「临时二进制」判定。
func discoverLayout(dataFlag, resourcesFlag string) (layout, error) {
	exe, err := os.Executable()
	if err != nil {
		return layout{}, fmt.Errorf("无法定位可执行文件: %w", err)
	}
	installDir := resolveInstallDir(exe, os.Getenv("CORDIS_APP_INSTALL_DIR"))

	nodeName := nodeBinaryName()

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

	supervisorJS, err := findSupervisor(installDir)
	if err != nil {
		return layout{}, err
	}

	workerJS := ""
	if packaged {
		workerJS, err = findWorker(installDir)
		if err != nil {
			return layout{}, err
		}
	}

	dataDir := dataFlag
	if dataDir == "" {
		dataDir = os.Getenv("CORDIS_APP_DATA")
	}
	if dataDir == "" {
		dataDir = defaultDataDir()
	}

	l := layout{
		installDir: installDir,
		dataDir:    dataDir,
		// 外壳对用户的 --data 始终是「数据目录」；交给 supervisor 时一律叫
		// --project（可写数据目录），不再使用有歧义的 --data 别名。
		projectRoot:  dataDir,
		nodeBin:      nodeBin,
		supervisorJS: supervisorJS,
		workerJS:     workerJS,
		packaged:     packaged,
		mode:         modeProject,
	}

	if packaged {
		l.mode = modePackaged
		l.userPluginsDir = filepath.Join(dataDir, "plugins")
		// 资源根/清单/服务端入口由 prepareApp 在释放完成后填充。
	} else {
		// 项目模式的 app.json 就在项目根；打包形态等 prepareApp 释放后再填。
		l.appJson = filepath.Join(dataDir, "app.json")
		if resourcesFlag != "" {
			l.resourcesDir = resourcesFlag
		} else {
			// 开发环境：直接吃 Vite 产物，不经过释放步骤
			l.resourcesDir = filepath.Join(repoRoot(), "packages", "ui", "dist")
		}
	}

	return l, nil
}

// findFirstExisting 返回候选列表中第一个存在的路径。
//
// supervisor 与 worker 的候选顺序（发布布局的 .mjs、.js，必要时再回退仓库
// 构建产物）不同，所以只共享「按顺序取第一个存在项」这一步。
func findFirstExisting(candidates []string) (string, bool) {
	for _, candidate := range candidates {
		if _, err := os.Stat(candidate); err == nil {
			return candidate, true
		}
	}
	return "", false
}

// findSupervisor 依次尝试发布布局里的 .mjs、.js，最后回退仓库构建产物。
func findSupervisor(installDir string) (string, error) {
	candidates := []string{
		filepath.Join(installDir, "bin", "cordis-app-supervisor.mjs"),
		filepath.Join(installDir, "bin", "cordis-app-supervisor.js"),
		filepath.Join(repoRoot(), "packages", "runtime", "lib", "supervisor", "main.js"),
	}
	if found, ok := findFirstExisting(candidates); ok {
		return found, nil
	}
	return "", fmt.Errorf("找不到 supervisor 脚本（既没有 bin/cordis-app-supervisor.mjs，也没有构建产物）")
}

// findWorker 查找打包后的 worker 入口。打包形态必须有它，否则启动失败。
func findWorker(installDir string) (string, error) {
	candidates := []string{
		filepath.Join(installDir, "bin", "cordis-app-worker.mjs"),
		filepath.Join(installDir, "bin", "cordis-app-worker.js"),
	}
	if found, ok := findFirstExisting(candidates); ok {
		return found, nil
	}
	return "", fmt.Errorf("打包形态缺少 worker（既没有 bin/cordis-app-worker.mjs，也没有 .js）")
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

// resolveInstallDir 决定安装目录。
//
// 显式覆盖优先。`go run` 把二进制放在临时目录，此时 installDir 毫无意义，
// 退回仓库根；但「安装目录恰好在临时目录」同样常见（解压后直接运行、CI
// 夹具），所以临时路径只有在本级没有随包 node 时才按 go run 处理。
func resolveInstallDir(exe, override string) string {
	if override != "" {
		return override
	}
	dir := filepath.Dir(exe)
	if isTempBinary(exe) && !hasPackagedNode(dir) {
		return repoRoot()
	}
	return dir
}

// hasPackagedNode 判断目录是否是安装目录：唯一判据是随包分发的 node。
func hasPackagedNode(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "bin", nodeBinaryName()))
	return err == nil
}

func nodeBinaryName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

// isTempBinary 判断是否由 `go run` 启动（二进制在系统临时目录里）。
func isTempBinary(exe string) bool {
	tmp := os.TempDir()
	return len(exe) > len(tmp) && exe[:len(tmp)] == tmp
}
