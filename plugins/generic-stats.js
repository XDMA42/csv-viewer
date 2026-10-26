/**
 * 通用统计（通用插件）—— 任意含 ≥ 2 个数值列的 CSV：
 * 相关系数矩阵、各数值列分布直方图、缺失值概况。
 *
 * general: true 表示「通用插件」：匹配时总是显示，可以和测距分析等专用插件一起出现，
 * 也不会让「时间序列」这类兜底插件让位。
 * 时间列和严格递增的列（序号、计数器、时间戳）分布均匀、与其他列的相关性没有意义，
 * 因此不参与相关矩阵和直方图。
 */
(() => {
// 严格递增的数值列视为序号 / 时间轴
function isIndexLike(values) {
  let prev = -Infinity, n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v <= prev) return false;
    prev = v;
    n++;
  }
  return n > 2;
}

// 只统计文件本身的列（不含其他插件算出的衍生特征）
function originalColumns(t) {
  const all = t.columns.filter((c) => !t.getColumn(c).derived);
  return { all, numeric: all.filter((c) => t.isNumeric(c)) };
}

// 缺失单元格占比（%）
function missingPct(t, cols) {
  let missing = 0;
  for (const name of cols) missing += t.stats(name).missing;
  const cells = t.rowCount * cols.length;
  return cells ? (missing / cells) * 100 : 0;
}

function statColumns(t, utils, max) {
  const tc = utils.timeColumn(t);
  return originalColumns(t).numeric
    .filter((c) => c !== tc && !isIndexLike(t.col(c)))
    .slice(0, max);
}

CSVViewer.registerPlugin({
  id: 'generic-stats',
  name: '通用统计',
  version: '1.1.0',
  description: '通用插件：数值列的相关系数矩阵、分布直方图与缺失值概况，可与其他插件一起显示。',
  general: true,
  priority: -10,

  match: (info) => info.numericColumns.length >= 2,

  params: [
    { key: 'maxCols', label: '相关矩阵最多列数', type: 'number', default: 12, min: 2, max: 30, step: 1 },
    { key: 'hist', label: '直方图个数', type: 'number', default: 6, min: 0, max: 24, step: 1 },
  ],

  metrics(t) {
    const cols = originalColumns(t);
    return [
      { label: '行数', value: t.rowCount },
      { label: '数值列', value: cols.numeric.length },
      { label: '其他列', value: cols.all.length - cols.numeric.length },
      { label: '缺失单元格', value: missingPct(t, cols.all), unit: '%', digits: 2 },
    ];
  },

  charts(t, { utils: u, params }) {
    const cols = statColumns(t, u, params.maxCols);
    const data = [];
    for (let i = 0; i < cols.length; i++) {
      for (let j = 0; j < cols.length; j++) {
        data.push([i, j, i === j ? 1 : u.corr(t.col(cols[i]), t.col(cols[j]))]);
      }
    }
    return [
      cols.length >= 2 && {
        title: '相关系数矩阵', subtitle: 'Pearson，蓝 = 负相关，红 = 正相关',
        type: 'heatmap', xCategories: cols, yCategories: cols, data,
        min: -1, max: 1, diverging: true, span: 2,
        height: Math.min(640, Math.max(300, 34 * cols.length + 110)),
      },
      ...cols.slice(0, params.hist).map((c) => ({ title: `${c} 分布`, type: 'histogram', y: c, bins: 30, height: 220 })),
    ];
  },

  summarize(t) {
    const cols = originalColumns(t);
    return {
      rows: t.rowCount,
      columns: cols.all.length,
      numeric_columns: cols.numeric.length,
      missing_pct: missingPct(t, cols.all),
    };
  },
});
})();
