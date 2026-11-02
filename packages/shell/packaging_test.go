package main

import (
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"testing/fstest"
)

func nodeName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// packagedInstall 构造一个最小的正式安装目录：bin/node + supervisor + worker。
func packagedInstall(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeTestFile(t, filepath.Join(dir, "bin", nodeName()), "node")
	writeTestFile(t, filepath.Join(dir, "bin", "cordis-app-supervisor.mjs"), "supervisor")
	writeTestFile(t, filepath.Join(dir, "bin", "cordis-app-worker.mjs"), "worker")
	return dir
}

func sampleAppFS() fstest.MapFS {
	return fstest.MapFS{
		"app.json":                    {Data: []byte(`{"name":"demo"}`)},
		"package.json":                {Data: []byte(`{"type":"module"}`)},
		"server/index.js":             {Data: []byte("export default () => {}\n")},
		"resources/ui/index.html":     {Data: []byte("<html>demo</html>")},
		"resources/shared/react.js":   {Data: []byte("export default 1")},
		"resources/plugins/.gitkeep":  {Data: []byte("")},
		"resources/plugins/readme.md": {Data: []byte("plugin")},
	}
}

func TestResolveInstallDirKeepsTempInstallWithBundledNode(t *testing.T) {
	install := packagedInstall(t)
	if got := resolveInstallDir(filepath.Join(install, "cordis-app"), ""); got != install {
		t.Fatalf("临时目录中的安装目录被当成 go run：installDir = %q，期望 %q", got, install)
	}
}

func TestResolveInstallDirFallsBackToRepoRootForTempBinary(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "go-build123", "exe", "main")
	got := resolveInstallDir(exe, "")
	if got == filepath.Dir(exe) {
		t.Fatal("临时目录且没有随包 node 时应退回仓库根")
	}
	if _, err := os.Stat(filepath.Join(got, "pnpm-workspace.yaml")); err != nil {
		t.Fatalf("回退目录不是仓库根：%q（%v）", got, err)
	}
}

func TestResolveInstallDirOverrideWins(t *testing.T) {
	override := filepath.Join(t.TempDir(), "custom")
	exe := filepath.Join(t.TempDir(), "cordis-app")
	if got := resolveInstallDir(exe, override); got != override {
		t.Fatalf("installDir = %q，期望显式覆盖 %q", got, override)
	}
}

func TestDiscoverLayoutInstallDirOverrideWinsOverTempBinary(t *testing.T) {
	install := packagedInstall(t)
	dataDir := filepath.Join(t.TempDir(), "data")
	t.Setenv("CORDIS_APP_INSTALL_DIR", install)

	l, err := discoverLayout(dataDir, "")
	if err != nil {
		t.Fatalf("discoverLayout 失败: %v", err)
	}

	if !l.packaged {
		t.Fatal("有 bin/node 时应当判定为 packaged")
	}
	if l.installDir != install {
		t.Fatalf("installDir = %q，期望 %q（CORDIS_APP_INSTALL_DIR 应覆盖临时二进制判定）", l.installDir, install)
	}
	if want := filepath.Join(install, "bin", nodeName()); l.nodeBin != want {
		t.Fatalf("nodeBin = %q，期望 %q", l.nodeBin, want)
	}
	if want := filepath.Join(install, "bin", "cordis-app-supervisor.mjs"); l.supervisorJS != want {
		t.Fatalf("supervisorJS = %q，期望 %q", l.supervisorJS, want)
	}
	if want := filepath.Join(install, "bin", "cordis-app-worker.mjs"); l.workerJS != want {
		t.Fatalf("workerJS = %q，期望 %q", l.workerJS, want)
	}
	if l.projectRoot != dataDir {
		t.Fatalf("打包形态 projectRoot = %q，期望数据目录 %q", l.projectRoot, dataDir)
	}
	if want := filepath.Join(dataDir, "plugins"); l.userPluginsDir != want {
		t.Fatalf("userPluginsDir = %q，期望 %q", l.userPluginsDir, want)
	}
	if l.mode != "packaged" {
		t.Fatalf("mode = %q，期望 packaged", l.mode)
	}
	if l.resourcesDir != "" || l.appJson != "" || l.serverEntry != "" {
		t.Fatal("资源根/清单/服务端入口应当留给 prepareApp 填充")
	}
}

