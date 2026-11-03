package native

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
)

// darwin 平台使用的系统自带工具。打包形态 PATH 只有 bin/，因此必须写绝对路径。
const (
	darwinOsascript = "/usr/bin/osascript"
	darwinOpen      = "/usr/bin/open"
	darwinDefaults  = "/usr/bin/defaults"
	darwinUname     = "/usr/bin/uname"
)

func registerDarwin(reg *Registry, opts Options) {
	osascript := firstExisting(opts, darwinOsascript)
	open := firstExisting(opts, darwinOpen)

	if osascript != "" {
		reg.Register(CommandPathChooseOpen, func(ctx context.Context, input json.RawMessage) (any, error) {
			return darwinChooseOpen(ctx, opts, osascript, input)
		})
		reg.Register(CommandPathChooseDirectory, func(ctx context.Context, input json.RawMessage) (any, error) {
			return darwinChooseDirectory(ctx, opts, osascript, input)
		})
		reg.Register(CommandPathChooseSave, func(ctx context.Context, input json.RawMessage) (any, error) {
			return darwinChooseSave(ctx, opts, osascript, input)
		})
	}

	// 窗口命令排在路径选择之后、通知之前，与协议命令表的顺序一致。
	registerWindow(reg, opts)

	if osascript != "" {
		reg.Register(CommandNotificationShow, func(ctx context.Context, input json.RawMessage) (any, error) {
			return darwinNotification(ctx, opts, osascript, input)
		})
	}

	if open != "" {
		reg.Register(CommandShellOpenExternal, openExternalHandler(opts, commandSpec{Name: open}))
		reg.Register(CommandShellOpenPath, openPathHandler(opts, commandSpec{Name: open}))
		reg.Register(CommandShellShowItemInFolder, showItemInFolderHandler(opts, open, showItemDarwin))
	}

	registerSystemInfo(reg, opts)
}

