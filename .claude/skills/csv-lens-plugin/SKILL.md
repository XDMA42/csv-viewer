---
name: csv-lens-plugin
description: Create, modify or debug a CSV Lens plugin — a JavaScript file that calls CSVViewer.registerPlugin to match certain CSV files and add derived columns, metric tiles, charts and batch summaries. Use when the user asks for a CSV Lens / CSVViewer plugin, wants new charts or features for a kind of CSV in CSV Lens, or mentions 插件 for this CSV viewer (e.g. 「写一个插件画 xx vs ts」「给测距分析加一张图」).
---

# CSV Lens 插件编写

产出：一个可以直接使用的插件文件（`<id>.js`），并用检查器在真实 CSV 上验证通过。

## 需要读的文件

- `reference.md`：完整的插件 API（字段、图表 spec、`t` / `ctx.utils`、约定与常见错误）。**写代码前通读一遍。**
- 示例插件：`examples/` 目录；在 CSV Lens 仓库中则是 `plugins/`
  - `ranging.js`：专用插件，列不全时按列取舍、衍生特征、参数、批量汇总与跨文件图（最完整的参考）
  - `timeseries.js`：兜底插件，函数式 `match`
  - `generic-stats.js`：通用插件，热力图与直方图
  - `_template.js`：所有字段的注释模板

## 步骤

1. **弄清数据。** 有 CSV 文件就读表头和前几行（`head -n 6 file.csv`），确认列名、分隔符、哪一列是时间、数值大致范围；
   没有文件就请用户给出列名和几行示例。注意文件可能是 GBK 编码、分号分隔或列名大小写不一——CSV Lens 都能处理，插件里按小写列名写即可。
2. **弄清需求。** 要画哪些图（哪些列 vs 哪一列）、要算哪些新列 / 指标、是否需要批量汇总；
   哪些列是必需的、哪些可能缺失（缺失时跳过对应的图，还是整个文件不匹配）。需求含糊时先问清楚，不要猜。
3. **选类型和匹配规则。** 针对某类 CSV → 专用插件；适用于任意 CSV 的统计 → `general: true`；
   必需列写进 `match.columns`，可选列用 `anyColumns` 或在钩子里 `t.has()` 判断。
4. **写插件。** 严格按 `reference.md`：整个文件包在 `(() => { ... })();` 中；可选列用 `requires` / `t.has() && {...}`；
   量纲不同的列放在不同的图里；界面文字用中文；`id` 用小写加连字符且不与内置插件（`ranging`、`timeseries`、`generic-stats`）重名，除非用户就是要覆盖它。
5. **检查。** 用检查器在真实 CSV 上运行（见下节），修到没有 ✗ 为止，并逐条看 ⚠ 是否合理。
   没有 CSV 时也要运行一次（只做语法和结构检查），并告诉用户检查范围有限。
6. **交付。** 给出完整代码文件，说明：匹配哪些文件、画了哪些图、新增了哪些列，以及放在哪里（`reference.md` 第 13 节）：
   网页版放 `plugins/` 并登记到 `plugins/index.js`；桌面版放 exe 旁的 `plugins` 文件夹；或在页面「插件 → 新建插件」中粘贴。
   在 CSV Lens 仓库里工作时，直接写到 `plugins/<id>.js` 并在 `plugins/index.js` 中加一行。

## 检查器

```sh
node scripts/check_plugin.cjs <plugin.js> [data.csv ...] [--params '{"key":1}'] [--force]
```

- 用 CSV Lens 的核心代码（`core.js`，与页面完全相同）解析 CSV、运行 `match` → `features` → `metrics` → `charts` → `summarize`，
  多个 CSV 时再运行 `aggregate`；每张图都会转换成 ECharts option，能发现列名写错、y 不是数值列、特征长度不对、顶层变量冲突等问题。
- 退出码 0 表示没有错误（✗）；⚠ 是需要人工判断的提示（比如某张图没有数据点）。
- 文件不匹配时只报告缺少哪些列；加 `--force` 可无视匹配继续运行各钩子。
- 需要 Node.js 16+。在 CSV Lens 仓库中运行时自动使用 `lib/core.js`；单独使用本 skill 时使用 `scripts/core.js`。
- `render()` 依赖浏览器 DOM，检查器只做最简单的调用；用到 `render` 时提醒用户在页面中确认显示效果。
