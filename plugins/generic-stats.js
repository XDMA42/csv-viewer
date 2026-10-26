/**
 * 通用统计（兜底插件）—— 任意含 ≥ 2 个数值列的 CSV：
 * 相关系数矩阵、各数值列分布直方图、缺失值概况。
 */
CSVViewer.registerPlugin({
  id: 'generic-stats',
  name: '通用统计',
  version: '1.0.0',
  description: '兜底插件：数值列的相关系数矩阵、分布直方图与缺失值概况。',
  fallback: true,
  priority: -10,

  match: (info) => info.numericColumns.length >= 2,

  params: [
    { key: 'maxCols', label: '相关矩阵最多列数', type: 'number', default: 12, min: 2, max: 30, step: 1 },
    { key: 'hist', label: '直方图个数', type: 'number', default: 6, min: 0, max: 24, step: 1 },
  ],

  metrics(t) {
    let missing = 0;
    for (const name of t.columns) missing += t.stats(name).missing;
    const cells = t.rowCount * t.columns.length;
    return [
      { label: '行数', value: t.rowCount },
      { label: '数值列', value: t.numericColumns.length },
      { label: '其他列', value: t.columns.length - t.numericColumns.length },
      { label: '缺失单元格', value: cells ? (missing / cells) * 100 : 0, unit: '%', digits: 2 },
    ];
  },

  charts(t, { utils: u, params }) {
    const cols = t.numericColumns.filter((c) => !t.getColumn(c).derived).slice(0, params.maxCols);
    const data = [];
    for (let i = 0; i < cols.length; i++) {
      for (let j = 0; j < cols.length; j++) {
        data.push([i, j, i === j ? 1 : u.corr(t.col(cols[i]), t.col(cols[j]))]);
      }
    }
    return [
      {
        title: '相关系数矩阵', subtitle: 'Pearson，蓝 = 负相关，红 = 正相关',
        type: 'heatmap', xCategories: cols, yCategories: cols, data,
        min: -1, max: 1, diverging: true, span: 2,
        height: Math.min(640, Math.max(300, 34 * cols.length + 110)),
      },
      ...cols.slice(0, params.hist).map((c) => ({ title: `${c} 分布`, type: 'histogram', y: c, bins: 30, height: 220 })),
    ];
  },

  summarize(t) {
    let missing = 0;
    for (const name of t.columns) missing += t.stats(name).missing;
    return {
      rows: t.rowCount,
      columns: t.columns.length,
      numeric_columns: t.numericColumns.length,
      missing_pct: t.rowCount ? (missing / (t.rowCount * t.columns.length)) * 100 : 0,
    };
  },
});
