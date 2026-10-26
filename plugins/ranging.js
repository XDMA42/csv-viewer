/**
 * 测距分析插件 —— 针对包含 ts / dis / dissm / rssi 列的 CSV（列名不区分大小写）。
 *
 *  图表：dis vs ts、dissm vs ts、rssi vs ts（三张图共用时间轴，缩放/悬停联动），
 *        以及残差曲线、rssi vs dis 散点、残差分布。
 *  衍生特征：dis_resid = dis − dissm、dt = 相邻 ts 之差、is_outlier（|残差| 超过阈值）。
 *  批量：每个文件汇总成一行（样本数、时长、残差 RMS、RSSI 统计……），再做跨文件对比。
 */
CSVViewer.registerPlugin({
  id: 'ranging',
  name: '测距分析',
  version: '1.0.0',
  description: '含 ts / dis / dissm / rssi 列的测距日志：dis、dissm、rssi 随时间变化，平滑残差与 RSSI 统计。',
  priority: 10,

  match: { columns: ['ts', 'dis', 'dissm', 'rssi'] },

  params: [
    { key: 'outlier', label: '离群阈值 |dis − dissm| >', type: 'number', default: 0.5, min: 0, step: 0.1 },
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
      label: '平滑残差',
      description: 'dis − dissm',
      compute: (t) => t.map(['dis', 'dissm'], (dis, dissm) => dis - dissm),
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
    const dis = t.col('dis');
    const rssi = t.col('rssi');
    const dur = u.duration(t.col('ts'), params.tsUnit);
    const n = u.count(dis);
    return [
      { label: '样本数', value: n },
      { label: '时长', value: dur.text },
      { label: '平均采样率', value: dur.seconds ? n / dur.seconds : null, unit: 'Hz', digits: 1 },
      { label: 'dis 均值', value: u.mean(dis) },
      { label: 'dis 范围', value: `${u.fmt(u.min(dis))} – ${u.fmt(u.max(dis))}` },
      { label: '残差 RMS', value: u.rms(t.col('dis_resid')), hint: 'dis − dissm 的均方根' },
      { label: '离群点', value: u.sum(t.col('is_outlier')), hint: `|残差| > ${params.outlier}` },
      { label: 'RSSI 均值', value: u.mean(rssi), digits: 1 },
      { label: 'RSSI 范围', value: `${u.fmt(u.min(rssi))} – ${u.fmt(u.max(rssi))}` },
    ];
  },

  charts() {
    return [
      // 需求中的三张图：x 都是 ts，会自动联动
      { title: 'dis vs ts', type: 'line', x: 'ts', y: 'dis' },
      { title: 'dissm vs ts', type: 'line', x: 'ts', y: 'dissm' },
      { title: 'rssi vs ts', type: 'line', x: 'ts', y: 'rssi' },
      // 额外的分析图
      { title: '平滑残差 dis − dissm', type: 'line', x: 'ts', y: 'dis_resid', markLines: [{ y: 0 }], height: 200 },
      { title: 'rssi vs dis', subtitle: '每个点是一条记录', type: 'scatter', x: 'dis', y: 'rssi' },
      { title: '残差分布', type: 'histogram', y: 'dis_resid', bins: 40 },
    ];
  },

  // 批量分析：每个文件 → 一行
  summarize(t, { utils: u, params }) {
    const dis = t.col('dis');
    const rssi = t.col('rssi');
    const dur = u.duration(t.col('ts'), params.tsUnit);
    return {
      samples: u.count(dis),
      duration_s: dur.seconds,
      dis_mean: u.mean(dis),
      dis_std: u.std(dis),
      resid_rms: u.rms(t.col('dis_resid')),
      outliers: u.sum(t.col('is_outlier')),
      rssi_mean: u.mean(rssi),
      rssi_min: u.min(rssi),
      rssi_max: u.max(rssi),
    };
  },

  // 跨文件：参数 s 是汇总表（每行一个文件，列 = summarize 返回的键 + file / path）
  aggregate(s, { utils: u }) {
    return {
      metrics: [
        { label: '文件数', value: s.rowCount },
        { label: '总样本数', value: u.sum(s.col('samples')) },
        { label: '平均残差 RMS', value: u.mean(s.col('resid_rms')) },
      ],
      charts: [
        { title: '各文件 RSSI 均值', type: 'bar', horizontal: true, x: 'file', y: 'rssi_mean', labels: true },
        { title: '各文件残差 RMS', type: 'bar', horizontal: true, x: 'file', y: 'resid_rms', labels: true },
        { title: 'dis 均值 vs RSSI 均值', subtitle: '每个点是一个文件', type: 'scatter', x: 'dis_mean', y: 'rssi_mean', span: 2 },
      ],
    };
  },
});
