/**
 * 测距分析插件 —— 针对包含以下列的 CSV（列名不区分大小写）：
 *   ts, dis, dis_sm, dis_main, dis_main_sm, rssi_init, rssi_refl
 *
 *  图表：dis & dis_sm vs ts、dis_main & dis_main_sm vs ts、rssi_init & rssi_refl vs ts
 *        （三张图共用时间轴，缩放/悬停联动），以及平滑残差、rssi vs dis 散点、残差分布。
 *  衍生特征：dis_resid = dis − dis_sm、dis_main_resid = dis_main − dis_main_sm、
 *            rssi_diff = rssi_init − rssi_refl、dt = 相邻 ts 之差、is_outlier（|dis_resid| 超过阈值）。
 *  批量：每个文件汇总成一行（样本数、时长、残差 RMS、RSSI 统计……），再做跨文件对比。
 */
CSVViewer.registerPlugin({
  id: 'ranging',
  name: '测距分析',
  version: '1.1.0',
  description: '含 ts / dis / dis_sm / dis_main / dis_main_sm / rssi_init / rssi_refl 列的测距日志：两路距离及其平滑值、两路 RSSI 随时间变化。',
  priority: 10,

  match: { columns: ['ts', 'dis', 'dis_sm', 'dis_main', 'dis_main_sm', 'rssi_init', 'rssi_refl'] },

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
      compute: (t) => t.map(['dis', 'dis_sm'], (a, b) => a - b),
    },
    {
      name: 'dis_main_resid',
      label: 'dis_main 平滑残差',
      description: 'dis_main − dis_main_sm',
      compute: (t) => t.map(['dis_main', 'dis_main_sm'], (a, b) => a - b),
    },
    {
      name: 'rssi_diff',
      label: 'RSSI 差',
      description: 'rssi_init − rssi_refl',
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
      compute: (t, { params }) =>
        t.map(['dis_resid'], (r) => (Number.isFinite(r) ? (Math.abs(r) > params.outlier ? 1 : 0) : NaN)),
    },
  ],

  metrics(t, { utils: u, params }) {
    const dur = u.duration(t.col('ts'), params.tsUnit);
    const n = u.count(t.col('dis'));
    return [
      { label: '样本数', value: n },
      { label: '时长', value: dur.text },
      { label: '平均采样率', value: dur.seconds ? n / dur.seconds : null, unit: 'Hz', digits: 1 },
      { label: 'dis 均值', value: u.mean(t.col('dis')) },
      { label: 'dis_main 均值', value: u.mean(t.col('dis_main')) },
      { label: 'dis 残差 RMS', value: u.rms(t.col('dis_resid')), hint: 'dis − dis_sm 的均方根' },
      { label: 'dis_main 残差 RMS', value: u.rms(t.col('dis_main_resid')), hint: 'dis_main − dis_main_sm 的均方根' },
      { label: '离群点', value: u.sum(t.col('is_outlier')), hint: `|dis − dis_sm| > ${params.outlier}` },
      { label: 'rssi_init 均值', value: u.mean(t.col('rssi_init')), digits: 1 },
      { label: 'rssi_refl 均值', value: u.mean(t.col('rssi_refl')), digits: 1 },
      { label: 'RSSI 差均值', value: u.mean(t.col('rssi_diff')), digits: 1, hint: 'rssi_init − rssi_refl' },
    ];
  },

  charts() {
    return [
      // 需求中的三张图：每张两条线，x 都是 ts，会自动联动
      { title: 'dis & dis_sm vs ts', type: 'line', x: 'ts', y: ['dis', 'dis_sm'] },
      { title: 'dis_main & dis_main_sm vs ts', type: 'line', x: 'ts', y: ['dis_main', 'dis_main_sm'] },
      { title: 'rssi_init & rssi_refl vs ts', type: 'line', x: 'ts', y: ['rssi_init', 'rssi_refl'] },
      // 额外的分析图
      { title: '平滑残差 vs ts', type: 'line', x: 'ts', y: ['dis_resid', 'dis_main_resid'], markLines: [{ y: 0 }], height: 200 },
      {
        title: 'rssi vs dis', subtitle: '每个点是一条记录', type: 'scatter',
        series: [
          { name: 'rssi_init', x: 'dis', y: 'rssi_init' },
          { name: 'rssi_refl', x: 'dis', y: 'rssi_refl' },
        ],
      },
      { title: '平滑残差分布', type: 'histogram', y: ['dis_resid', 'dis_main_resid'], bins: 40 },
    ];
  },

  // 批量分析：每个文件 → 一行
  summarize(t, { utils: u, params }) {
    const dur = u.duration(t.col('ts'), params.tsUnit);
    return {
      samples: u.count(t.col('dis')),
      duration_s: dur.seconds,
      dis_mean: u.mean(t.col('dis')),
      dis_main_mean: u.mean(t.col('dis_main')),
      dis_resid_rms: u.rms(t.col('dis_resid')),
      dis_main_resid_rms: u.rms(t.col('dis_main_resid')),
      outliers: u.sum(t.col('is_outlier')),
      rssi_init_mean: u.mean(t.col('rssi_init')),
      rssi_refl_mean: u.mean(t.col('rssi_refl')),
      rssi_diff_mean: u.mean(t.col('rssi_diff')),
    };
  },

  // 跨文件：参数 s 是汇总表（每行一个文件，列 = summarize 返回的键 + file / path）
  aggregate(s, { utils: u }) {
    return {
      metrics: [
        { label: '文件数', value: s.rowCount },
        { label: '总样本数', value: u.sum(s.col('samples')) },
        { label: '平均 dis 残差 RMS', value: u.mean(s.col('dis_resid_rms')) },
        { label: '平均 dis_main 残差 RMS', value: u.mean(s.col('dis_main_resid_rms')) },
      ],
      charts: [
        { title: '各文件 RSSI 均值', type: 'bar', horizontal: true, x: 'file', y: ['rssi_init_mean', 'rssi_refl_mean'] },
        { title: '各文件平滑残差 RMS', type: 'bar', horizontal: true, x: 'file', y: ['dis_resid_rms', 'dis_main_resid_rms'] },
        { title: 'dis 均值 vs rssi_init 均值', subtitle: '每个点是一个文件', type: 'scatter', x: 'dis_mean', y: 'rssi_init_mean', span: 2 },
      ],
    };
  },
});
