/**
 * CSV Lens 插件模板（不会自动加载；复制一份改名后登记到 plugins/index.js）
 *
 * 一个插件 = 一次 CSVViewer.registerPlugin({...}) 调用。除 id 外所有字段都是可选的。
 * 各钩子的参数：
 *   t    —— 当前 CSV 的数据表（DataTable），常用：
 *             t.rowCount              行数
 *             t.columns               列名数组（含已计算的衍生特征）
 *             t.numericColumns        数值列名数组
 *             t.col('dis')            取一列的值（数值列为 Float64Array，缺失为 NaN；列名不区分大小写）
 *             t.has('a', 'b')         是否同时存在这些列
 *             t.find(['dis', 'distance'])  按别名找到实际列名
 *             t.type('ts')            'number' | 'datetime' | 'string' | 'empty'（datetime 已转成毫秒时间戳）
 *             t.map(['a', 'b'], (a, b, i) => a - b)   逐行计算，返回 Float64Array
 *             t.stats('rssi')         { count, missing, min, max, mean, std, ... }
 *             t.row(i)                第 i 行对象
 *   ctx  —— 上下文：
 *             ctx.params              当前参数值（见 params）
 *             ctx.utils               统计/工具函数：mean std min max sum count rms median quantile
 *                                     diff cumsum movingAverage ema zscore histogram corr linreg
 *                                     duration timeColumn epochScale fmt fmtDuration ...
 *             ctx.file                { name, path, dir, size }（aggregate 中为 null）
 *             ctx.theme               当前主题色（series 调色板、文字色等）
 *             ctx.h(tag, props, ...children)   创建 DOM 的小工具（render 中使用）
 *             ctx.renderChart(el, spec)        在自定义 DOM 中画一张图（spec 同 charts）
 *             ctx.echarts             ECharts 库本身
 */
CSVViewer.registerPlugin({
  id: 'my-plugin',                // 唯一 ID；同 ID 再次注册会覆盖旧版本（方便热更新）
  name: '我的插件',
  version: '0.1.0',
  description: '一句话说明插件做什么。',
  priority: 0,                    // 多个插件匹配同一文件时，数值大的排在前面
  fallback: false,                // true = 兜底插件：只在没有其他非兜底插件匹配时启用
  collapsed: false,               // 插件卡片默认是否折叠

  /* ---------- 匹配：决定哪些 CSV 适用此插件（只读表头，速度很快） ---------- */
  match: {
    columns: ['ts', ['value', 'val']], // 必须都存在；内层数组表示「任一别名即可」
    // anyColumns: ['a', 'b'],         // 至少存在其一
    // path: 'logs/**/*.csv',          // 路径通配（不含 / 时只匹配文件名），也可以是正则
    // test: (info) => info.numericColumns.length > 3,
  },
  // 也可以直接写成函数：match: (info) => info.has('ts') && info.isNumeric('value'),
  // info 提供：name path dir size columns numericColumns has() find() type() isNumeric()

  /* ---------- 参数：显示在插件卡片上，修改后自动重算 ---------- */
  params: [
    { key: 'window', label: '平滑窗口', type: 'number', default: 10, min: 1, step: 1 },
    { key: 'mode', label: '模式', type: 'select', default: 'a', options: [{ value: 'a', label: '模式 A' }, 'b'] },
    { key: 'abs', label: '取绝对值', type: 'checkbox', default: false },
  ],

  /* ---------- 衍生特征：返回与行数等长的数组，作为新列加入表格 ---------- */
  // 按插件优先级依次计算，后面的特征可以使用前面的特征；
  // 新列会出现在列统计、数据表、自由绘图、导出 CSV 中。
  features: [
    {
      name: 'value_ma',
      label: '滑动平均',
      description: 'value 的滑动平均',
      compute: (t, { utils, params }) => utils.movingAverage(t.col(t.find(['value', 'val'])), params.window),
    },
  ],

  /* ---------- 指标卡片 ---------- */
  metrics: (t, { utils: u }) => [
    { label: '行数', value: t.rowCount },
    { label: '均值', value: u.mean(t.col('value_ma')), digits: 3, unit: '', hint: '鼠标悬停提示' },
  ],

  /* ---------- 子图：每个对象是一张图 ---------- */
  // type: 'line' | 'area' | 'step' | 'scatter' | 'bar' | 'histogram' | 'heatmap'
  // x / y: 列名（或数组）；y 可以是多个列名 → 一张图多条线
  // 其他：title subtitle height span(1|2) xType('auto'|'time'|'value'|'category')
  //       xLabel yZero markLines:[{y:0}] horizontal labels bins series:[{name,x,y,type,color}]
  //       option（与生成的 ECharts option 深度合并） echarts（直接给完整 ECharts option）
  // 同一插件内 x 相同的图会自动联动（缩放、悬停）；group:false 可关闭。
  charts: (t) => [
    { title: 'value vs ts', type: 'line', x: 'ts', y: [t.find(['value', 'val']), 'value_ma'] },
    { title: 'value 分布', type: 'histogram', y: 'value_ma', bins: 40 },
  ],

  /* ---------- 自定义渲染（可选）：完全自由的 DOM ---------- */
  render(el, t, ctx) {
    el.append(ctx.h('p', { class: 'muted' }, `这个文件有 ${t.rowCount} 行。`));
    // const box = ctx.h('div', { style: { height: '240px' } }); el.append(box);
    // ctx.renderChart(box, { type: 'scatter', x: 'a', y: 'b' });
  },

  /* ---------- 批量分析（可选）：在目录概览页对所有匹配文件运行 ---------- */
  // 每个文件返回一行（对象），结果表可排序、导出 CSV
  summarize: (t, { utils: u }) => ({
    rows: t.rowCount,
    value_mean: u.mean(t.col('value_ma')),
  }),
  // 跨文件汇总：s 是由所有 summarize 行组成的表（额外有 file / path 两列）
  aggregate: (s) => ({
    charts: [{ title: '各文件均值', type: 'bar', horizontal: true, x: 'file', y: 'value_mean', labels: true }],
  }),
});
