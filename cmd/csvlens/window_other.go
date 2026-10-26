//go:build !windows

package main

import (
	"fmt"
	"os"
)

// 非 Windows 平台没有内置窗口，直接使用浏览器（主要用于开发调试）。
func openWindow(url string, debug bool) bool { return false }

func fatal(msg string) {
	fmt.Fprintln(os.Stderr, msg)
	os.Exit(1)
}
