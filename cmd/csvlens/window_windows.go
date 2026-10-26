//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

var (
	user32                            = syscall.NewLazyDLL("user32.dll")
	procSetProcessDpiAwarenessContext = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetProcessDPIAware            = user32.NewProc("SetProcessDPIAware")
	procGetDpiForSystem               = user32.NewProc("GetDpiForSystem")
	procGetSystemMetrics              = user32.NewProc("GetSystemMetrics")
	procMessageBoxW                   = user32.NewProc("MessageBoxW")
)

// openWindow 在 WebView2 窗口中打开页面，窗口关闭后返回 true。
// 系统没有 WebView2 运行时则直接返回 false（不会创建窗口），由调用方改用浏览器。
func openWindow(url string, debug bool) bool {
	if v, err := webviewloader.GetInstalledVersion(); err != nil || v == "" {
		return false
	}
	setDPIAware()
	width, height := windowSize(1440, 920)
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     debug,
		AutoFocus: true,
		DataPath:  filepath.Join(dataDir(), "WebView2"),
		WindowOptions: webview2.WindowOptions{
			Title:  appName,
			Width:  width,
			Height: height,
			IconId: 1, // rsrc_windows_amd64.syso 中的图标组
			Center: true,
		},
	})
	if w == nil {
		return false
	}
	defer w.Destroy()
	w.Navigate(url)
	w.Run()
	return true
}

func setDPIAware() {
	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4（Windows 10 1703+），否则退回系统级 DPI 感知
	if procSetProcessDpiAwarenessContext.Find() == nil {
		if r, _, _ := procSetProcessDpiAwarenessContext.Call(^uintptr(3)); r != 0 {
			return
		}
	}
	if procSetProcessDPIAware.Find() == nil {
		_, _, _ = procSetProcessDPIAware.Call()
	}
}

// windowSize 按系统缩放比例换算窗口尺寸，并限制在屏幕范围内
func windowSize(w, h int) (uint, uint) {
	dpi := 96
	if procGetDpiForSystem.Find() == nil {
		if r, _, _ := procGetDpiForSystem.Call(); r != 0 {
			dpi = int(r)
		}
	}
	w, h = w*dpi/96, h*dpi/96
	sw, _, _ := procGetSystemMetrics.Call(0) // SM_CXSCREEN
	sh, _, _ := procGetSystemMetrics.Call(1) // SM_CYSCREEN
	if maxW := int(sw) * 92 / 100; maxW > 0 && w > maxW {
		w = maxW
	}
	if maxH := int(sh) * 88 / 100; maxH > 0 && h > maxH {
		h = maxH
	}
	return uint(w), uint(h)
}

func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base, _ = os.UserCacheDir()
	}
	return filepath.Join(base, "CSVLens")
}

func fatal(msg string) {
	title, _ := syscall.UTF16PtrFromString(appName)
	text, _ := syscall.UTF16PtrFromString(msg)
	_, _, _ = procMessageBoxW.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10) // MB_ICONERROR
	os.Exit(1)
}
