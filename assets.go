// Package csvlens 把网页版 CSV Lens 的全部静态资源打包进 Go 程序，
// 供桌面版（cmd/csvlens）离线使用。
package csvlens

import "embed"

// Web 包含 index.html、lib/、plugins/（含 _template.js）以及示例数据。
//
//go:embed index.html lib all:plugins samples/environment samples/misc samples/ranging
var Web embed.FS
