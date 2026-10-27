# CSV Lens 插件 API 参考

CSV Lens 是在浏览器中分析一个目录下所有 CSV 的工具。**插件**是一个 JavaScript 文件，调用一次 `CSVViewer.registerPlugin({...})`：
按表头匹配特定种类的 CSV，计算衍生特征（新列）、指标卡片，并绘制子图；还可以对所有匹配文件做批量汇总与跨文件对比。

## 1. 文件结构

```js
(() => {                                   // 包在函数里：辅助变量不会与其他插件在全局重名
const PAIRS = [['dis', 'dis_sm']];         // 辅助常量 / 函数放在这里

CSVViewer.registerPlugin({
  id: 'my-plugin',                         // 必填，唯一；同 id 再次注册会覆盖旧版本
  name: '我的插件',                         // 界面显示名
  version: '0.1.0',
  description: '一句话说明',
  priority: 0,                             // 多个插件匹配同一文件时，大的排前面
  fallback: false,                         // 兜底插件（见第 2 节）
  general: false,                          // 通用插件（见第 2 节）
  collapsed: false,                        // 插件卡片默认是否折叠
  match: { ... },                          // 第 3 节
  params: [ ... ],                         // 第 4 节
  features: [ ... ],                       // 第 5 节
  metrics(t, ctx) { return [ ... ]; },     // 第 6 节
  charts(t, ctx) { return [ ... ]; },      // 第 7 节
  render(el, t, ctx) { },                  // 第 8 节（可选）
  summarize(t, ctx) { return { ... }; },   // 第 9 节（可选）
  aggregate(s, ctx) { return { ... }; },   // 第 9 节（可选）
});
})();
```

除 `id` 外所有字段都可选。钩子都是同步函数。

## 2. 插件类型

| 类型 | 写法 | 行为 |
|---|---|---|
| 专用插件 | 默认 | 匹配时显示；同时会让「兜底插件」让位 |
| 通用插件 | `general: true` | 匹配时总是显示，可与专用插件同时出现，不影响兜底插件 |
| 兜底插件 | `fallback: true` | 只在没有任何专用插件匹配该文件时显示 |

针对某类 CSV 的分析写成专用插件；对任意 CSV 都适用的分析（统计、概览）写成通用插件。

## 3. match：哪些 CSV 适用

只读表头即可判断，速度很快。**列名不区分大小写**。

```js
match: {
  columns: ['ts', ['dis', 'distance']],   // 必须全部存在；内层数组 = 任一别名即可
  anyColumns: ['rssi_init', 'rssi_refl'], // 至少存在一个
  numericColumns: ['rssi_init'],          // 必须是数值列
  path: 'logs/**/*.csv',                  // 路径通配（** 任意层目录，* 任意字符）；不含 / 时只匹配文件名；也可以是正则
  minColumns: 3,                          // 至少有几列
  test: (info) => true,                   // 额外条件
}
// 或写成函数：
match: (info) => info.has('ts') && info.isNumeric('dis'),
```

`info`：`name`、`path`（相对根目录）、`dir`、`size`、`columns`（列名数组）、`numericColumns`（数值列名数组）、
`has(...names)`、`find(nameOrAliases)` → 实际列名或 null、`type(name)`、`isNumeric(name)`。
`info` 的列类型由前 200 行推断。

匹配规则建议：只把**必需**的列写进 `columns`；可选的列不要写进去，在钩子里用 `t.has()` 判断，缺失时跳过对应的特征 / 指标 / 图。

## 4. params：可调参数

显示在插件卡片顶部，修改后自动重算；在钩子里通过 `ctx.params.key` 读取。参数对所有文件共用，保存在本地。

```js
params: [
  { key: 'window', label: '平滑窗口', type: 'number', default: 10, min: 1, max: 500, step: 1 },
  { key: 'mode', label: '模式', type: 'select', default: 'a', options: [{ value: 'a', label: '模式 A' }, 'b'] },
  { key: 'abs', label: '取绝对值', type: 'checkbox', default: false },
  { key: 'col', label: '列名', type: 'text', default: 'dis' },
]
```

