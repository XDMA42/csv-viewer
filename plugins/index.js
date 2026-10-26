/**
 * 插件清单：页面启动时自动加载这里列出的插件（路径相对于本文件）。
 *
 * 新增插件：把 xxx.js 放进 plugins/ 目录，在下面的数组里加一行，刷新页面即可。
 * 也可以不改文件：在页面「插件」面板中导入 .js 或在线编写（保存在浏览器本地）。
 * 参考模板：plugins/_template.js
 */
CSVViewer.loadScripts([
  'ranging.js',
  'timeseries.js',
  'generic-stats.js',
]);
