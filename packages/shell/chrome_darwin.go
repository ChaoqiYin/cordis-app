//go:build darwin

package main

/*
#cgo darwin LDFLAGS: -framework Cocoa
#include <objc/message.h>
#include <objc/runtime.h>

// 重新载入动作由 Go 侧 //export 的 cordisReloadCallback 实现。菜单回调在
// 触发它的 UI 线程上直接调用这个 Go 函数，不再经过 Dispatch。
extern void cordisReloadCallback(void);

static void cordisReloadAction(id self, SEL _cmd, id sender) {
	(void)self;
	(void)_cmd;
	(void)sender;
	cordisReloadCallback();
}

static id cordisString(const char *value) {
	return ((id (*)(id, SEL, const char *))objc_msgSend)(
		(id)objc_getClass("NSString"),
		sel_registerName("stringWithUTF8String:"),
		value);
}

// cordisChromeTarget 惰性创建一个 NSObject 子类实例，作为菜单动作的目标。
// 类只注册一次；实例在进程生命周期内由主菜单持有。
static id cordisChromeTarget(void) {
	static id target = nil;
	if (target != nil) return target;

	Class cls = objc_lookUpClass("CordisWindowChromeTarget");
	if (cls == nil) {
		cls = objc_allocateClassPair(
			(Class)objc_getClass("NSObject"), "CordisWindowChromeTarget", 0);
		if (cls == nil) return nil;
		class_addMethod(cls, sel_registerName("reload:"),
			(IMP)cordisReloadAction, "v@:@");
		objc_registerClassPair(cls);
	}
	target = ((id (*)(id, SEL))objc_msgSend)(
		(id)cls, sel_registerName("new"));
	return target;
}

static id cordisNewMenu(id title) {
	id menu = ((id (*)(id, SEL))objc_msgSend)(
		(id)objc_getClass("NSMenu"), sel_registerName("alloc"));
	return ((id (*)(id, SEL, id))objc_msgSend)(
		menu, sel_registerName("initWithTitle:"), title);
}

static id cordisNewMenuItem(id title, SEL action, id key) {
	id item = ((id (*)(id, SEL))objc_msgSend)(
		(id)objc_getClass("NSMenuItem"), sel_registerName("alloc"));
	return ((id (*)(id, SEL, id, SEL, id))objc_msgSend)(
		item, sel_registerName("initWithTitle:action:keyEquivalent:"),
		title, action, key);
}

// cordisInstallWindowChrome 注册最小的主菜单：「重新载入」(⌘R) 与「退出」(⌘Q)。
//
// 必须在应用主线程、且窗口已经创建之后调用。菜单动作的目标是我们自己的
// 对象，所以点击不会落到页面或 responder 链上；窗口销毁后 Go 侧会 detach，
// 动作只返回 busy，不触碰已销毁的 webview。
static void cordisInstallWindowChrome(void *handle) {
	(void)handle;

	id app = ((id (*)(id, SEL))objc_msgSend)(
		(id)objc_getClass("NSApplication"), sel_registerName("sharedApplication"));
	if (app == nil) return;

	id target = cordisChromeTarget();
	if (target == nil) return;

	id processName = ((id (*)(id, SEL))objc_msgSend)(
		((id (*)(id, SEL))objc_msgSend)(
			(id)objc_getClass("NSProcessInfo"), sel_registerName("processInfo")),
		sel_registerName("processName"));

	// 应用菜单：macOS 的第一个主菜单项，标题取进程名。
	id appItem = ((id (*)(id, SEL))objc_msgSend)(
		(id)objc_getClass("NSMenuItem"), sel_registerName("alloc"));
	appItem = ((id (*)(id, SEL))objc_msgSend)(appItem, sel_registerName("init"));

	id appMenu = cordisNewMenu(processName);

	id reloadItem = cordisNewMenuItem(
		cordisString("重新载入"), sel_registerName("reload:"), cordisString("r"));
	((void (*)(id, SEL, id))objc_msgSend)(
		reloadItem, sel_registerName("setTarget:"), target);
	// NSCommandKeyMask = 1 << 20。显式设置，不依赖 NSMenuItem 的默认修饰键。
	((void (*)(id, SEL, unsigned long))objc_msgSend)(
		reloadItem, sel_registerName("setKeyEquivalentModifierMask:"),
		(unsigned long)(1UL << 20));
	((void (*)(id, SEL, id))objc_msgSend)(
		appMenu, sel_registerName("addItem:"), reloadItem);

	((void (*)(id, SEL, id))objc_msgSend)(
		appMenu, sel_registerName("addItem:"),
		((id (*)(id, SEL))objc_msgSend)(
			(id)objc_getClass("NSMenuItem"), sel_registerName("separatorItem")));

	// 退出项 target 留空，走 responder 链交给 NSApplication 的 terminate:。
	id quitItem = cordisNewMenuItem(
		cordisString("退出"), sel_registerName("terminate:"), cordisString("q"));
	((void (*)(id, SEL, id))objc_msgSend)(
		appMenu, sel_registerName("addItem:"), quitItem);

	((void (*)(id, SEL, id))objc_msgSend)(
		appItem, sel_registerName("setSubmenu:"), appMenu);

	id mainMenu = cordisNewMenu(cordisString(""));
	((void (*)(id, SEL, id))objc_msgSend)(
		mainMenu, sel_registerName("addItem:"), appItem);
	((void (*)(id, SEL, id))objc_msgSend)(
		app, sel_registerName("setMainMenu:"), mainMenu);
}
*/
import "C"

// installWindowChrome 在窗口创建且 windowController.attach 之后安装一次。
// 降级路径不会走到 runWindow，因此不会安装菜单。
func installWindowChrome(backend windowBackend, reload func()) {
	setChromeReload(reload)
	C.cordisInstallWindowChrome(backend.Window())
}
