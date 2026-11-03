package native

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
)

// Linux 平台依赖桌面环境自带工具。打包形态 PATH 只有 bin/，全部使用绝对路径；
// 探测不到工具时命令不注册，/info.commands 如实反映能力。
const (
	linuxZenityCandidates    = "/usr/bin/zenity,/usr/local/bin/zenity,/snap/bin/zenity"
	linuxKdialogCandidates   = "/usr/bin/kdialog,/usr/local/bin/kdialog"
	linuxNotifyCandidates    = "/usr/bin/notify-send,/usr/local/bin/notify-send"
	linuxXdgOpenCandidates   = "/usr/bin/xdg-open,/usr/local/bin/xdg-open"
	linuxUnameCandidates     = "/usr/bin/uname,/bin/uname"
	linuxGsettingsCandidates = "/usr/bin/gsettings,/usr/local/bin/gsettings"
)

// splitCandidates 把常量里的候选路径拆开，firstExisting 负责按顺序探测。
func splitCandidates(list string) []string {
	return strings.Split(list, ",")
}

func linuxPathTool(opts Options) (tool string, path string) {
	if path := firstExisting(opts, splitCandidates(linuxZenityCandidates)...); path != "" {
		return "zenity", path
	}
	if path := firstExisting(opts, splitCandidates(linuxKdialogCandidates)...); path != "" {
		return "kdialog", path
	}
	return "", ""
}

func registerLinux(reg *Registry, opts Options) {
	if tool, path := linuxPathTool(opts); tool != "" {
		reg.Register(CommandPathChooseOpen, func(ctx context.Context, input json.RawMessage) (any, error) {
			if tool == "zenity" {
				return linuxZenityChooseOpen(ctx, opts, path, input)
			}
			return linuxKdialogChooseOpen(ctx, opts, path, input)
		})
		reg.Register(CommandPathChooseDirectory, func(ctx context.Context, input json.RawMessage) (any, error) {
			if tool == "zenity" {
				return linuxZenityChooseDirectory(ctx, opts, path, input)
			}
			return linuxKdialogChooseDirectory(ctx, opts, path, input)
		})
		reg.Register(CommandPathChooseSave, func(ctx context.Context, input json.RawMessage) (any, error) {
			if tool == "zenity" {
				return linuxZenityChooseSave(ctx, opts, path, input)
			}
			return linuxKdialogChooseSave(ctx, opts, path, input)
		})
	}

	registerWindow(reg, opts)

	if notify := firstExisting(opts, splitCandidates(linuxNotifyCandidates)...); notify != "" {
		reg.Register(CommandNotificationShow, func(ctx context.Context, input json.RawMessage) (any, error) {
			return linuxNotification(ctx, opts, notify, input)
		})
	}

	if xdgOpen := firstExisting(opts, splitCandidates(linuxXdgOpenCandidates)...); xdgOpen != "" {
		reg.Register(CommandShellOpenExternal, openExternalHandler(opts, commandSpec{Name: xdgOpen}))
		reg.Register(CommandShellShowItemInFolder, showItemInFolderHandler(opts, xdgOpen, showItemLinux))
	}

	registerSystemInfo(reg, opts)
}

