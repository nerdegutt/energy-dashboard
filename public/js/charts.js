const CYAN = '#22d3ee';
const ORANGE = '#f97316';
const TEXT = '#a0a0b0';
const GRID_LINE = 'rgba(255,255,255,0.05)';
const AXIS_LINE = '#333';
const FONT = 'JetBrains Mono, monospace';
const WEEKDAYS = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
const MONTHS_SHORT = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];

const instances = {};

function getOrCreate(id) {
  if (instances[id]) {
    instances[id].dispose();
  }
  const el = document.getElementById(id);
  if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
  const chart = echarts.init(el);
  instances[id] = chart;
  return chart;
}

function baseTextStyle() {
  return { color: TEXT, fontFamily: FONT, fontSize: 11 };
}

function baseAxisLine() {
  return { lineStyle: { color: AXIS_LINE } };
}

function baseSplitLine() {
  return { lineStyle: { color: GRID_LINE } };
}

// --- Gauge: Snitt for valgt periode ---
export function renderGauge(data, days) {
  const chart = getOrCreate('gauge-chart');

  const valid = data.filter((d) => d.consumption_kwh != null);
  const avg = valid.length > 0
    ? valid.reduce((s, d) => s + d.consumption_kwh, 0) / valid.length
    : 0;

  const periodLabel = days >= 365 ? 'snitt 1 år' : days >= 28 ? 'snitt 28d' : days >= 7 ? 'snitt 7d' : 'snitt 24t';

  chart.setOption({
    aria: { enabled: true, label: { description: `Gjennomsnittlig strømforbruk: ${avg.toFixed(2)} kWh, ${periodLabel}` } },
    series: [{
      type: 'gauge',
      startAngle: 210,
      endAngle: -30,
      min: 0,
      max: Math.max(5, Math.ceil(avg * 2)),
      radius: '90%',
      center: ['50%', '55%'],
      pointer: { show: false },
      progress: {
        show: true,
        width: 12,
        itemStyle: { color: CYAN },
      },
      axisLine: {
        lineStyle: { width: 12, color: [[1, '#1a1a2e']] },
      },
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: { show: false },
      detail: {
        offsetCenter: [0, '20%'],
        formatter: '{value} kW',
        fontSize: 18,
        fontFamily: FONT,
        fontWeight: 600,
        color: CYAN,
      },
      title: {
        offsetCenter: [0, '55%'],
        fontSize: 11,
        fontFamily: FONT,
        color: TEXT,
      },
      data: [{ value: +avg.toFixed(2), name: periodLabel }],
    }],
  });

  return chart;
}

