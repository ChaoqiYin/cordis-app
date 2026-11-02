package main

import (
	"path/filepath"
	"testing"
)

func TestAppWindowTitleReadsAppName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.json")
	writeTestFile(t, path, `{"name":"演示应用","version":"0.1.0"}`)

	if got := appWindowTitle(path); got != "演示应用" {
		t.Fatalf("窗口标题 = %q，期望 %q", got, "演示应用")
	}
}

func TestAppWindowTitleTrimsName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.json")
	writeTestFile(t, path, `{"name":"  演示应用  "}`)

	if got := appWindowTitle(path); got != "演示应用" {
		t.Fatalf("窗口标题 = %q，期望去掉首尾空白", got)
	}
}

func TestAppWindowTitleFallsBackToFrameworkName(t *testing.T) {
	dir := t.TempDir()
	emptyName := filepath.Join(dir, "empty.json")
	writeTestFile(t, emptyName, `{"name":"   "}`)
	missingName := filepath.Join(dir, "missing-name.json")
	writeTestFile(t, missingName, `{"version":"0.1.0"}`)
	broken := filepath.Join(dir, "broken.json")
	writeTestFile(t, broken, `{not json`)

	cases := map[string]string{
		"空路径":     "",
		"文件不存在":   filepath.Join(dir, "absent.json"),
		"name 为空": emptyName,
		"没有 name": missingName,
		"JSON 损坏": broken,
	}
	for name, path := range cases {
		t.Run(name, func(t *testing.T) {
			if got := appWindowTitle(path); got != windowTitle {
				t.Fatalf("窗口标题 = %q，期望回退 %q", got, windowTitle)
			}
		})
	}
}
