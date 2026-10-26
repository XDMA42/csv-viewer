/**
 * 时间序列（兜底插件）—— 自动识别时间列（ts / time / timestamp / 日期字符串……），
 * 把每个数值列画成随时间变化的曲线。所有子图共用时间轴并联动。
 *
 * fallback: true 表示「兜底」：只有当没有其他专用插件匹配某个文件时才启用，
 * 因此测距日志会由「测距分析」插件处理，而不会重复出现这里的图。
 */
CSVViewer.registerPlugin({
  id: 'timeseries',
  name: '时间序列',
  version: '1.0.0',
  description: '兜底插件：识别时间列，把每个数值列绘制成随时间变化的曲线（子图联动）。',
  fallback: true,
  priority: -5,

  match(info) {
    const tc = CSVViewer.utils.timeColumn(info);
    return !!tc && info.numericColumns.some((c) => c !== tc);
  },

  params: [
    { key: 'max', label: '最多子图', type: 'number', default: 8, min: 1, max: 30, step: 1 },
    {
      key: 'kind', label: '图形', type: 'select', default: 'line',
      options: [
        { value: 'line', label: '折线' },
        { value: 'area', label: '面积' },
        { value: 'step', label: '阶梯' },
        { value: 'scatter', label: '散点' },
      ],
    },
  ],

  metrics(t, { utils: u }) {
    const tc = u.timeColumn(t);
    const dur = u.duration(t.col(tc));
    return [
      { label: '时间列', value: tc },
      { label: '行数', value: t.rowCount },
      { label: '时长', value: dur.text },
      { label: '数值列', value: t.numericColumns.filter((c) => c !== tc).length },
    ];
  },

  charts(t, { utils: u, params }) {
    const tc = u.timeColumn(t);
    return t.numericColumns
      .filter((c) => c !== tc)
      .slice(0, params.max)
      .map((c) => ({ title: `${c} vs ${tc}`, type: params.kind, x: tc, y: c, height: 220 }));
  },

  summarize(t, { utils: u }) {
    const tc = u.timeColumn(t);
    const dur = u.duration(t.col(tc));
    return { time_column: tc, rows: t.rowCount, duration_s: dur.seconds };
  },
});