func linuxZenityChooseOpen(ctx context.Context, opts Options, zenity string, input json.RawMessage) (any, error) {
	var in chooseOpenInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	filters, filterErr := normalizeFilters(in.Filters)
	if filterErr != nil {
		return nil, filterErr
	}
	args := []string{"--file-selection", "--title", promptOr(in.Title, "选择文件")}
	if in.Multiple {
		args = append(args, "--multiple", "--separator", "\n")
	}
	if dir := defaultDirectory(opts, in.DefaultPath); dir != "" {
		args = append(args, "--filename", dir)
	}
	args = append(args, zenityFilters(filters)...)

	result := opts.Runner.Run(ctx, zenity, args...)
	if nativeErr := linuxChooseError(result, "zenity"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathsOutput{Paths: splitLines(result.Stdout)}, nil
}

func linuxZenityChooseDirectory(ctx context.Context, opts Options, zenity string, input json.RawMessage) (any, error) {
	var in chooseDirectoryInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	args := []string{"--file-selection", "--directory", "--title", promptOr(in.Title, "选择文件夹")}
	if in.Multiple {
		args = append(args, "--multiple", "--separator", "\n")
	}
	if dir := defaultDirectory(opts, in.DefaultPath); dir != "" {
		args = append(args, "--filename", dir)
	}

	result := opts.Runner.Run(ctx, zenity, args...)
	if nativeErr := linuxChooseError(result, "zenity"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathsOutput{Paths: splitLines(result.Stdout)}, nil
}

func linuxZenityChooseSave(ctx context.Context, opts Options, zenity string, input json.RawMessage) (any, error) {
	var in chooseSaveInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	filters, filterErr := normalizeFilters(in.Filters)
	if filterErr != nil {
		return nil, filterErr
	}
	args := []string{"--file-selection", "--save", "--confirm-overwrite", "--title", promptOr(in.Title, "保存文件")}
	if target := defaultSavePath(opts, in.DefaultPath, in.DefaultName); target != "" {
		args = append(args, "--filename", target)
	}
	args = append(args, zenityFilters(filters)...)

	result := opts.Runner.Run(ctx, zenity, args...)
	if nativeErr := linuxChooseError(result, "zenity"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathOutput{Path: strings.TrimRight(string(result.Stdout), "\r\n")}, nil
}

func linuxKdialogChooseOpen(ctx context.Context, opts Options, kdialog string, input json.RawMessage) (any, error) {
	var in chooseOpenInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	filters, filterErr := normalizeFilters(in.Filters)
	if filterErr != nil {
		return nil, filterErr
	}
	startDir := defaultDirectory(opts, in.DefaultPath)
	if startDir == "" {
		startDir = ":"
	}
	args := []string{"--title", promptOr(in.Title, "选择文件"), "--getopenfilename", startDir}
	if filter := kdialogFilter(filters); filter != "" {
		args = append(args, filter)
	}
	if in.Multiple {
		args = append(args, "--multiple", "--separate-output")
	}

	result := opts.Runner.Run(ctx, kdialog, args...)
	if nativeErr := linuxChooseError(result, "kdialog"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathsOutput{Paths: splitLines(result.Stdout)}, nil
}

func linuxKdialogChooseDirectory(ctx context.Context, opts Options, kdialog string, input json.RawMessage) (any, error) {
	var in chooseDirectoryInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	startDir := defaultDirectory(opts, in.DefaultPath)
	if startDir == "" {
		startDir = ":"
	}
	args := []string{"--title", promptOr(in.Title, "选择文件夹"), "--getexistingdirectory", startDir}

	result := opts.Runner.Run(ctx, kdialog, args...)
	if nativeErr := linuxChooseError(result, "kdialog"); nativeErr != nil {
		return nil, nativeErr
	}
	paths := splitLines(result.Stdout)
	if len(paths) == 0 {
		return pathsOutput{Paths: []string{}}, nil
	}
	// kdialog 的目录选择没有多选能力；契约仍返回数组，只含用户选中的一项。
	return pathsOutput{Paths: paths[:1]}, nil
}

func linuxKdialogChooseSave(ctx context.Context, opts Options, kdialog string, input json.RawMessage) (any, error) {
	var in chooseSaveInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	filters, filterErr := normalizeFilters(in.Filters)
	if filterErr != nil {
		return nil, filterErr
	}
	target := defaultSavePath(opts, in.DefaultPath, in.DefaultName)
	if target == "" {
		target = ":"
	}
	args := []string{"--title", promptOr(in.Title, "保存文件"), "--getsavefilename", target}
	if filter := kdialogFilter(filters); filter != "" {
		args = append(args, filter)
	}

	result := opts.Runner.Run(ctx, kdialog, args...)
	if nativeErr := linuxChooseError(result, "kdialog"); nativeErr != nil {
		return nil, nativeErr
	}
	return pathOutput{Path: strings.TrimRight(string(result.Stdout), "\r\n")}, nil
}

func linuxNotification(ctx context.Context, opts Options, notifySend string, input json.RawMessage) (any, error) {
	var in notificationShowInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	result := opts.Runner.Run(ctx, notifySend, in.Title, in.Body)
	if nativeErr := errorFromResult(result, "notify-send"); nativeErr != nil {
		return nil, nativeErr
	}
	return struct{}{}, nil
}

// linuxChooseError 把对话框工具的退出码 1 视为用户取消；这些工具取消时不写
// stderr，不能只靠 errorFromResult 的文本判断。
func linuxChooseError(result CommandResult, command string) *Error {
	if result.Err != nil && exitCode(result.Err) == 1 {
		return &Error{Code: CodeCancelled}
	}
	return errorFromResult(result, command)
}

func zenityFilters(filters []nativePathFilter) []string {
	if wildcardFilter(filters) {
		return nil
	}
	args := make([]string, 0, len(filters)*2)
	for _, filter := range filters {
		patterns := make([]string, 0, len(filter.Extensions))
		for _, extension := range filter.Extensions {
			patterns = append(patterns, "*."+extension)
		}
		args = append(args, "--file-filter", filter.Name+" | "+strings.Join(patterns, " "))
	}
	return args
}

func kdialogFilter(filters []nativePathFilter) string {
	if wildcardFilter(filters) {
		return ""
	}
	parts := make([]string, 0, len(filters))
	for _, filter := range filters {
		patterns := make([]string, 0, len(filter.Extensions))
		for _, extension := range filter.Extensions {
			patterns = append(patterns, "*."+extension)
		}
		parts = append(parts, filter.Name+" ("+strings.Join(patterns, " ")+")")
	}
	return strings.Join(parts, "|")
}

// defaultSavePath 为保存对话框合成起始路径：defaultPath 是目录时拼上默认文件名，
// 是文件时直接使用；两者都没有时返回空。
func defaultSavePath(opts Options, defaultPath, defaultName string) string {
	if defaultPath == "" {
		return defaultName
	}
	info, err := opts.Stat(defaultPath)
	if err == nil && info.IsDir() {
		if defaultName != "" {
			return filepath.Join(defaultPath, defaultName)
		}
		return defaultPath
	}
	return defaultPath
}

func promptOr(title, fallback string) string {
	if strings.TrimSpace(title) == "" {
		return fallback
	}
	return title
}

// platformRelease 返回 Linux 内核版本，与 Node 的 os.release() 语义一致。
func linuxRelease(ctx context.Context, opts Options) string {
	uname := firstExisting(opts, splitCandidates(linuxUnameCandidates)...)
	if uname == "" {
		return ""
	}
	result := opts.Runner.Run(ctx, uname, "-r")
	if result.Err != nil {
		return ""
	}
	return strings.TrimSpace(string(result.Stdout))
}

// platformTheme 通过 GNOME 的 color-scheme 判断深浅色；其它桌面环境或没有
// gsettings 时返回 unknown。
func linuxTheme(ctx context.Context, opts Options) string {
	gsettings := firstExisting(opts, splitCandidates(linuxGsettingsCandidates)...)
	if gsettings == "" {
		return themeUnknown
	}
	result := opts.Runner.Run(ctx, gsettings, "get", "org.gnome.desktop.interface", "color-scheme")
	if result.Err != nil {
		return themeUnknown
	}
	if linuxThemeValue(string(result.Stdout)) == themeUnknown {
		result = opts.Runner.Run(ctx, gsettings, "get", "org.gnome.desktop.interface", "gtk-theme")
		if result.Err != nil {
			return themeUnknown
		}
	}
	return linuxThemeValue(string(result.Stdout))
}

func linuxThemeValue(output string) string {
	value := strings.ToLower(strings.TrimSpace(output))
	switch {
	case strings.Contains(value, "dark"):
		return themeDark
	case strings.Contains(value, "light"), strings.Contains(value, "default"):
		return themeLight
	default:
		return themeUnknown
	}
}
