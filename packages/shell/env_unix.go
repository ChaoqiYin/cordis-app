//go:build !windows

package main

// envVars 是「一批要设置的环境变量」。
type envVars struct {
	keys   []string
	values []string
}

// homeVars 把家目录与临时目录重定向到数据目录（架构文档 11.6）。
//
// Unix 上真正起作用的是 HOME 与三个 XDG_*；XDG_* 必须一起改，否则插件写的
// 配置仍会落到 ~/.config 下，与 HOME 的改动互相矛盾。
func homeVars(dataDir string) envVars {
	tmp := dataDir + "/tmp"
	return envVars{
		keys: []string{"HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"},
		values: []string{
			"HOME=" + dataDir,
			"TMPDIR=" + tmp,
			"XDG_CONFIG_HOME=" + dataDir + "/config",
			"XDG_DATA_HOME=" + dataDir,
			"XDG_CACHE_HOME=" + dataDir + "/cache",
			"XDG_STATE_HOME=" + dataDir + "/state",
		},
	}
}