func TestDiscoverLayoutFallsBackToJSArtifacts(t *testing.T) {
	install := t.TempDir()
	writeTestFile(t, filepath.Join(install, "bin", nodeName()), "node")
	writeTestFile(t, filepath.Join(install, "bin", "cordis-app-supervisor.js"), "supervisor")
	writeTestFile(t, filepath.Join(install, "bin", "cordis-app-worker.js"), "worker")
	t.Setenv("CORDIS_APP_INSTALL_DIR", install)

	l, err := discoverLayout(filepath.Join(t.TempDir(), "data"), "")
	if err != nil {
		t.Fatalf("discoverLayout 失败: %v", err)
	}
	if want := filepath.Join(install, "bin", "cordis-app-supervisor.js"); l.supervisorJS != want {
		t.Fatalf("supervisorJS = %q，期望回退到 %q", l.supervisorJS, want)
	}
	if want := filepath.Join(install, "bin", "cordis-app-worker.js"); l.workerJS != want {
		t.Fatalf("workerJS = %q，期望回退到 %q", l.workerJS, want)
	}
}

func TestDiscoverLayoutPackagedRequiresWorker(t *testing.T) {
	install := t.TempDir()
	writeTestFile(t, filepath.Join(install, "bin", nodeName()), "node")
	writeTestFile(t, filepath.Join(install, "bin", "cordis-app-supervisor.mjs"), "supervisor")
	t.Setenv("CORDIS_APP_INSTALL_DIR", install)

	if _, err := discoverLayout(filepath.Join(t.TempDir(), "data"), ""); err == nil {
		t.Fatal("打包形态缺少 worker 时应当报错")
	}
}

func TestPrepareAppDerivesPaths(t *testing.T) {
	src := sampleAppFS()
	dataDir := t.TempDir()
	l := layout{packaged: true, mode: "packaged", dataDir: dataDir}

	got, err := prepareAppFrom(l, src)
	if err != nil {
		t.Fatalf("prepareAppFrom 失败: %v", err)
	}

	hash, err := hashFS(src)
	if err != nil {
		t.Fatal(err)
	}
	wantDir := filepath.Join(dataDir, "app", hash)
	if got.releaseDir != wantDir {
		t.Fatalf("releaseDir = %q，期望 %q", got.releaseDir, wantDir)
	}
	if want := filepath.Join(wantDir, "app.json"); got.appJson != want {
		t.Fatalf("appJson = %q，期望 %q", got.appJson, want)
	}
	if want := filepath.Join(wantDir, "server", "index.js"); got.serverEntry != want {
		t.Fatalf("serverEntry = %q，期望 %q", got.serverEntry, want)
	}
	if want := filepath.Join(wantDir, "resources"); got.resourcesDir != want {
		t.Fatalf("resourcesDir = %q，期望 %q", got.resourcesDir, want)
	}
	if want := filepath.Join(dataDir, "plugins"); got.userPluginsDir != want {
		t.Fatalf("userPluginsDir = %q，期望 %q", got.userPluginsDir, want)
	}
	if got.projectRoot != dataDir {
		t.Fatalf("projectRoot = %q，期望 %q", got.projectRoot, dataDir)
	}
	if got.bundlePublicKeyFile != "" {
		t.Fatalf("没有随包 PEM 时 bundlePublicKeyFile 应为空，实际 %q", got.bundlePublicKeyFile)
	}

	// 推导出的位置必须真的能读到内容
	if _, err := os.Stat(filepath.Join(got.resourcesDir, "ui", "index.html")); err != nil {
		t.Fatalf("资源根未释放: %v", err)
	}
	if _, err := os.Stat(got.serverEntry); err != nil {
		t.Fatalf("服务端入口未释放: %v", err)
	}
}

func TestPrepareAppFindsBundledPublicKey(t *testing.T) {
	src := sampleAppFS()
	src["bundle-public-key.pem"] = &fstest.MapFile{Data: []byte("pem")}
	dataDir := t.TempDir()
	l := layout{packaged: true, mode: "packaged", dataDir: dataDir}

	got, err := prepareAppFrom(l, src)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(got.releaseDir, "bundle-public-key.pem")
	if got.bundlePublicKeyFile != want {
		t.Fatalf("bundlePublicKeyFile = %q，期望 %q", got.bundlePublicKeyFile, want)
	}
}

func TestPrepareAppRejectsMissingArtifacts(t *testing.T) {
	for _, missing := range []string{"app.json", "package.json", "server/index.js", "resources/ui/index.html"} {
		t.Run(missing, func(t *testing.T) {
			src := sampleAppFS()
			delete(src, missing)
			dataDir := t.TempDir()
			l := layout{packaged: true, mode: "packaged", dataDir: dataDir}

			_, err := prepareAppFrom(l, src)
			if err == nil {
				t.Fatalf("缺少 %s 时应报错", missing)
			}
			if !strings.Contains(err.Error(), missing) {
				t.Fatalf("错误信息应当指出缺失文件 %q，实际: %v", missing, err)
			}
			if entries, readErr := os.ReadDir(filepath.Join(dataDir, "app")); readErr == nil && len(entries) > 0 {
				t.Fatalf("校验失败时不该释放任何内容: %v", entries)
			}
		})
	}
}