`type`：`number` | `select` | `checkbox` | `text`。`select` 的值是**字符串**。可加 `description`（悬停提示）。

## 5. features：衍生特征（新列）

```js
features: [
  {
    name: 'dis_resid',              // 新列名；不能与文件原有列重名（不区分大小写）
    label: '平滑残差',               // 可选，显示用
    unit: 'm',                      // 可选
    description: 'dis − dis_sm',    // 可选
    requires: ['dis', 'dis_sm'],    // 可选：缺少其中任一列时跳过该特征（不报错）；元素也可以是别名数组
    compute: (t, ctx) => t.map(['dis', 'dis_sm'], (a, b) => a - b),
  },
]
```

- `compute` 返回**与行数等长**的数组（数值数组会转成 `Float64Array`，缺失写 `NaN`）；返回 `null` / `undefined` 表示跳过。
- 所有匹配插件的特征按插件优先级依次计算，**后面的特征可以使用前面算出的列**。
- 新列会出现在列统计、数据表、自由绘图、导出 CSV 中，并能被图表引用。

## 6. metrics：指标卡片

```js
metrics(t, { utils: u }) {
  return [
    { label: '样本数', value: t.rowCount },
    { label: '均值', value: u.mean(t.col('dis')), unit: 'm', digits: 2, hint: '鼠标悬停说明' },
    t.has('rssi') && { label: 'RSSI 均值', value: u.mean(t.col('rssi')), digits: 1 },   // false 会被忽略
  ];
}
```

`value` 为数字或字符串；`NaN` / `null` 显示为「—」。`digits` 固定小数位数。

## 7. charts：子图

返回图表描述（spec）数组；`false` / `null` 等假值会被忽略，适合「列存在才画」。

```js
charts(t) {
  return [
    { title: 'dis & dis_sm vs ts', type: 'line', x: 'ts', y: ['dis', 'dis_sm'] },   // 一张图两条线
    t.has('rssi') && { title: 'rssi vs ts', type: 'line', x: 'ts', y: 'rssi' },
    { title: 'rssi vs dis', type: 'scatter', x: 'dis', y: 'rssi' },
    { title: '残差分布', type: 'histogram', y: 'dis_resid', bins: 40 },
  ];
}
```

| 字段 | 说明 |
|---|---|
| `type` | `line`（默认）· `area` · `step` · `scatter` · `bar` · `histogram` · `heatmap` |
| `x` | 列名或数组；省略时用行号。数值列名像时间（ts / time / timestamp / date…）且值是 2000–2100 年的 Unix 时间戳（秒 / 毫秒 / 微秒 / 纳秒自动识别）时，自动用时间轴；日期字符串列也是时间轴；文本列为类别轴 |
| `y` | 列名；或**列名数组**（同一张图多条线，共用一个纵轴）；或一个数值数组（一条线） |
| `series` | 精细控制：`[{ name, x, y, type, color }]`，可让每条线有不同的 `x` |
| `title` / `subtitle` | 标题 / 副标题 |
| `height` | 高度（px）；默认整行图 240，半宽图 280 |
| `span` | `1` 半宽 / `2` 整行；`line`/`area`/`step` 默认整行，其余默认半宽 |
| `xType` | `auto`（默认）· `time` · `value` · `category` |
| `xLabel` | x 轴标题（默认为列名） |
| `yZero` / `yMin` / `yMax` | 纵轴从 0 开始 / 纵轴范围 |
| `markLines` | 参考线：`[{ y: 0, label: '零线' }]` 或 `[{ x: 值 }]` |
| `horizontal` / `labels` | 柱状图：横向条形 / 在条形末端显示数值 |
| `bins` / `range` | 直方图：分箱数（默认 30）/ 统计范围 `[lo, hi]` |
| `xCategories` `yCategories` `data` `min` `max` `diverging` `labels` | 热力图：`data` 为 `[[xi, yi, v], ...]`（xi、yi 是类别下标）；`diverging: true` 用蓝-灰-红发散色 |
| `group` | 联动分组名；`false` 关闭联动。默认：同一插件卡片中 `x` 为同一列名的图自动联动缩放与悬停 |
| `option` | 与生成的 ECharts option 深度合并（数组中的对象按下标合并），如 `{ series: [{ smooth: true }] }` |
| `echarts` | 直接给完整的 ECharts option，或 `(theme, t) => option` |

