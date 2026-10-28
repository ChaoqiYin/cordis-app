//go:build !windows

package main

// webViewUnavailable 在 macOS 与 Linux 上恒为 false。
//
// 这两个平台在构建期就链接好了 WebKit / WebKit2GTK——编译得过就代表运行时
// 一定在，无需运行期探测。Windows 是唯一例外（WebView2 独立分发）。
func webViewUnavailable() bool { return false }
