//go:build windows

package native

import (
	"context"
	"encoding/json"
	"fmt"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

// Windows 文件对话框使用 COM 的 IFileOpenDialog / IFileSaveDialog。
//
// 对话框必须在 STA 线程上创建与显示，因此 handler 另起一个 goroutine 并
// LockOSThread，避免占用 Go 运行时可能复用的其它线程。
var (
	ole32                           = syscall.NewLazyDLL("ole32.dll")
	shell32                         = syscall.NewLazyDLL("shell32.dll")
	procCoInitializeEx              = ole32.NewProc("CoInitializeEx")
	procCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	procCoUninitialize              = ole32.NewProc("CoUninitialize")
	procCoTaskMemFree               = ole32.NewProc("CoTaskMemFree")
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
)

type winGUID struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	clsidFileOpenDialog = winGUID{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	clsidFileSaveDialog = winGUID{0xC0B4E2F3, 0xBA21, 0x4773, [8]byte{0x8D, 0xBA, 0x33, 0x5E, 0xC9, 0x46, 0xEB, 0x8B}}
	iidIFileOpenDialog  = winGUID{0xD57C7288, 0xD4AD, 0x4768, [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
	iidIFileDialog      = winGUID{0x42F85136, 0xDB7E, 0x439C, [8]byte{0x85, 0xF1, 0xE4, 0x07, 0x5D, 0x13, 0x5F, 0xC8}}
	iidIShellItem       = winGUID{0x43826D1E, 0xE718, 0x42EE, [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE}}
)

// IFileDialog / IFileOpenDialog 的 vtable 索引。0-2 是 IUnknown，
// 3 是 IModalWindow::Show，4 起是 IFileDialog 的方法。
const (
	vtblRelease                 = 2
	vtblShow                    = 3
	vtblSetFileTypes            = 4
	vtblSetOptions              = 9
	vtblSetFolder               = 12
	vtblSetFileName             = 15
	vtblSetTitle                = 17
	vtblGetResult               = 20
	vtblSetDefaultExtension     = 22
	vtblOpenGetResults          = 27
	vtblItemArrayGetCount       = 7
	vtblItemArrayGetItemAt      = 8
	vtblShellItemGetDisplayName = 5
)

const (
	clsctxInprocServer      = 1
	coinitApartmentThreaded = 0x2
	fosOverwritePrompt      = 0x2
	fosPickFolders          = 0x20
	fosForceFilesystem      = 0x40
	fosAllowMultiselect     = 0x200
	fosPathMustExist        = 0x800
	fosFileMustExist        = 0x1000
	sigdnFilesysPath        = 0x80058000
	hresultCancelled        = 0x800704C7
)

type comdlgFilterSpec struct {
	Name *uint16
	Spec *uint16
}

func windowsChoosePath(_ context.Context, opts Options, kind pathKind, input json.RawMessage) (any, error) {
	type response struct {
		value any
		err   error
	}
	done := make(chan response, 1)

	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()

		hr, _, _ := procCoInitializeEx.Call(0, coinitApartmentThreaded)
		if hresultFailed(hr) {
			done <- response{err: &Error{
				Code:    CodeInternal,
				Message: fmt.Sprintf("CoInitializeEx 失败: 0x%08x", uint32(hr)),
			}}
			return
		}
		defer procCoUninitialize.Call()

		value, err := showWindowsDialog(opts, kind, input)
		done <- response{value: value, err: err}
	}()

	res := <-done
	return res.value, res.err
}

func showWindowsDialog(opts Options, kind pathKind, input json.RawMessage) (any, error) {
	var clsid, iid winGUID
	switch kind {
	case pathOpen, pathDirectory:
		clsid, iid = clsidFileOpenDialog, iidIFileOpenDialog
	default:
		clsid, iid = clsidFileSaveDialog, iidIFileDialog
	}

	dialog, hr := createCOM(&clsid, &iid)
	if hresultFailed(hr) || dialog == nil {
		return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("创建文件对话框失败: 0x%08x", uint32(hr))}
	}
	defer comRelease(dialog)

	switch kind {
	case pathOpen:
		return showWindowsOpen(opts, dialog, input, false)
	case pathDirectory:
		return showWindowsOpen(opts, dialog, input, true)
	default:
		return showWindowsSave(opts, dialog, input)
	}
}

func showWindowsOpen(opts Options, dialog unsafe.Pointer, input json.RawMessage, directory bool) (any, error) {
	multiple := false
	title := "选择文件"
	defaultPath := ""
	var filters []nativePathFilter

	if directory {
		var in chooseDirectoryInput
		if err := decodeInput(input, &in); err != nil {
			return nil, err
		}
		multiple, title, defaultPath = in.Multiple, in.Title, in.DefaultPath
		if title == "" {
			title = "选择文件夹"
		}
	} else {
		var in chooseOpenInput
		if err := decodeInput(input, &in); err != nil {
			return nil, err
		}
		normalized, filterErr := normalizeFilters(in.Filters)
		if filterErr != nil {
			return nil, filterErr
		}
		multiple, title, defaultPath, filters = in.Multiple, in.Title, in.DefaultPath, normalized
		if title == "" {
			title = "选择文件"
		}
	}

	options := uint32(fosForceFilesystem | fosPathMustExist)
	if directory {
		options |= fosPickFolders
	} else {
		options |= fosFileMustExist
	}
	if multiple {
		options |= fosAllowMultiselect
	}
	if nativeErr := setDialogOptions(dialog, options); nativeErr != nil {
		return nil, nativeErr
	}
	setDialogTitle(dialog, title)
	setDialogFolder(dialog, defaultDirectory(opts, defaultPath))
	if !directory {
		setDialogFilters(dialog, filters)
	}

	if nativeErr := showDialog(dialog); nativeErr != nil {
		return nil, nativeErr
	}
	paths, nativeErr := collectOpenResults(dialog)
	if nativeErr != nil {
		return nil, nativeErr
	}
	return pathsOutput{Paths: paths}, nil
}

func showWindowsSave(opts Options, dialog unsafe.Pointer, input json.RawMessage) (any, error) {
	var in chooseSaveInput
	if err := decodeInput(input, &in); err != nil {
		return nil, err
	}
	filters, filterErr := normalizeFilters(in.Filters)
	if filterErr != nil {
		return nil, filterErr
	}
	title := in.Title
	if title == "" {
		title = "保存文件"
	}
	defaultName := in.DefaultName
	if defaultName == "" {
		defaultName = defaultFileName(opts, in.DefaultPath)
	}

	options := uint32(fosOverwritePrompt | fosForceFilesystem | fosPathMustExist)
	if nativeErr := setDialogOptions(dialog, options); nativeErr != nil {
		return nil, nativeErr
	}
	setDialogTitle(dialog, title)
	setDialogFolder(dialog, defaultDirectory(opts, in.DefaultPath))
	if defaultName != "" {
		if nativeErr := setDialogFileName(dialog, defaultName); nativeErr != nil {
			return nil, nativeErr
		}
	}
	setDialogFilters(dialog, filters)
	setDialogDefaultExtension(dialog, filters)

	if nativeErr := showDialog(dialog); nativeErr != nil {
		return nil, nativeErr
	}
	path, nativeErr := dialogResultPath(dialog)
	if nativeErr != nil {
		return nil, nativeErr
	}
	return pathOutput{Path: path}, nil
}

func createCOM(clsid, iid *winGUID) (unsafe.Pointer, uintptr) {
	var object unsafe.Pointer
	hr, _, _ := procCoCreateInstance.Call(
		uintptr(unsafe.Pointer(clsid)),
		0,
		clsctxInprocServer,
		uintptr(unsafe.Pointer(iid)),
		uintptr(unsafe.Pointer(&object)),
	)
	return object, hr
}

// comCall 按 vtable 索引调用 COM 方法。调用方负责保证参数类型与签名一致。
func comCall(object unsafe.Pointer, index int, args ...uintptr) uintptr {
	vtable := *(*unsafe.Pointer)(object)
	method := *(*uintptr)(unsafe.Pointer(uintptr(vtable) + uintptr(index)*unsafe.Sizeof(uintptr(0))))
	callArgs := make([]uintptr, 0, len(args)+1)
	callArgs = append(callArgs, uintptr(object))
	callArgs = append(callArgs, args...)
	result, _, _ := syscall.SyscallN(method, callArgs...)
	return result
}

func comRelease(object unsafe.Pointer) {
	if object != nil {
		comCall(object, vtblRelease)
	}
}

func hresultFailed(hr uintptr) bool {
	return int32(uint32(hr)) < 0
}

func setDialogOptions(dialog unsafe.Pointer, options uint32) *Error {
	if hr := comCall(dialog, vtblSetOptions, uintptr(options)); hresultFailed(hr) {
		return &Error{Code: CodeInternal, Message: fmt.Sprintf("设置对话框选项失败: 0x%08x", uint32(hr))}
	}
	return nil
}

func setDialogTitle(dialog unsafe.Pointer, title string) {
	if title == "" {
		return
	}
	value, _ := syscall.UTF16PtrFromString(title)
	comCall(dialog, vtblSetTitle, uintptr(unsafe.Pointer(value)))
	runtime.KeepAlive(value)
}

func setDialogFileName(dialog unsafe.Pointer, name string) *Error {
	value, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return &Error{Code: CodeInvalid, Message: "默认文件名包含非法字符"}
	}
	if hr := comCall(dialog, vtblSetFileName, uintptr(unsafe.Pointer(value))); hresultFailed(hr) {
		return &Error{Code: CodeInternal, Message: fmt.Sprintf("设置默认文件名失败: 0x%08x", uint32(hr))}
	}
	runtime.KeepAlive(value)
	return nil
}

