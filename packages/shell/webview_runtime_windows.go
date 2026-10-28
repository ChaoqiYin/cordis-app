//go:build windows

package main

import "syscall"

// webView2 的运行时版本写在注册表里。
//
// 机器级安装与用户级安装（非管理员权限装的 Evergreen 运行时）位置不同，
// 两个都要看——只查 HKLM 会把「用户自己装的」误判成没装。
const (
	webView2ClientKey = `SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
	webView2Machine   = `SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}`
)

// webViewUnavailable 在 Windows 上必须查运行时。
//
// 与 macOS / Linux 不同，WebView2 是独立可再分发组件：老机器上可能没装，
// 而 cgo 链接成功不代表运行时可用（架构文档 2.3 的降级路径）。
func webViewUnavailable() bool {
	return !hasWebView2Runtime()
}

// hasWebView2Runtime 只看注册表，不尝试加载 DLL：WebView2 的加载是延迟的，
// 探测失败会弹错误框；注册表项缺失则是「没装」这个事实最直接的证据。
func hasWebView2Runtime() bool {
	for _, path := range []string{webView2ClientKey, webView2Machine} {
		var key syscall.Handle
		if err := syscall.RegOpenKeyEx(syscall.HKEY_LOCAL_MACHINE, syscall.StringToUTF16Ptr(path), 0, syscall.KEY_READ, &key); err != nil {
			continue
		}
		var bufType, bufLen uint32
		queryErr := syscall.RegQueryValueEx(key, syscall.StringToUTF16Ptr("pv"), nil, &bufType, nil, &bufLen)
		syscall.RegCloseKey(key)
		// 空字符串也算「不存在」：某些卸载残留会留下 pv 但长度为 0
		if queryErr == nil && bufLen > 2 {
			return true
		}
	}
	return false
}