// --- Linjegraf: Forbruk + 24t rullende snitt ---
export function renderLineChart(data, rollingAvg, days) {
  const chart = getOrCreate('line-chart');

  const timestamps = data.map((d) => d.timestamp);
  const consumption = data.map((d) => d.consumption_kwh);
  const rolling = rollingAvg.map((d) => d.value);
  const temperature = data.map((d) => d.outside_temp_c);

  const labelFormatter = (v) => {
    const d = new Date(v);
    if (days >= 365) return `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
    if (days >= 7) return `${d.getDate()}. ${MONTHS_SHORT[d.getMonth()]}`;
    return `${String(d.getHours()).padStart(2, '0')}:00`;
  };

  const tooltipFormatter = (params) => {
    const ts = params[0].axisValue;
    const d = new Date(ts);
    let label;
    if (days >= 365) label = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
    else if (days >= 28) label = `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:00`;
    else label = `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:00`;
    const lines = params.map((p) => {
      const unit = p.seriesName === 'Temperatur' ? '°C' : 'kWh';
      return `${p.marker} ${p.seriesName}: ${Number(p.value).toFixed(2)} ${unit}`;
    });
    return `${label}<br/>${lines.join('<br/>')}`;
  };

  chart.setOption({
    title: { text: 'Forbruk og temperatur', textStyle: { color: TEXT, fontFamily: FONT, fontSize: 13 }, left: 'center', top: 0 },
    aria: { enabled: true, label: { description: 'Linjegraf som viser strømforbruk, rullende snitt og temperatur over tid' } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: tooltipFormatter,
    },
    legend: {
      data: ['Forbruk', days >= 365 ? '7d snitt' : '24t snitt', 'Temperatur'],
      textStyle: baseTextStyle(),
      top: 20,
    },
    grid: { left: 50, right: 50, top: 55, bottom: 70 },
    xAxis: {
      type: 'category',
      data: timestamps,
      axisLine: baseAxisLine(),
      axisLabel: {
        ...baseTextStyle(),
        formatter: labelFormatter,
        interval: (idx, val) => {
          const d = new Date(val);
          if (days >= 365) return d.getDate() === 1;
          if (days >= 28) return d.getHours() === 0 && d.getDay() === 1;
          if (days >= 7) return d.getHours() === 0;
          return d.getHours() % 3 === 0;
        },
      },
      axisTick: {
        alignWithLabel: true,
        interval: (idx, val) => {
          const d = new Date(val);
          if (days >= 365) return d.getDate() === 1;
          if (days >= 28) return d.getHours() === 0 && d.getDay() === 1;
          if (days >= 7) return d.getHours() === 0;
          return d.getHours() % 3 === 0;
        },
      },
      splitLine: { show: false },
    },
    yAxis: [
      {
        type: 'value',
        name: 'kWh',
        nameTextStyle: baseTextStyle(),
        axisLine: baseAxisLine(),
        axisLabel: baseTextStyle(),
        splitLine: baseSplitLine(),
      },
      {
        type: 'value',
        name: '°C',
        nameTextStyle: baseTextStyle(),
        axisLine: { lineStyle: { color: ORANGE } },
        axisLabel: { ...baseTextStyle(), color: ORANGE },
        splitLine: { show: false },
      },
    ],
    dataZoom: [{
      type: 'slider',
      height: 20,
      bottom: 10,
      borderColor: '#333',
      backgroundColor: '#1a1a2e',
      fillerColor: 'rgba(34, 211, 238, 0.1)',
      handleStyle: { color: CYAN },
      textStyle: baseTextStyle(),
    }],
    series: [
      {
        name: 'Forbruk',
        type: 'line',
        data: consumption,
        smooth: true,
        symbol: 'none',
        itemStyle: { color: CYAN },
        lineStyle: { color: CYAN, width: 1.5 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34, 211, 238, 0.25)' },
            { offset: 1, color: 'rgba(34, 211, 238, 0)' },
          ]),
        },
      },
      {
        name: days >= 365 ? '7d snitt' : '24t snitt',
        type: 'line',
        data: rolling,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#a78bfa', width: 2 },
        itemStyle: { color: '#a78bfa' },
      },
      {
        name: 'Temperatur',
        type: 'line',
        data: temperature,
        yAxisIndex: 1,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: '#f97316', width: 1, opacity: 0.5 },
        itemStyle: { color: '#f97316' },
      },
    ],
  });

  return chart;
}

// --- Minste kvadraters metode ---
function linearRegression(points) {
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of points) {
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const a = (sy - b * sx) / n;
  return { a, b }; // y = a + b*x
}

function quadraticRegression(points) {
  const n = points.length;
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (const [x, y] of points) {
    const x2 = x * x;
    sx += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2;
    sy += y; sxy += x * y; sx2y += x2 * y;
  }
  // Løs 3x3 lineært system med Cramers regel
  const A = [
    [n, sx, sx2],
    [sx, sx2, sx3],
    [sx2, sx3, sx4],
  ];
  const B = [sy, sxy, sx2y];

  function det3(m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
         - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
         + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }

  const D = det3(A);
  const D0 = det3([
    [B[0], A[0][1], A[0][2]],
    [B[1], A[1][1], A[1][2]],
    [B[2], A[2][1], A[2][2]],
  ]);
  const D1 = det3([
    [A[0][0], B[0], A[0][2]],
    [A[1][0], B[1], A[1][2]],
    [A[2][0], B[2], A[2][2]],
  ]);
  const D2 = det3([
    [A[0][0], A[0][1], B[0]],
    [A[1][0], A[1][1], B[1]],
    [A[2][0], A[2][1], B[2]],
  ]);

  return { a: D0 / D, b: D1 / D, c: D2 / D }; // y = a + b*x + c*x²
}

function rSquared(points, predict) {
  const meanY = points.reduce((s, [, y]) => s + y, 0) / points.length;
  let ssRes = 0, ssTot = 0;
  for (const [x, y] of points) {
    ssRes += (y - predict(x)) ** 2;
    ssTot += (y - meanY) ** 2;
  }
  return 1 - ssRes / ssTot;
}

function formatCoeff(v, decimals = 4) {
  return v >= 0 ? `+ ${v.toFixed(decimals)}` : `- ${Math.abs(v).toFixed(decimals)}`;
}

// --- Scatter: Temperatur vs forbruk ---
export function renderScatterChart(data) {
  const chart = getOrCreate('scatter-chart');

  const points = data
    .filter((d) => d.outside_temp_c != null && d.consumption_kwh != null)
    .map((d) => [d.outside_temp_c, d.consumption_kwh]);

  // Regresjoner
  const lin = linearRegression(points);
  const quad = quadraticRegression(points);
  const r2Lin = rSquared(points, (x) => lin.a + lin.b * x);
  const r2Quad = rSquared(points, (x) => quad.a + quad.b * x + quad.c * x * x);

  // Generer linjer over temperaturspenn
  const temps = points.map(([x]) => x);
  const tMin = Math.floor(Math.min(...temps));
  const tMax = Math.ceil(Math.max(...temps));
  const linLine = [];
  const quadLine = [];
  for (let t = tMin; t <= tMax; t++) {
    linLine.push([t, lin.a + lin.b * t]);
    quadLine.push([t, quad.a + quad.b * t + quad.c * t * t]);
  }

  // Vis formler
  const formulaEl = document.getElementById('regression-formulas');
  if (formulaEl) {
    formulaEl.innerHTML =
      `<span style="color:#a78bfa">1. grad: kWh = ${lin.a.toFixed(4)} ${formatCoeff(lin.b)}T &nbsp; R² = ${r2Lin.toFixed(4)}</span>` +
      `<span style="color:${ORANGE}">2. grad: kWh = ${quad.a.toFixed(4)} ${formatCoeff(quad.b)}T ${formatCoeff(quad.c)}T² &nbsp; R² = ${r2Quad.toFixed(4)}</span>`;
  }

  chart.setOption({
    title: { text: 'Temperatur vs. forbruk', textStyle: { color: TEXT, fontFamily: FONT, fontSize: 13 }, left: 'center', top: 0 },
    aria: { enabled: true, label: { description: `Punktdiagram med ${points.length} datapunkter. Lineær regresjon R²=${r2Lin.toFixed(3)}, kvadratisk regresjon R²=${r2Quad.toFixed(3)}` } },
    tooltip: {
      trigger: 'item',
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (p) => {
        if (p.seriesIndex > 0) return `${p.value[0]}°C → ${p.value[1].toFixed(2)} kWh`;
        return `${p.value[0].toFixed(2)}°C → ${p.value[1].toFixed(2)} kWh`;
      },
    },
    legend: {
      data: ['Forbruk', '1. grad', '2. grad'],
      textStyle: baseTextStyle(),
      top: 20,
    },
    grid: { left: 50, right: 30, top: 55, bottom: 40 },
    xAxis: {
      type: 'value',
      name: 'Temperatur (°C)',
      nameTextStyle: baseTextStyle(),
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
      splitLine: baseSplitLine(),
    },
    yAxis: {
      type: 'value',
      name: 'Forbruk (kWh)',
      nameTextStyle: baseTextStyle(),
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
      splitLine: baseSplitLine(),
    },
    series: [
      {
        name: 'Forbruk',
        type: 'scatter',
        data: points,
        symbolSize: 7,
        itemStyle: { color: CYAN, opacity: 0.4 },
      },
      {
        name: '1. grad',
        type: 'line',
        data: linLine,
        smooth: false,
        symbol: 'none',
        lineStyle: { color: '#a78bfa', width: 2 },
        itemStyle: { color: '#a78bfa' },
      },
      {
        name: '2. grad',
        type: 'line',
        data: quadLine,
        smooth: true,
        symbol: 'none',
        lineStyle: { color: ORANGE, width: 2 },
        itemStyle: { color: ORANGE },
      },
    ],
  });

  return chart;
}

// --- År-over-år sammenligning (±7d sentrert rullende snitt) ---
export function renderYoyChart(yoyData) {
  const chart = getOrCreate('yoy-chart');

  // Labels er YYYY-MM-DD, vis "mnd år" på 1. i hver måned
  const labelFormatter = (v) => {
    const d = new Date(v);
    return `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  };

  chart.setOption({
    title: { text: 'År-over-år sammenligning', textStyle: { color: TEXT, fontFamily: FONT, fontSize: 13 }, left: 'center', top: 0 },
    aria: { enabled: true, label: { description: 'Sammenligning av strømforbruk siste år mot forrige periode med 28-dagers rullende snitt' } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (params) => {
        const d = new Date(params[0].axisValue);
        const label = `${d.getDate()}.${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
        const valid = params.filter((p) => p.value != null);
        const lines = valid.map((p) => `${p.marker} ${p.seriesName}: ${Number(p.value).toFixed(2)} kWh`);
        const cur = valid.find((p) => p.seriesName === 'Siste år');
        const prev = valid.find((p) => p.seriesName === 'Forrige periode');
        if (cur && prev && prev.value > 0) {
          const pct = ((cur.value - prev.value) / prev.value) * 100;
          const dir = pct > 0 ? 'mer' : 'mindre';
          lines.push(`${Math.abs(pct).toFixed(1)}% ${dir} enn året før`);
        }
        return `${label}<br/>${lines.join('<br/>')}`;
      },
    },
    legend: {
      data: ['Siste år', 'Forrige periode'],
      textStyle: baseTextStyle(),
      top: 20,
    },
    grid: { left: 50, right: 20, top: 55, bottom: 70 },
    xAxis: {
      type: 'category',
      data: yoyData.labels,
      axisLine: baseAxisLine(),
      axisLabel: {
        ...baseTextStyle(),
        formatter: labelFormatter,
        interval: (idx, val) => parseInt(val.split('-')[2]) === 1,
      },
      axisTick: {
        alignWithLabel: true,
        interval: (idx, val) => parseInt(val.split('-')[2]) === 1,
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      name: 'kWh (±7d snitt)',
      nameTextStyle: baseTextStyle(),
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
      splitLine: baseSplitLine(),
    },
    dataZoom: [{
      type: 'slider',
      height: 20,
      bottom: 10,
      borderColor: '#333',
      backgroundColor: '#1a1a2e',
      fillerColor: 'rgba(34, 211, 238, 0.1)',
      handleStyle: { color: CYAN },
      textStyle: baseTextStyle(),
    }],
    series: [
      {
        name: 'Siste år',
        type: 'line',
        data: yoyData.current,
        smooth: true,
        symbol: 'none',
        itemStyle: { color: CYAN },
        lineStyle: { color: CYAN, width: 2 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(34, 211, 238, 0.35)' },
            { offset: 1, color: 'rgba(34, 211, 238, 0.03)' },
          ]),
        },
      },
      {
        name: 'Forrige periode',
        type: 'line',
        data: yoyData.previous,
        smooth: true,
        symbol: 'none',
        itemStyle: { color: '#a78bfa' },
        lineStyle: { color: '#a78bfa', width: 2, opacity: 0.7 },
      },
      {
        // Rød fyll mellom linjene der siste år > forrige periode
        type: 'custom',
        silent: true,
        tooltip: { show: false },
        renderItem: (params, api) => {
          const idx = params.dataIndex;
          if (idx === 0) return;

          const cur0 = yoyData.current[idx - 1];
          const cur1 = yoyData.current[idx];
          const prev0 = yoyData.previous[idx - 1];
          const prev1 = yoyData.previous[idx];

          if (cur0 == null || cur1 == null || prev0 == null || prev1 == null) return;
          if (cur0 === prev0 && cur1 === prev1) return;

          const pCur0 = api.coord([idx - 1, cur0]);
          const pCur1 = api.coord([idx, cur1]);
          const pPrev0 = api.coord([idx - 1, prev0]);
          const pPrev1 = api.coord([idx, prev1]);

          const diff0 = cur0 - prev0;
          const diff1 = cur1 - prev1;
          const sameSign = (diff0 >= 0 && diff1 >= 0) || (diff0 <= 0 && diff1 <= 0);
          const fill = diff0 + diff1 > 0
            ? 'rgba(239, 68, 68, 0.35)'   // rød: bruker mer
            : 'rgba(34, 197, 94, 0.25)';  // grønn: bruker mindre

          const polys = [];
          if (sameSign) {
            polys.push({ pts: [pCur0, pCur1, pPrev1, pPrev0], fill });
          } else {
            // Linjene krysser – finn skjæringspunktet
            const t = diff0 / (diff0 - diff1);
            const midPx = [
              pCur0[0] + t * (pCur1[0] - pCur0[0]),
              pCur0[1] + t * (pCur1[1] - pCur0[1]),
            ];
            polys.push({
              pts: diff0 > 0
                ? [pCur0, midPx, pPrev0]
                : [pCur0, midPx, pPrev0],
              fill: diff0 > 0 ? 'rgba(239, 68, 68, 0.35)' : 'rgba(34, 197, 94, 0.25)',
            });
            polys.push({
              pts: diff1 > 0
                ? [midPx, pCur1, pPrev1]
                : [midPx, pCur1, pPrev1],
              fill: diff1 > 0 ? 'rgba(239, 68, 68, 0.35)' : 'rgba(34, 197, 94, 0.25)',
            });
          }

          const anim = {
            enterFrom: { style: { opacity: 0 } },
            enterAnimation: { duration: 1000, delay: 1000, easing: 'cubicOut' },
          };

          if (polys.length === 1) {
            return {
              type: 'polygon',
              shape: { points: polys[0].pts },
              style: { fill: polys[0].fill },
              ...anim,
            };
          }
          return {
            type: 'group',
            children: polys.map((p) => ({
              type: 'polygon',
              shape: { points: p.pts },
              style: { fill: p.fill },
              ...anim,
            })),
          };
        },
        data: yoyData.labels,
        z: 0,
      },
    ],
  });

  return chart;
}

// --- Prosentvis endring per måned ---
export function renderMonthlyChangeChart(monthlyChange) {
  const chart = getOrCreate('monthly-change-chart');

  chart.setOption({
    title: { text: 'Månedlig endring vs. forrige år', textStyle: { color: TEXT, fontFamily: FONT, fontSize: 13 }, left: 'center', top: 0 },
    aria: { enabled: true, label: { description: 'Stolpediagram som viser prosentvis endring i strømforbruk per måned sammenlignet med året før' } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (params) => {
        const p = params[0];
        const dir = p.value > 0 ? 'mer' : 'mindre';
        return `${p.name}: ${Math.abs(p.value).toFixed(1)}% ${dir} enn året før`;
      },
    },
    grid: { left: 50, right: 20, top: 55, bottom: 30 },
    xAxis: {
      type: 'category',
      data: monthlyChange.map((d) => d.month),
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
    },
    yAxis: {
      type: 'value',
      name: '%',
      nameTextStyle: baseTextStyle(),
      axisLine: baseAxisLine(),
      axisLabel: {
        ...baseTextStyle(),
        formatter: (v) => `${v > 0 ? '+' : ''}${v}%`,
      },
      splitLine: baseSplitLine(),
    },
    series: [{
      type: 'bar',
      data: monthlyChange.map((d) => ({
        value: +d.pct.toFixed(1),
        itemStyle: {
          color: d.pct <= 0
            ? new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(34, 197, 94, 0.8)' },
                { offset: 1, color: 'rgba(34, 197, 94, 0.3)' },
              ])
            : new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(239, 68, 68, 0.8)' },
                { offset: 1, color: 'rgba(239, 68, 68, 0.3)' },
              ]),
          borderRadius: d.pct <= 0 ? [0, 0, 3, 3] : [3, 3, 0, 0],
        },
      })),
      barMaxWidth: 40,
      label: {
        show: true,
        position: 'top',
        formatter: (p) => `${p.value > 0 ? '+' : ''}${p.value}%`,
        ...baseTextStyle(),
        fontSize: 10,
      },
    }],
  });

  return chart;
}

// --- Heatmap: Ukedag x klokketime ---
export function renderHeatmap(heatmapData) {
  const chart = getOrCreate('heatmap-chart');

  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const vals = heatmapData.map((d) => d[2]).filter((v) => v > 0);
  const minVal = vals.length > 0 ? Math.min(...vals) : 0;
  const maxVal = vals.length > 0 ? Math.max(...vals) : 0.1;

  chart.setOption({
    title: { text: 'Forbruk: ukedag × klokketime', textStyle: { color: TEXT, fontFamily: FONT, fontSize: 13 }, left: 'center', top: 0 },
    aria: { enabled: true, label: { description: 'Varmekart som viser gjennomsnittlig strømforbruk fordelt på ukedag og klokketime' } },
    tooltip: {
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (p) => `${WEEKDAYS[p.value[1]]} ${hours[p.value[0]]}<br/>${p.value[2].toFixed(2)} kWh`,
    },
    grid: { left: 50, right: 30, top: 30, bottom: 60 },
    xAxis: {
      type: 'category',
      data: hours,
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
      splitArea: { show: false },
    },
    yAxis: {
      type: 'category',
      data: WEEKDAYS,
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
      splitArea: { show: false },
    },
    visualMap: {
      min: minVal,
      max: maxVal,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      inRange: {
        color: ['#0f0f23', '#164e63', '#22d3ee'],
      },
      textStyle: baseTextStyle(),
    },
    series: [{
      type: 'heatmap',
      data: heatmapData,
      emphasis: {
        itemStyle: { borderColor: '#fff', borderWidth: 1 },
      },
    }],
  });

  return chart;
}

// --- Bardiagram: Snitt per ukedag ---
export function renderWeekdayChart(weekdayData) {
  const chart = getOrCreate('weekday-chart');

  chart.setOption({
    title: { text: 'Snitt per ukedag', textStyle: { color: TEXT, fontFamily: FONT, fontSize: 13 }, left: 'center', top: 0 },
    aria: { enabled: true, label: { description: 'Stolpediagram som viser gjennomsnittlig strømforbruk per ukedag, mandag til søndag' } },
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (p) => `${p[0].name}: ${p[0].value.toFixed(2)} kWh`,
    },
    grid: { left: 50, right: 20, top: 45, bottom: 30 },
    xAxis: {
      type: 'category',
      data: weekdayData.map((d) => d.day),
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
    },
    yAxis: {
      type: 'value',
      name: 'kWh (snitt)',
      nameTextStyle: baseTextStyle(),
      axisLine: baseAxisLine(),
      axisLabel: baseTextStyle(),
      splitLine: baseSplitLine(),
    },
    series: [{
      type: 'bar',
      data: weekdayData.map((d) => d.avg),
      itemStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: CYAN },
          { offset: 1, color: 'rgba(34, 211, 238, 0.3)' },
        ]),
        borderRadius: [3, 3, 0, 0],
      },
      barMaxWidth: 40,
    }],
  });

  return chart;
}

// Resize alle grafer ved vindusendring
export function handleResize() {
  for (const chart of Object.values(instances)) {
    chart.resize();
  }
}