func darwinChooseOpen(ctx context.Context, opts Options, osascript string, input json.RawMessage) (any, error) {
	var in chooseOpenInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	filters, filterErr := normalizeFilters(in.Filters)
	if filterErr != nil {
		return nil, filterErr
	}
	title := in.Title
	if title == "" {
		title = "选择文件"
	}
	defaultDir := defaultDirectory(opts, in.DefaultPath)
	filterText := darwinFilterText(filters)

	command := "set chosenItem to choose file with prompt promptText"
	if filterText != "" {
		command += " of type typeList"
	}
	if defaultDir != "" {
		command += " default location (POSIX file defaultPathText)"
	}
	if in.Multiple {
		command += " with multiple selections allowed"
	}

	output := darwinPathOutput(in.Multiple)

	script := darwinChooseScriptHeader(command, output)
	result := opts.Runner.Run(ctx, osascript, "-e", script, "--", boolArg(in.Multiple), title, defaultDir, filterText)
	if nativeErr := errorFromResult(result, "osascript"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathsOutput{Paths: splitLines(result.Stdout)}, nil
}

// darwinChooseScriptHeader 只拼装固定的脚本骨架；用户输入一律经 argv 传入，
// 不进入脚本正文，避免 AppleScript 注入。
func darwinChooseScriptHeader(command, output string) string {
	return `on run argv
	set multipleAllowed to (item 1 of argv is "1")
	set promptText to item 2 of argv
	set defaultPathText to item 3 of argv
	set filterText to item 4 of argv
	set typeList to {}
	if filterText is not "" then
		set previousDelimiters to AppleScript's text item delimiters
		set AppleScript's text item delimiters to ","
		set typeList to text items of filterText
		set AppleScript's text item delimiters to previousDelimiters
	end if
	` + command + `
` + output + `
end run`
}

// darwinPathOutput 生成把选择结果转成换行分隔路径的 AppleScript 结尾；单选与
// 多选共用同一份脚本骨架。
func darwinPathOutput(multiple bool) string {
	if !multiple {
		return "\treturn POSIX path of chosenItem"
	}
	return "\tset outputText to \"\"\n" +
		"\trepeat with pathItem in chosenItem\n" +
		"\t\tset outputText to outputText & (POSIX path of pathItem) & linefeed\n" +
		"\tend repeat\n" +
		"\treturn outputText"
}

// darwinFilterText 把过滤项压成逗号分隔的扩展名，交给脚本拆成 AppleScript 列表。
func darwinFilterText(filters []nativePathFilter) string {
	if wildcardFilter(filters) {
		return ""
	}
	extensions := make([]string, 0)
	for _, filter := range filters {
		extensions = append(extensions, filter.Extensions...)
	}
	return strings.Join(extensions, ",")
}

func boolArg(value bool) string {
	if value {
		return "1"
	}
	return "0"
}

func darwinChooseDirectory(ctx context.Context, opts Options, osascript string, input json.RawMessage) (any, error) {
	var in chooseDirectoryInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	title := in.Title
	if title == "" {
		title = "选择文件夹"
	}
	defaultDir := defaultDirectory(opts, in.DefaultPath)

	command := "set chosenItem to choose folder with prompt promptText"
	if defaultDir != "" {
		command += " default location (POSIX file defaultPathText)"
	}
	if in.Multiple {
		command += " with multiple selections allowed"
	}

	output := darwinPathOutput(in.Multiple)

	script := darwinDirectoryScript(command, output)
	result := opts.Runner.Run(ctx, osascript, "-e", script, "--", boolArg(in.Multiple), title, defaultDir)
	if nativeErr := errorFromResult(result, "osascript"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathsOutput{Paths: splitLines(result.Stdout)}, nil
}

func darwinDirectoryScript(command, output string) string {
	return `on run argv
	set multipleAllowed to (item 1 of argv is "1")
	set promptText to item 2 of argv
	set defaultPathText to item 3 of argv
	` + command + `
` + output + `
end run`
}

func darwinChooseSave(ctx context.Context, opts Options, osascript string, input json.RawMessage) (any, error) {
	var in chooseSaveInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	if _, filterErr := normalizeFilters(in.Filters); filterErr != nil {
		return nil, filterErr
	}
	title := in.Title
	if title == "" {
		title = "保存文件"
	}
	defaultDir := defaultDirectory(opts, in.DefaultPath)
	defaultName := in.DefaultName
	if defaultName == "" {
		defaultName = defaultFileName(opts, in.DefaultPath)
	}

	command := "set chosenItem to choose file name with prompt promptText"
	if defaultName != "" {
		command += " default name defaultNameText"
	}
	if defaultDir != "" {
		command += " default location (POSIX file defaultPathText)"
	}

	script := `on run argv
	set promptText to item 1 of argv
	set defaultNameText to item 2 of argv
	set defaultPathText to item 3 of argv
	` + command + `
	return POSIX path of chosenItem
end run`
	result := opts.Runner.Run(ctx, osascript, "-e", script, "--", title, defaultName, defaultDir)
	if nativeErr := errorFromResult(result, "osascript"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathOutput{Path: strings.TrimRight(string(result.Stdout), "\r\n")}, nil
}

// defaultFileName 只在 defaultPath 指向一个已有文件时推导默认文件名；
// 目录本身的名字不是文件名。
func defaultFileName(opts Options, defaultPath string) string {
	if defaultPath == "" {
		return ""
	}
	info, err := opts.Stat(defaultPath)
	if err != nil || info.IsDir() {
		return ""
	}
	return filepath.Base(defaultPath)
}

func darwinNotification(ctx context.Context, opts Options, osascript string, input json.RawMessage) (any, error) {
	var in notificationShowInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	script := `on run argv
	display notification (item 1 of argv) with title (item 2 of argv)
end run`
	result := opts.Runner.Run(ctx, osascript, "-e", script, "--", in.Body, in.Title)
	if nativeErr := errorFromResult(result, "osascript"); nativeErr != nil {
		return nil, nativeErr
	}
	return struct{}{}, nil
}

// platformRelease 返回 Darwin 内核版本，与 Node 的 os.release() 语义一致。
func darwinRelease(ctx context.Context, opts Options) string {
	uname := firstExisting(opts, darwinUname)
	if uname == "" {
		return ""
	}
	result := opts.Runner.Run(ctx, uname, "-r")
	if result.Err != nil {
		return ""
	}
	return strings.TrimSpace(string(result.Stdout))
}

// platformTheme 读全局 AppleInterfaceStyle。键不存在表示浅色，这与
// `defaults read` 返回 1 的行为一致；其它失败返回 unknown。
func darwinTheme(ctx context.Context, opts Options) string {
	defaults := firstExisting(opts, darwinDefaults)
	if defaults == "" {
		return themeUnknown
	}
	result := opts.Runner.Run(ctx, defaults, "read", "-g", "AppleInterfaceStyle")
	if result.Err != nil {
		if exitCode(result.Err) == 1 {
			return themeLight
		}
		return themeUnknown
	}
	switch strings.ToLower(strings.TrimSpace(string(result.Stdout))) {
	case "dark":
		return themeDark
	case "light":
		return themeLight
	default:
		return themeUnknown
	}
}
