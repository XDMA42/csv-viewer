// CSV Lens 桌面版：把网页版打包成一个可双击运行的 Windows 程序。
//
// 程序在 127.0.0.1 上启动一个只服务本机的 HTTP 服务（内置页面、插件、示例数据），
// 并在 WebView2 窗口中打开它；没有 WebView2 运行时则改用默认浏览器。
// exe 同目录下 plugins 文件夹中的 .js 插件会被自动加载。
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	csvlens "github.com/XDMA42/csv-viewer"
)

const (
	appName = "CSV Lens"
	// 固定端口，使页面的 localStorage（本地插件、设置）在多次启动之间保持一致
	defaultPort = 47821
	// 浏览器模式下，页面关闭超过这个时间后程序自动退出
	idleTimeout = 3 * time.Minute
)

var version = "1.0.0"

func main() {
	browser := flag.Bool("browser", false, "在默认浏览器中打开，而不是独立窗口")
	serveOnly := flag.Bool("serve", false, "只启动本地服务并打印地址（开发调试用）")
	debug := flag.Bool("debug", false, "启用右键菜单和开发者工具（F12），便于调试插件")
	port := flag.Int("port", defaultPort, "本地服务端口；被占用时自动改用随机端口")
	flag.Parse()

	// Windows 会用注册表里的 MIME 类型覆盖 Go 的默认值（.js 可能变成 text/plain），这里显式指定
	for ext, typ := range map[string]string{
		".html": "text/html; charset=utf-8",
		".js":   "text/javascript; charset=utf-8",
		".css":  "text/css; charset=utf-8",
		".json": "application/json",
		".csv":  "text/csv; charset=utf-8",
		".tsv":  "text/tab-separated-values; charset=utf-8",
		".txt":  "text/plain; charset=utf-8",
		".png":  "image/png",
		".svg":  "image/svg+xml",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}

	ln, err := listen(*port)
	if err != nil {
		fatal("无法启动本地服务：" + err.Error())
	}
	p := ln.Addr().(*net.TCPAddr).Port
	url := fmt.Sprintf("http://127.0.0.1:%d/", p)

	srv := &server{
		port:      p,
		pluginDir: filepath.Join(exeDir(), "plugins"),
		static:    http.FileServer(http.FS(csvlens.Web)),
	}
	srv.mode.Store("window")
	httpSrv := &http.Server{Handler: srv, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = httpSrv.Serve(ln) }()

	switch {
	case *serveOnly:
		srv.mode.Store("serve")
		fmt.Println(appName, "running at", url)
		select {}
	case !*browser && openWindow(url, *debug):
		// 窗口已关闭
	default:
		srv.mode.Store("browser")
		if err := openBrowser(url); err != nil {
			fatal("无法打开浏览器：" + err.Error() + "\n请手动访问 " + url)
		}
		srv.waitIdle()
	}
}

func listen(port int) (net.Listener, error) {
	if port > 0 {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			return ln, nil
		}
	}
	return net.Listen("tcp", "127.0.0.1:0")
}

type server struct {
	port      int
	pluginDir string
	static    http.Handler
	mode      atomic.Value // "window" | "browser" | "serve"
	lastPing  atomic.Int64
}

func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// 只响应以本机地址访问的请求，防止其他网页通过 DNS rebinding 访问本地服务
	if r.Host != fmt.Sprintf("127.0.0.1:%d", s.port) && r.Host != fmt.Sprintf("localhost:%d", s.port) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")

	p := r.URL.Path
	if p == "/api/open-plugin-dir" {
		// 有副作用的接口要求 POST + 自定义请求头：跨域网页无法在不经预检的情况下发出这种请求
		if r.Method != http.MethodPost || r.Header.Get("X-CSV-Lens") != "1" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if err := s.openPluginDir(); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, map[string]any{"ok": true, "dir": s.pluginDir})
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	switch {
	case p == "/api/ping":
		s.lastPing.Store(time.Now().UnixNano())
		writeJSON(w, map[string]any{"app": "csv-lens", "version": version, "mode": s.mode.Load(), "pluginDir": s.pluginDir})
	case p == "/api/plugins":
		writeJSON(w, s.listPlugins())
	case p == "/api/samples":
		writeJSON(w, listSamples())
	case strings.HasPrefix(p, "/ext/plugins/"):
		s.servePlugin(w, r, strings.TrimPrefix(p, "/ext/plugins/"))
	default:
		s.static.ServeHTTP(w, r)
	}
}