func setDialogFolder(dialog unsafe.Pointer, directory string) {
	if directory == "" {
		return
	}
	path, err := syscall.UTF16PtrFromString(directory)
	if err != nil {
		return
	}
	var item unsafe.Pointer
	hr, _, _ := procSHCreateItemFromParsingName.Call(
		uintptr(unsafe.Pointer(path)),
		0,
		uintptr(unsafe.Pointer(&iidIShellItem)),
		uintptr(unsafe.Pointer(&item)),
	)
	runtime.KeepAlive(path)
	if hresultFailed(hr) || item == nil {
		return
	}
	defer comRelease(item)
	comCall(dialog, vtblSetFolder, uintptr(item))
}

func setDialogFilters(dialog unsafe.Pointer, filters []nativePathFilter) {
	if len(filters) == 0 || wildcardFilter(filters) {
		return
	}
	specs := make([]comdlgFilterSpec, 0, len(filters))
	for _, filter := range filters {
		patterns := make([]string, 0, len(filter.Extensions))
		for _, extension := range filter.Extensions {
			patterns = append(patterns, "*."+extension)
		}
		name, _ := syscall.UTF16PtrFromString(filter.Name)
		spec, _ := syscall.UTF16PtrFromString(strings.Join(patterns, ";"))
		specs = append(specs, comdlgFilterSpec{Name: name, Spec: spec})
	}
	comCall(dialog, vtblSetFileTypes, uintptr(unsafe.Pointer(&specs[0])), uintptr(len(specs)))
	runtime.KeepAlive(specs)
}

