//go:build windows

package main

import "os"

// envVars 是「一批要设置的环境变量」。
type envVars struct {
	keys   []string
	values []string
}

// homeVars 把用户目录与临时目录重定向到数据目录。
//
// Windows 上没有 HOME 这个概念——node 与绝大多数插件读的是 USERPROFILE 与
// APPDATA/LOCALAPPDATA。写 HOME 只会得到一个「看起来配了、实际没生效」的环境。
func homeVars(dataDir string) envVars {
	tmp := dataDir + string(os.PathSeparator) + "tmp"
	return envVars{
		keys: []string{"USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"},
		values: []string{
			"USERPROFILE=" + dataDir,
			"APPDATA=" + dataDir + string(os.PathSeparator) + "AppData" + string(os.PathSeparator) + "Roaming",
			"LOCALAPPDATA=" + dataDir + string(os.PathSeparator) + "AppData" + string(os.PathSeparator) + "Local",
			"TEMP=" + tmp,
			"TMP=" + tmp,
		},
	}
}