func TestPrepareAppIgnoresDevelopmentMode(t *testing.T) {
	dataDir := t.TempDir()
	l := layout{packaged: false, mode: "project", dataDir: dataDir}
	got, err := prepareAppFrom(l, fstest.MapFS{})
	if err != nil {
		t.Fatalf("开发形态不该释放: %v", err)
	}
	if got.releaseDir != "" {
		t.Fatalf("开发形态 releaseDir 应为空，实际 %q", got.releaseDir)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "app")); !os.IsNotExist(err) {
		t.Fatal("开发形态不该创建释放目录")
	}
}

func TestReleaseAppIsIdempotent(t *testing.T) {
	src := sampleAppFS()
	dataDir := t.TempDir()

	dir, err := releaseApp(src, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	// 第一次释放后放入哨兵：第二次若真的重写，哨兵会消失。
	sentinel := filepath.Join(dir, "sentinel")
	writeTestFile(t, sentinel, "keep")

	again, err := releaseApp(src, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if again != dir {
		t.Fatalf("同内容应复用释放目录：%q != %q", again, dir)
	}
	if _, err := os.Stat(sentinel); err != nil {
		t.Fatal("同内容第二次释放不该重写目录")
	}
	assertNoTempDirs(t, filepath.Join(dataDir, "app"))
}

func TestReleaseAppAlwaysCreatesBuiltinPluginDir(t *testing.T) {
	// go:embed 不保留空目录：内嵌产物缺少 resources/plugins 时，释放阶段仍要补上，
	// 否则打包形态的内置插件根会随「这一版有没有插件」而变化。
	src := fstest.MapFS{
		"app.json":                {Data: []byte(`{"name":"demo"}`)},
		"server/index.js":         {Data: []byte("export default () => {}\n")},
		"resources/ui/index.html": {Data: []byte("<html>demo</html>")},
	}
	dir, err := releaseApp(src, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "resources", "plugins"))
	if err != nil {
		t.Fatalf("释放目录必须包含 resources/plugins: %v", err)
	}
	if !info.IsDir() {
		t.Fatal("resources/plugins 应当是目录")
	}
}

func TestReleaseAppContentChangeCleansOldVersion(t *testing.T) {
	dataDir := t.TempDir()
	oldDir, err := releaseApp(sampleAppFS(), dataDir)
	if err != nil {
		t.Fatal(err)
	}

	changed := sampleAppFS()
	changed["resources/ui/index.html"] = &fstest.MapFile{Data: []byte("<html>v2</html>")}
	newDir, err := releaseApp(changed, dataDir)
	if err != nil {
		t.Fatal(err)
	}
	if newDir == oldDir {
		t.Fatal("内容变化必须生成新的释放目录")
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Fatal("旧版本目录应当被清理")
	}
	if _, err := os.Stat(filepath.Join(newDir, "app.json")); err != nil {
		t.Fatal("新版本应当完整释放")
	}
	assertNoTempDirs(t, filepath.Join(dataDir, "app"))
}

func TestReleaseAppCleansStaleTempDirs(t *testing.T) {
	dataDir := t.TempDir()
	stale := filepath.Join(dataDir, "app", ".tmp-deadbeef")
	writeTestFile(t, filepath.Join(stale, "partial"), "half")

	if _, err := releaseApp(sampleAppFS(), dataDir); err != nil {
		t.Fatal(err)
	}
	assertNoTempDirs(t, filepath.Join(dataDir, "app"))
}

func assertNoTempDirs(t *testing.T, root string) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tmp-") {
			t.Fatalf("残留临时释放目录: %s", filepath.Join(root, entry.Name()))
		}
	}
}

func TestSupervisorArgsPackaged(t *testing.T) {
	l := layout{
		supervisorJS:   "/install/bin/cordis-app-supervisor.mjs",
		projectRoot:    "/data",
		resourcesDir:   "/data/app/hash/resources",
		serverEntry:    "/data/app/hash/server/index.js",
		appJson:        "/data/app/hash/app.json",
		userPluginsDir: "/data/plugins",
		workerJS:       "/install/bin/cordis-app-worker.mjs",
		mode:           "packaged",
		packaged:       true,
	}

	got := supervisorArgs(l)
	want := []string{
		"/install/bin/cordis-app-supervisor.mjs",
		"--project", "/data",
		"--resources", "/data/app/hash/resources",
		"--server-entry", "/data/app/hash/server/index.js",
		"--app-json", "/data/app/hash/app.json",
		"--user-plugins", "/data/plugins",
		"--mode", "packaged",
		"--worker", "/install/bin/cordis-app-worker.mjs",
	}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("supervisorArgs =\n%v\n期望\n%v", got, want)
	}
}

