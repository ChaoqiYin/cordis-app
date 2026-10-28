package main

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func TestHashFSDetectsContentChange(t *testing.T) {
	base := fstest.MapFS{
		"ui/index.html":   {Data: []byte("<html>v1</html>")},
		"shared/react.js": {Data: []byte("export default 1")},
	}
	same := fstest.MapFS{
		"ui/index.html":   {Data: []byte("<html>v1</html>")},
		"shared/react.js": {Data: []byte("export default 1")},
	}
	changed := fstest.MapFS{
		"ui/index.html":   {Data: []byte("<html>v2</html>")},
		"shared/react.js": {Data: []byte("export default 1")},
	}

	h1, err := hashFS(base)
	if err != nil {
		t.Fatal(err)
	}
	h2, err := hashFS(same)
	if err != nil {
		t.Fatal(err)
	}
	h3, err := hashFS(changed)
	if err != nil {
		t.Fatal(err)
	}

	if h1 != h2 {
		t.Fatal("内容相同应当得到相同哈希")
	}
	if h1 == h3 {
		t.Fatal("内容不同必须得到不同哈希")
	}
}

func TestHashFSIncludesPath(t *testing.T) {
	// 两个文件内容互换但路径不变时，只对内容求和会撞哈希
	a := fstest.MapFS{
		"a.js": {Data: []byte("1")},
		"b.js": {Data: []byte("2")},
	}
	b := fstest.MapFS{
		"a.js": {Data: []byte("2")},
		"b.js": {Data: []byte("1")},
	}
	ha, _ := hashFS(a)
	hb, _ := hashFS(b)
	if ha == hb {
		t.Fatal("路径必须参与哈希，否则互换内容会被当成同一次构建")
	}
}

func TestWriteFSSkipsDotFiles(t *testing.T) {
	src := fstest.MapFS{
		"ui/index.html": {Data: []byte("x")},
		".gitkeep":      {Data: []byte("")},
		"ui/.version":   {Data: []byte("old")},
	}
	dir := t.TempDir()
	if err := writeFS(src, dir); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(filepath.Join(dir, "ui", "index.html")); err != nil {
		t.Fatal("普通文件应当被写出")
	}
	if _, err := os.Stat(filepath.Join(dir, ".gitkeep")); !os.IsNotExist(err) {
		t.Fatal("点文件不该被写出")
	}
	if _, err := os.Stat(filepath.Join(dir, "ui", ".version")); !os.IsNotExist(err) {
		t.Fatal("嵌入的 .version 不该被写出——它由释放流程自己生成")
	}
}
