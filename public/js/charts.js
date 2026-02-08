const CYAN = '#22d3ee';
const ORANGE = '#f97316';
const TEXT = '#a0a0b0';
const GRID_LINE = 'rgba(255,255,255,0.05)';
const AXIS_LINE = '#333';
const FONT = 'JetBrains Mono, monospace';
const WEEKDAYS = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];

const instances = {};

function getOrCreate(id) {
  if (instances[id]) {
    instances[id].dispose();
  }
  const el = document.getElementById(id);
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

// --- Gauge: Snitt siste 24t ---
export function renderGauge(data) {
  const chart = getOrCreate('gauge-chart');

  // Beregn snitt av siste 24 datapunkter (eller alle hvis færre)
  const recent = data.slice(-24);
  const avg = recent.length > 0
    ? recent.reduce((s, d) => s + d.consumption_kwh, 0) / recent.length
    : 0;

  chart.setOption({
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
      data: [{ value: +avg.toFixed(2), name: 'snitt 24t' }],
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

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  const labelFormatter = (v) => {
    const d = new Date(v);
    if (days >= 365) return MONTHS[d.getMonth()];
    if (days >= 30) return `${d.getDate()}.${d.getMonth() + 1}`;
    return `${String(d.getHours()).padStart(2, '0')}`;
  };

  const tooltipFormatter = (params) => {
    const ts = params[0].axisValue;
    const d = new Date(ts);
    let label;
    if (days >= 365) label = `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
    else if (days >= 30) label = `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:00`;
    else label = `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:00`;
    const lines = params.map((p) => {
      const unit = p.seriesName === 'Temperatur' ? '°C' : 'kWh';
      return `${p.marker} ${p.seriesName}: ${Number(p.value).toFixed(2)} ${unit}`;
    });
    return `${label}<br/>${lines.join('<br/>')}`;
  };

  chart.setOption({
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
      top: 0,
    },
    grid: { left: 50, right: 50, top: 40, bottom: 70 },
    xAxis: {
      type: 'category',
      data: timestamps,
      axisLine: baseAxisLine(),
      axisLabel: {
        ...baseTextStyle(),
        formatter: labelFormatter,
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

// --- Scatter: Temperatur vs forbruk ---
export function renderScatterChart(data) {
  const chart = getOrCreate('scatter-chart');

  const points = data
    .filter((d) => d.outside_temp_c != null)
    .map((d) => [d.outside_temp_c, d.consumption_kwh]);

  chart.setOption({
    tooltip: {
      trigger: 'item',
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (p) => `${p.value[0]}°C → ${p.value[1]} kWh`,
    },
    grid: { left: 50, right: 30, top: 40, bottom: 40 },
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
    series: [{
      type: 'scatter',
      data: points,
      symbolSize: 5,
      itemStyle: { color: CYAN, opacity: 0.6 },
    }],
  });

  return chart;
}

// --- Heatmap: Ukedag x klokketime ---
export function renderHeatmap(heatmapData) {
  const chart = getOrCreate('heatmap-chart');

  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const maxVal = Math.max(...heatmapData.map((d) => d[2]), 0.1);

  chart.setOption({
    tooltip: {
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (p) => `${WEEKDAYS[p.value[1]]} ${hours[p.value[0]]}<br/>${p.value[2].toFixed(2)} kWh`,
    },
    grid: { left: 50, right: 30, top: 10, bottom: 40 },
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
      min: 0,
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
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1a1a2e',
      borderColor: '#333',
      textStyle: baseTextStyle(),
      formatter: (p) => `${p[0].name}: ${p[0].value.toFixed(2)} kWh`,
    },
    grid: { left: 50, right: 20, top: 20, bottom: 30 },
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