func TestSupervisorArgsDevelopment(t *testing.T) {
	l := layout{
		supervisorJS: "/repo/packages/runtime/lib/supervisor/main.js",
		projectRoot:  "/project",
		resourcesDir: "/repo/packages/ui/dist",
		mode:         "project",
	}

	got := supervisorArgs(l)
	want := []string{
		"/repo/packages/runtime/lib/supervisor/main.js",
		"--project", "/project",
		"--resources", "/repo/packages/ui/dist",
	}
	if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("supervisorArgs =\n%v\n期望\n%v", got, want)
	}
}

func TestSupervisorEnvOverridesInheritedProject(t *testing.T) {
	t.Setenv("CORDIS_APP_PROJECT", "/hijack")
	t.Setenv("CORDIS_APP_DATA", "/hijack-data")
	t.Setenv("CORDIS_APP_RESOURCES", "/hijack-resources")
	t.Setenv("CORDIS_APP_BUNDLE_PUBLIC_KEY", "")

	l := layout{dataDir: "/data", projectRoot: "/data", resourcesDir: "/data/app/hash/resources"}
	env := supervisorEnv(l)

	assertEnvKeyOnce(t, env, "CORDIS_APP_PROJECT", "/data")
	assertEnvKeyOnce(t, env, "CORDIS_APP_DATA", "/data")
	assertEnvKeyOnce(t, env, "CORDIS_APP_RESOURCES", "/data/app/hash/resources")
	if _, ok := envValue(env, "CORDIS_APP_BUNDLE_PUBLIC_KEY"); ok {
		t.Fatal("没有公钥来源时不该注入 CORDIS_APP_BUNDLE_PUBLIC_KEY")
	}
}

func TestSupervisorEnvPublicKeyFromBundledFile(t *testing.T) {
	t.Setenv("CORDIS_APP_BUNDLE_PUBLIC_KEY", "")
	keyFile := filepath.Join(t.TempDir(), "bundle-public-key.pem")
	writeTestFile(t, keyFile, "FILE-KEY\n")

	l := layout{dataDir: "/data", projectRoot: "/data", resourcesDir: "/res", bundlePublicKeyFile: keyFile}
	env := supervisorEnv(l)

	assertEnvKeyOnce(t, env, "CORDIS_APP_BUNDLE_PUBLIC_KEY", "FILE-KEY\n")
}

func TestSupervisorEnvPublicKeyFromEnvironmentWins(t *testing.T) {
	t.Setenv("CORDIS_APP_BUNDLE_PUBLIC_KEY", "ENV-KEY")
	keyFile := filepath.Join(t.TempDir(), "bundle-public-key.pem")
	writeTestFile(t, keyFile, "FILE-KEY\n")

	l := layout{dataDir: "/data", projectRoot: "/data", resourcesDir: "/res", bundlePublicKeyFile: keyFile}
	env := supervisorEnv(l)

	assertEnvKeyOnce(t, env, "CORDIS_APP_BUNDLE_PUBLIC_KEY", "ENV-KEY")
}

func TestSupervisorEnvMissingKeyWarnsAndDoesNotInject(t *testing.T) {
	t.Setenv("CORDIS_APP_BUNDLE_PUBLIC_KEY", "")
	l := layout{dataDir: "/data", projectRoot: "/data", resourcesDir: "/res", bundlePublicKeyFile: "/nope/key.pem"}

	env, output := captureStderr(t, func() []string { return supervisorEnv(l) })

	if _, ok := envValue(env, "CORDIS_APP_BUNDLE_PUBLIC_KEY"); ok {
		t.Fatal("公钥文件不存在时不该注入")
	}
	if !strings.Contains(output, "签名公钥") || !strings.Contains(output, "fail-closed") {
		t.Fatalf("没有公钥来源时应当警告并说明 fail-closed，实际输出: %q", output)
	}
}

// captureStderr 在 fn 执行期间接管 os.Stderr，返回 fn 的结果与捕获到的输出。
// 警告走 stderr，这样终端与日志都能看到，又不污染 stdout 的握手协议。
func captureStderr[T any](t *testing.T, fn func() T) (T, string) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	original := os.Stderr
	os.Stderr = writer
	defer func() { os.Stderr = original }()

	result := fn()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = reader.Close()
	return result, string(data)
}

func envValue(env []string, key string) (string, bool) {
	prefix := key + "="
	for _, entry := range env {
		if strings.HasPrefix(entry, prefix) {
			return strings.TrimPrefix(entry, prefix), true
		}
	}
	return "", false
}

func assertEnvKeyOnce(t *testing.T, env []string, key, want string) {
	t.Helper()
	count := 0
	value := ""
	for _, entry := range env {
		if strings.HasPrefix(entry, key+"=") {
			count++
			value = strings.TrimPrefix(entry, key+"=")
		}
	}
	if count != 1 {
		t.Fatalf("%s 应只出现一次，实际 %d 次", key, count)
	}
	if value != want {
		t.Fatalf("%s = %q，期望 %q", key, value, want)
	}
}
