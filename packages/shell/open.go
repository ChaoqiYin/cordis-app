package main

import "github.com/cordis-app/shell/native"

// openExternal 用系统默认浏览器打开 URL。
//
// 实现已下沉到 native 包：打包形态 PATH 只有 bin/，打开链接的工具必须使用
// 绝对路径，而 shell.openExternal 命令也依赖同一套规则。不等待浏览器退出：
// 用户关掉浏览器不代表应用该退出。
func openExternal(url string) error {
	return native.OpenExternal(url)
}