规则与建议：
- **一张图只有一个纵轴**。量纲不同的列（如距离和 RSSI）放在不同的图里，不要合在一张。
- 一张图建议不超过 4 条序列；y 为非有限数的行会被跳过；折线会按 x 自动排序。
- 图例在 2 条及以上序列时自动显示；颜色自动分配，一般不需要指定 `color`。
- 引用不存在的列会让这张图显示错误：可选列一定要先 `t.has()` 判断。

## 8. render：自定义渲染（可选）

```js
render(el, t, ctx) {
  el.append(ctx.h('p', { class: 'muted' }, `共 ${t.rowCount} 行`));
  const box = ctx.h('div', { style: { height: '260px' } });
  el.append(box);
  ctx.renderChart(box, { type: 'scatter', x: 'a', y: 'b' });   // spec 同第 7 节；容器需要明确高度
}
```

`ctx.h(tag, props, ...children)` 创建元素：字符串子节点按文本插入；`props` 支持 `class`、`style`（对象或字符串）、`onclick` 等事件。
来自 CSV 的文字不要用 `innerHTML` 拼接。

## 9. 批量分析：summarize / aggregate（可选）

在「目录概览」页对所有匹配文件逐个运行 `summarize`，每个文件得到一行，组成可排序、可导出的汇总表。

```js
summarize(t, { utils: u }) {
  return {
    samples: t.rowCount,
    dis_mean: u.mean(t.col('dis')),
    rssi_mean: t.has('rssi') ? u.mean(t.col('rssi')) : undefined,   // undefined = 该文件没有这一项（表中显示「—」）
  };
},
aggregate(s, { utils: u }) {        // s：汇总表（DataTable），每行一个文件；额外有 file（简短文件名）和 path 两列
  return {
    metrics: [{ label: '文件数', value: s.rowCount }],
    charts: [
      { title: '各文件 dis 均值', type: 'bar', horizontal: true, x: 'file', y: 'dis_mean', labels: true },
      s.has('rssi_mean') && { title: 'dis 均值 vs rssi 均值', type: 'scatter', x: 'dis_mean', y: 'rssi_mean' },
    ],
  };
},
```

`summarize` 返回由数字 / 字符串组成的扁平对象。

## 10. 数据表 `t`（DataTable）

| 成员 | 说明 |
|---|---|
| `t.rowCount` | 行数 |
| `t.name` / `t.path` | 文件名 / 相对路径 |
| `t.columns` | 全部列名（含已算出的衍生特征） |
| `t.numericColumns` | 数值列名（`type` 为 `number`，含数值衍生特征） |
| `t.col(name)` | 列的值：数值列为 `Float64Array`（缺失为 `NaN`）；日期列为毫秒时间戳的 `Float64Array`；文本列为字符串数组（缺失为 `''`）。`name` 不区分大小写，也可以是别名数组；列不存在返回 `undefined` |
| `t.has(...names)` | 这些列是否都存在 |
| `t.find(nameOrAliases)` | 实际列名（大小写与文件一致）或 `null` |
| `t.type(name)` | `'number'` · `'datetime'` · `'string'` · `'empty'` 或 `null` |
| `t.isNumeric(name)` | 是否数值列 |
| `t.getColumn(name)` | 列对象 `{ name, type, values, derived, source, label, unit, description, missing }` |
| `t.map(['a', 'b'], (a, b, i) => …)` | 逐行计算，返回 `Float64Array`；任一列不存在会抛错 |
| `t.stats(name)` | 数值 / 日期列：`{ count, missing, min, max, mean, std, hist }`；文本列：`{ count, missing, distinct, top }` |
| `t.row(i)` | 第 i 行对象 |

