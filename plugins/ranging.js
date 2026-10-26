/**
 * 测距分析插件 —— 针对测距日志 CSV（列名不区分大小写）。
 *
 *  匹配：有 ts 列，并且至少有下面任意一列：
 *        dis, dis_sm, dis_main, dis_main_sm, rssi_init, rssi_refl
 *  图表：dis & dis_sm vs ts、dis_main & dis_main_sm vs ts、rssi_init & rssi_refl vs ts
 *        （三张图共用时间轴，缩放/悬停联动），以及平滑残差、rssi vs dis 散点、残差分布。
 *        列不全时：每张图只画存在的列，一组都没有就跳过这张图。
 *  衍生特征：dis_resid = dis − dis_sm、dis_main_resid = dis_main − dis_main_sm、
 *            rssi_diff = rssi_init − rssi_refl、dt = 相邻 ts 之差、is_outlier（|dis_resid| 超过阈值）；
 *            所需的列缺失时自动跳过（见 requires）。
 *  批量：每个文件汇总成一行（样本数、时长、残差 RMS、RSSI 统计……），再做跨文件对比。
 */
// 包在函数里，避免辅助变量与其他插件（或同一插件的另一份副本）在全局重名
(() => {
const PAIRS = [
  ['dis', 'dis_sm'],
  ['dis_main', 'dis_main_sm'],
  ['rssi_init', 'rssi_refl'],
];

CSVViewer.registerPlugin({
  id: 'ranging',
  name: '测距分析',
  version: '1.2.0',
  description: '测距日志：dis / dis_sm、dis_main / dis_main_sm、rssi_init / rssi_refl 随时间变化，列不全时只画已有的列。',
  priority: 10,

  match: { columns: ['ts'], anyColumns: PAIRS.flat() },

  params: [
    { key: 'outlier', label: '离群阈值 |dis − dis_sm| >', type: 'number', default: 0.5, min: 0, step: 0.1 },
    {
      key: 'tsUnit', label: 'ts 单位', type: 'select', default: 'auto',
      options: [
        { value: 'auto', label: '自动（识别时间戳）' },
        { value: 's', label: '秒' },
        { value: 'ms', label: '毫秒' },
        { value: 'us', label: '微秒' },
      ],
    },
  ],

  features: [
    {
      name: 'dis_resid',
      label: 'dis 平滑残差',
      description: 'dis − dis_sm',
      requires: ['dis', 'dis_sm'],
      compute: (t) => t.map(['dis', 'dis_sm'], (a, b) => a - b),
    },
    {
      name: 'dis_main_resid',
      label: 'dis_main 平滑残差',
      description: 'dis_main − dis_main_sm',
      requires: ['dis_main', 'dis_main_sm'],
      compute: (t) => t.map(['dis_main', 'dis_main_sm'], (a, b) => a - b),
    },
    {
      name: 'rssi_diff',
      label: 'RSSI 差',
      description: 'rssi_init − rssi_refl',
      requires: ['rssi_init', 'rssi_refl'],
      compute: (t) => t.map(['rssi_init', 'rssi_refl'], (a, b) => a - b),
    },
    {
      name: 'dt',
      label: '采样间隔',
      description: '相邻两行 ts 之差（ts 原始单位）',
      compute: (t, { utils }) => utils.diff(t.col('ts')),
    },
    {
      name: 'is_outlier',
      label: '离群点',
      description: '|dis_resid| 超过阈值记为 1',
      requires: ['dis_resid'],
      compute: (t, { params }) =>
        t.map(['dis_resid'], (r) => (Number.isFinite(r) ? (Math.abs(r) > params.outlier ? 1 : 0) : NaN)),
    },
  ],

  metrics(t, { utils: u, params }) {
    const has = (c) => t.has(c);
    const dur = u.duration(t.col('ts'), params.tsUnit);
    // 列缺失时对应的卡片返回 false，会被自动忽略
    return [
      { label: '样本数', value: t.rowCount },
      { label: '时长', value: dur.text },
      { label: '平均采样率', value: dur.seconds ? t.rowCount / dur.seconds : null, unit: 'Hz', digits: 1 },
      has('dis') && { label: 'dis 均值', value: u.mean(t.col('dis')) },
      has('dis_main') && { label: 'dis_main 均值', value: u.mean(t.col('dis_main')) },
      has('dis_resid') && { label: 'dis 残差 RMS', value: u.rms(t.col('dis_resid')), hint: 'dis − dis_sm 的均方根' },
      has('dis_main_resid') && { label: 'dis_main 残差 RMS', value: u.rms(t.col('dis_main_resid')), hint: 'dis_main − dis_main_sm 的均方根' },
      has('is_outlier') && { label: '离群点', value: u.sum(t.col('is_outlier')), hint: `|dis − dis_sm| > ${params.outlier}` },
      has('rssi_init') && { label: 'rssi_init 均值', value: u.mean(t.col('rssi_init')), digits: 1 },
      has('rssi_refl') && { label: 'rssi_refl 均值', value: u.mean(t.col('rssi_refl')), digits: 1 },
      has('rssi_diff') && { label: 'RSSI 差均值', value: u.mean(t.col('rssi_diff')), digits: 1, hint: 'rssi_init − rssi_refl' },
    ];
  },

  charts(t) {
    const avail = (cols) => cols.filter((c) => t.has(c));
    // 需求中的三张图：每组画出存在的列，一组都没有就跳过；x 都是 ts，会自动联动
    const pairCharts = PAIRS.map(avail)
      .filter((ys) => ys.length)
      .map((ys) => ({ title: `${ys.join(' & ')} vs ts`, type: 'line', x: 'ts', y: ys }));
    const resid = avail(['dis_resid', 'dis_main_resid']);
    const rssi = avail(['rssi_init', 'rssi_refl']);
    return [
      ...pairCharts,
      // 额外的分析图（同样只在有数据时出现）
      resid.length && { title: '平滑残差 vs ts', type: 'line', x: 'ts', y: resid, markLines: [{ y: 0 }], height: 200 },
      t.has('dis') && rssi.length && {
        title: 'rssi vs dis', subtitle: '每个点是一条记录', type: 'scatter',
        series: rssi.map((c) => ({ name: c, x: 'dis', y: c })),
      },
      resid.length && { title: '平滑残差分布', type: 'histogram', y: resid, bins: 40 },
    ];
  },

  // 批量分析：每个文件 → 一行；值为 undefined 的键表示该文件没有这一项
  summarize(t, { utils: u, params }) {
    const mean = (c) => (t.has(c) ? u.mean(t.col(c)) : undefined);
    const rms = (c) => (t.has(c) ? u.rms(t.col(c)) : undefined);
    return {
      samples: t.rowCount,
      duration_s: u.duration(t.col('ts'), params.tsUnit).seconds,
      dis_mean: mean('dis'),
      dis_main_mean: mean('dis_main'),
      dis_resid_rms: rms('dis_resid'),
      dis_main_resid_rms: rms('dis_main_resid'),
      outliers: t.has('is_outlier') ? u.sum(t.col('is_outlier')) : undefined,
      rssi_init_mean: mean('rssi_init'),
      rssi_refl_mean: mean('rssi_refl'),
      rssi_diff_mean: mean('rssi_diff'),
    };
  },

  // 跨文件：参数 s 是汇总表（每行一个文件，列 = summarize 返回的键 + file / path）
  aggregate(s, { utils: u }) {
    const avail = (cols) => cols.filter((c) => s.has(c));
    const rssi = avail(['rssi_init_mean', 'rssi_refl_mean']);
    const rms = avail(['dis_resid_rms', 'dis_main_resid_rms']);
    return {
      metrics: [
        { label: '文件数', value: s.rowCount },
        { label: '总样本数', value: u.sum(s.col('samples')) },
        s.has('dis_resid_rms') && { label: '平均 dis 残差 RMS', value: u.mean(s.col('dis_resid_rms')) },
        s.has('dis_main_resid_rms') && { label: '平均 dis_main 残差 RMS', value: u.mean(s.col('dis_main_resid_rms')) },
      ],
      charts: [
        rssi.length && { title: '各文件 RSSI 均值', type: 'bar', horizontal: true, x: 'file', y: rssi },
        rms.length && { title: '各文件平滑残差 RMS', type: 'bar', horizontal: true, x: 'file', y: rms },
        s.has('dis_mean') && s.has('rssi_init_mean') &&
          { title: 'dis 均值 vs rssi_init 均值', subtitle: '每个点是一个文件', type: 'scatter', x: 'dis_mean', y: 'rssi_init_mean', span: 2 },
      ],
    };
  },
});
})();