// isPluginFile：plugins 文件夹中会被自动加载的文件（以 _ 开头的文件不加载，可放模板、草稿）
func isPluginFile(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasSuffix(lower, ".js") && !strings.HasPrefix(name, "_") && !strings.HasPrefix(name, ".") && lower != "index.js"
}

func (s *server) listPlugins() []string {
	names := []string{}
	entries, err := os.ReadDir(s.pluginDir)
	if err != nil {
		return names
	}
	for _, e := range entries {
		if e.Type().IsRegular() && isPluginFile(e.Name()) {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	return names
}

func (s *server) servePlugin(w http.ResponseWriter, r *http.Request, name string) {
	if name == "" || name != path.Base(name) || strings.ContainsAny(name, `/\:`) || !isPluginFile(name) {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(filepath.Join(s.pluginDir, name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	http.ServeContent(w, r, name, st.ModTime(), f)
}

const pluginReadme = `CSV Lens 插件文件夹
====================

把插件文件（.js）放在这个文件夹里，CSV Lens 启动时会自动加载；
修改后在「插件」面板点「重新加载插件文件夹」即可生效，无需重启。

- 以 _ 开头的文件不会被加载，可以用来存放模板和草稿。
- _template.js 是带完整注释的插件模板，复制一份、改名（去掉开头的 _）即可开始编写。
- _builtin 文件夹里是内置插件的源码副本，仅供参考。想修改内置插件时，
  把它复制到本文件夹再修改即可：同一个 id 的插件会覆盖内置版本。
`

// openPluginDir 创建（如不存在）并在资源管理器中打开插件文件夹
func (s *server) openPluginDir() error {
	if _, err := os.Stat(s.pluginDir); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Join(s.pluginDir, "_builtin"), 0o755); err != nil {
			return err
		}
		copyEmbedded("plugins/_template.js", filepath.Join(s.pluginDir, "_template.js"))
		entries, _ := fs.ReadDir(csvlens.Web, "plugins")
		for _, e := range entries {
			if n := e.Name(); isPluginFile(n) {
				copyEmbedded("plugins/"+n, filepath.Join(s.pluginDir, "_builtin", n))
			}
		}
		readme := "\xef\xbb\xbf" + strings.ReplaceAll(pluginReadme, "\n", "\r\n")
		_ = os.WriteFile(filepath.Join(s.pluginDir, "插件说明.txt"), []byte(readme), 0o644)
	}
	return openPath(s.pluginDir)
}

func copyEmbedded(src, dst string) {
	if b, err := fs.ReadFile(csvlens.Web, src); err == nil {
		_ = os.WriteFile(dst, b, 0o644)
	}
}

func listSamples() []map[string]any {
	out := []map[string]any{}
	_ = fs.WalkDir(csvlens.Web, "samples", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			out = append(out, map[string]any{"path": strings.TrimPrefix(p, "samples/"), "size": info.Size()})
		}
		return nil
	})
	return out
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

// waitIdle 在浏览器模式下阻塞，直到页面停止心跳（被关闭）
func (s *server) waitIdle() {
	start := time.Now()
	for {
		time.Sleep(10 * time.Second)
		last := start
		if t := s.lastPing.Load(); t != 0 {
			last = time.Unix(0, t)
		}
		if time.Since(last) > idleTimeout {
			return
		}
	}
}

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		return "."
	}
	if real, err := filepath.EvalSymlinks(exe); err == nil {
		exe = real
	}
	return filepath.Dir(exe)
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}

func openPath(dir string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("explorer", dir).Start()
	case "darwin":
		return exec.Command("open", dir).Start()
	default:
		return exec.Command("xdg-open", dir).Start()
	}
}