类型推断：≥95% 的非空值能解析为数字的列是数值列；日期字符串（`2026-10-01 08:00:00` 等）是 `datetime`；其余为文本。
空串、`NA`、`NaN`、`null`、`-` 等视为缺失。

## 11. 上下文 `ctx` 与 `ctx.utils`

`ctx`：`params`（当前参数值）· `utils` · `file`（`{ name, path, dir, size }`，aggregate 中为 `null`）· `plugin`（`{ id, name, version }`）·
`fmt`（数字格式化）· `h` · `renderChart` · `theme`（当前配色）· `echarts`（ECharts 库）。

`ctx.utils`（也可用 `CSVViewer.utils`）——统计函数都会**忽略 NaN**：

| 函数 | 说明 |
|---|---|
| `count sum mean variance std min max rms` | 基本统计（无有效值时返回 `NaN`，`count`/`sum` 返回 0） |
| `extent(a)` · `median(a)` · `quantile(a, q)` | `[min, max]` · 中位数 · 分位数（q ∈ [0, 1]） |
| `diff(a)` · `cumsum(a)` | 相邻差（首项 NaN）· 累加 |
| `movingAverage(a, w, center)` · `ema(a, alpha)` · `zscore(a)` | 滑动平均（`center=true` 居中）· 指数平滑 · 标准化 |
| `histogram(a, bins, range)` | `{ edges, counts, centers, binWidth }` |
| `corr(a, b)` · `linreg(x, y)` | 相关系数 · 线性回归 `{ slope, intercept, r2, n }` |
| `timeColumn(t)` | 找时间列：优先 ts / timestamp / time / datetime / date / t，其次日期列 |
| `duration(values, unit)` | 时长 `{ seconds, span, text }`；`unit` 为 `'auto'`（识别时间戳）· `'s'` · `'ms'` · `'us'` · `'ns'`；无法确定单位时 `seconds` 为 `null` |
| `epochScale(values)` | 若是 Unix 时间戳，返回换算到毫秒的倍数，否则 `null` |
| `isTimeName(name)` · `isNum(v)` · `finite(a)` · `map(n, fn)` | 工具 |
| `fmt(v, digits)` · `fmtDuration(ms)` · `fmtDate(ms)` · `fmtBytes(n)` | 格式化 |

## 12. 编写约定与常见错误

1. 整个文件包在 `(() => { ... })();` 中；只调用 `CSVViewer.registerPlugin`，不要访问页面的其他全局变量。
2. `id` 用小写字母、数字和连字符；界面文字（name、label、title）用中文。
3. 不使用外部库、网络请求、`localStorage`；代码在浏览器主线程同步运行，避免对每行做大量对象分配。
4. 可选的列：`features` 用 `requires`，`metrics` / `charts` 用 `t.has(...) && {...}`，`summarize` 用 `undefined`。
5. `y: ['a', 'b']` 表示**两条线**；想用别名时先 `const c = t.find(['dis_sm', 'dissm'])` 再把 `c` 放进 spec。
6. 时间列通常不需要转换：`x: 'ts'` 会自动识别时间戳；只有需要「相对时间（秒）」时才自己算一个特征。
7. 特征名不要与原始列重名；不要直接调用 `t.addColumn`，用 `features`。
8. 数值比较前用 `Number.isFinite(v)` 排除缺失值。

## 13. 插件放在哪里

- 网页版：放进 `plugins/`，并在 `plugins/index.js` 的列表中加一行文件名。
- 桌面版（CSVLens.exe）：放进 exe 同目录的 `plugins` 文件夹，自动加载。
- 任意版本：页面右上角「插件」→「新建插件」，粘贴代码后保存（保存在本机）；或「导入 .js」。
- 数据目录中的 `*.plugin.js` 会被发现，点「加载」后启用。