func setDialogDefaultExtension(dialog unsafe.Pointer, filters []nativePathFilter) {
	if len(filters) == 0 || wildcardFilter(filters) {
		return
	}
	extension := filters[0].Extensions[0]
	if extension == "" {
		return
	}
	value, _ := syscall.UTF16PtrFromString(extension)
	comCall(dialog, vtblSetDefaultExtension, uintptr(unsafe.Pointer(value)))
	runtime.KeepAlive(value)
}

func showDialog(dialog unsafe.Pointer) *Error {
	hr := comCall(dialog, vtblShow, 0)
	if uint32(hr) == hresultCancelled {
		return &Error{Code: CodeCancelled}
	}
	if hresultFailed(hr) {
		return &Error{Code: CodeInternal, Message: fmt.Sprintf("显示文件对话框失败: 0x%08x", uint32(hr))}
	}
	return nil
}

func collectOpenResults(dialog unsafe.Pointer) ([]string, *Error) {
	var items unsafe.Pointer
	if hr := comCall(dialog, vtblOpenGetResults, uintptr(unsafe.Pointer(&items))); hresultFailed(hr) || items == nil {
		return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("读取选择结果失败: 0x%08x", uint32(hr))}
	}
	defer comRelease(items)

	var count uint32
	if hr := comCall(items, vtblItemArrayGetCount, uintptr(unsafe.Pointer(&count))); hresultFailed(hr) {
		return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("读取结果数量失败: 0x%08x", uint32(hr))}
	}
	paths := make([]string, 0, count)
	for index := uint32(0); index < count; index++ {
		var item unsafe.Pointer
		if hr := comCall(items, vtblItemArrayGetItemAt, uintptr(index), uintptr(unsafe.Pointer(&item))); hresultFailed(hr) || item == nil {
			return nil, &Error{Code: CodeInternal, Message: fmt.Sprintf("读取选择项失败: 0x%08x", uint32(hr))}
		}
		path, nativeErr := shellItemPath(item)
		comRelease(item)
		if nativeErr != nil {
			return nil, nativeErr
		}
		paths = append(paths, path)
	}
	return paths, nil
}

func dialogResultPath(dialog unsafe.Pointer) (string, *Error) {
	var item unsafe.Pointer
	hr := comCall(dialog, vtblGetResult, uintptr(unsafe.Pointer(&item)))
	if uint32(hr) == hresultCancelled {
		return "", &Error{Code: CodeCancelled}
	}
	if hresultFailed(hr) || item == nil {
		return "", &Error{Code: CodeInternal, Message: fmt.Sprintf("读取保存路径失败: 0x%08x", uint32(hr))}
	}
	defer comRelease(item)
	return shellItemPath(item)
}

func shellItemPath(item unsafe.Pointer) (string, *Error) {
	var raw *uint16
	hr := comCall(item, vtblShellItemGetDisplayName, sigdnFilesysPath, uintptr(unsafe.Pointer(&raw)))
	if hresultFailed(hr) || raw == nil {
		return "", &Error{Code: CodeInternal, Message: fmt.Sprintf("读取文件路径失败: 0x%08x", uint32(hr))}
	}
	defer procCoTaskMemFree.Call(uintptr(unsafe.Pointer(raw)))
	return utf16PtrToString(raw), nil
}

// utf16PtrToString 读取以 NUL 结尾的 Windows 宽字符串。syscall 只提供按切片
// 转换的 UTF16ToString，因此先自己数长度。
func utf16PtrToString(ptr *uint16) string {
	if ptr == nil {
		return ""
	}
	length := 0
	for current := unsafe.Pointer(ptr); *(*uint16)(current) != 0; current = unsafe.Add(current, 2) {
		length++
	}
	return syscall.UTF16ToString(unsafe.Slice(ptr, length))
}
