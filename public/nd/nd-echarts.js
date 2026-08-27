// Nerdesign v1.0.3 – ECharts theme and option helpers that read nd tokens at runtime. Copied from github.com/nerdegutt/nerdesign – do not edit here; change the source and copy again.
// Nerdesign × ECharts. ES module, no dependencies. Pass your `echarts` instance
// in – this file never binds to a CDN global. Everything reads the nd- tokens
// from the live page, so charts follow light/dark automatically.
//
//   import * as nd from './nd/nd-echarts.js';
//   nd.register(echarts);                                  // theme 'nerdesign'
//   const chart = nd.mount(echarts, document.querySelector('#power'), (t) => ({
//     ...nd.base(t), xAxis: nd.timeAxis(t), yAxis: nd.valueAxis(t, 'kW'),
//     series: [{ type: 'line', name: 'Hovedhuset', data }],
//   }), { table: () => ({ headers: ['Tid', 'kW'], rows }) });
//
// `mount` handles theme changes (dispose + re-init, as ECharts binds the theme
// at init), resize, reduced motion, aria and the data table behind the chart.

/** Read the chart-relevant tokens as plain values. */
export function readTokens(root = document.documentElement) {
  const cs = getComputedStyle(root);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    text: v('--nd-chart-text'), muted: v('--nd-text-muted'), strong: v('--nd-text'),
    axis: v('--nd-chart-axis'), grid: v('--nd-chart-grid'),
    surface: v('--nd-surface'), tooltipBg: v('--nd-chart-tooltip-bg'), tooltipLine: v('--nd-chart-tooltip-line'),
    accent: v('--nd-accent'), font: v('--nd-font-numeric'), fontText: v('--nd-font-text'),
    series: Array.from({ length: 8 }, (_, i) => v(`--nd-series-${i + 1}`)),
    sequential: [100, 200, 300, 400, 500, 600, 700].map((s) => v(`--nd-seq-${s}`)),
    diverging: { neg: v('--nd-div-neg'), mid: v('--nd-div-mid'), pos: v('--nd-div-pos') },
    status: { ok: v('--nd-ok'), warn: v('--nd-warn'), error: v('--nd-error'), info: v('--nd-info') },
  };
}

export const textStyle = (t = readTokens(), extra = {}) => ({ color: t.text, fontFamily: t.font, fontSize: 11, ...extra });

/** ECharts theme object built from tokens. Marks follow the house specs: 2px lines, ≤24px bars with rounded data-ends, hairline grid. */
export function buildTheme(t = readTokens()) {
  const axis = {
    axisLine: { show: true, lineStyle: { color: t.axis } },
    axisTick: { show: false },
    axisLabel: { color: t.text, fontFamily: t.font, fontSize: 11 },
    nameTextStyle: { color: t.text, fontFamily: t.font, fontSize: 11 },
    splitLine: { show: true, lineStyle: { color: t.grid, width: 1, type: 'solid' } },
    splitArea: { show: false },
  };
  return {
    color: t.series,
    backgroundColor: 'transparent',
    textStyle: { color: t.text, fontFamily: t.font },
    title: { textStyle: { color: t.strong, fontFamily: t.fontText, fontWeight: 500, fontSize: 14 } },
    legend: { textStyle: { color: t.text, fontFamily: t.fontText, fontSize: 12 }, icon: 'roundRect', itemWidth: 14, itemHeight: 4, itemGap: 18 },
    tooltip: { backgroundColor: t.tooltipBg, borderColor: t.tooltipLine, borderWidth: 1, textStyle: { color: t.strong, fontFamily: t.font, fontSize: 12 }, axisPointer: { lineStyle: { color: t.muted, width: 1 }, crossStyle: { color: t.muted } } },
    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: axis,
    timeAxis: { ...axis, splitLine: { show: false } },
    logAxis: axis,
    line: { lineStyle: { width: 2 }, symbol: 'circle', symbolSize: 8, showSymbol: false, smooth: false, itemStyle: { borderColor: t.surface, borderWidth: 2 } },
    bar: { barMaxWidth: 24, itemStyle: { borderRadius: [4, 4, 0, 0] } },
    scatter: { symbolSize: 8, itemStyle: { borderColor: t.surface, borderWidth: 2 } },
    heatmap: { itemStyle: { borderColor: t.surface, borderWidth: 2 } },
    gauge: { axisLine: { lineStyle: { color: [[1, t.grid]] } }, title: { color: t.text, fontFamily: t.fontText }, detail: { color: t.strong, fontFamily: t.font } },
    visualMap: { textStyle: { color: t.text, fontFamily: t.font, fontSize: 11 }, inRange: { color: t.sequential } },
    dataZoom: { textStyle: { color: t.text }, borderColor: t.axis, fillerColor: 'rgba(128,128,128,0.15)', handleStyle: { color: t.surface, borderColor: t.muted } },
    markLine: { lineStyle: { color: t.muted, type: 'dashed', width: 1 }, label: { color: t.text, fontFamily: t.font } },
  };
}

/** Register the theme (default name 'nerdesign') from the current tokens. */
export function register(echarts, name = 'nerdesign') { echarts.registerTheme(name, buildTheme()); return name; }

// ---------------------------------------------------------------- option helpers
export const grid = (over = {}) => ({ left: 48, right: 16, top: 36, bottom: 32, containLabel: false, ...over });
export const base = (t = readTokens(), over = {}) => ({ grid: grid(), tooltip: tooltip(t), ...reducedMotion(), ...over });
export function tooltip(t = readTokens(), over = {}) {
  return { trigger: 'axis', confine: true, backgroundColor: t.tooltipBg, borderColor: t.tooltipLine, textStyle: { color: t.strong, fontFamily: t.font, fontSize: 12 }, ...over };
}
export const timeAxis = (t = readTokens(), over = {}) => ({ type: 'time', ...over });
export const valueAxis = (t = readTokens(), name, over = {}) => ({ type: 'value', name, nameGap: 8, scale: false, ...over });
export const categoryAxis = (t = readTokens(), data, over = {}) => ({ type: 'category', data, ...over });
export const series = (t = readTokens()) => t.series;
export const sequential = (t = readTokens()) => t.sequential;
export const diverging = (t = readTokens()) => [t.diverging.neg, t.diverging.mid, t.diverging.pos];
export const status = (t = readTokens()) => t.status;
export function reducedMotion() { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches ? { animation: false } : {}; }

// ---------------------------------------------------------------- theme changes
/** Call cb whenever the resolved theme may have changed (OS, toggle, data-theme). Returns an unsubscribe function. */
export function onThemeChange(cb) {
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const handler = () => cb();
  mq?.addEventListener('change', handler);
  document.addEventListener('nd:theme', handler);
  const mo = new MutationObserver((ms) => { if (ms.some((m) => m.attributeName === 'data-theme')) cb(); });
  mo.observe(document.documentElement, { attributes: true });
  return () => { mq?.removeEventListener('change', handler); document.removeEventListener('nd:theme', handler); mo.disconnect(); };
}

// ---------------------------------------------------------------- mount
/**
 * Mount a chart on `el` (a .nd-chart-canvas). `buildOption(tokens, data)` returns the option.
 * opts.table(data) → { caption?, headers, rows, numeric?: number[] } renders the data table
 * into the sibling .nd-datatable (or opts.tableEl). opts.ariaLabel sets the accessible name.
 * Returns { chart, update(data), dispose() }.
 */
export function mount(echarts, el, buildOption, opts = {}) {
  let data = opts.data, chart, unsub;
  if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
  if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
  const tableEl = opts.tableEl || el.closest('.nd-chart')?.querySelector('.nd-datatable');

  const render = () => {
    const t = readTokens();
    echarts.registerTheme('nerdesign', buildTheme(t));
    if (chart) chart.dispose();
    chart = echarts.init(el, 'nerdesign', { renderer: 'canvas' });
    const option = buildOption(t, data);
    option.aria = { enabled: true, decal: { show: !!opts.decal }, ...(option.aria || {}) };
    chart.setOption({ ...reducedMotion(), ...option });
    if (tableEl && opts.table) {
      const tb = opts.table(data);
      buildDataTable(tableEl, tb.headers, tb.rows, { caption: tb.caption, numeric: tb.numeric });
    }
  };
  render();
  unsub = onThemeChange(render);
  const ro = new ResizeObserver(() => chart?.resize());
  ro.observe(el);
  return {
    get chart() { return chart; },
    update(next) { data = next; render(); },
    dispose() { unsub(); ro.disconnect(); chart?.dispose(); },
  };
}

// ---------------------------------------------------------------- data tables
/** Render a table into `container` (a .nd-datatable). Cells are set as text, never HTML. */
export function buildDataTable(container, headers, rows, { caption, numeric = [] } = {}) {
  container.replaceChildren();
  container.tabIndex = 0;                 // the region scrolls – keyboard users must be able to reach it
  if (caption && !container.hasAttribute('aria-label')) container.setAttribute('aria-label', caption);
  const table = document.createElement('table');
  if (caption) { const c = document.createElement('caption'); c.textContent = caption; table.appendChild(c); }
  const thead = table.createTHead(); const hr = thead.insertRow();
  headers.forEach((h, i) => { const th = document.createElement('th'); th.scope = 'col'; th.textContent = h; if (numeric.includes(i)) th.className = 'nd-num'; hr.appendChild(th); });
  const tbody = table.createTBody();
  for (const r of rows) { const tr = tbody.insertRow(); r.forEach((c, i) => { const td = tr.insertCell(); td.textContent = c == null ? '–' : String(c); if (numeric.includes(i)) td.className = 'nd-num'; }); }
  container.appendChild(table);
}

/** Wire every .nd-datatable-toggle under root (event delegation). Idempotent. */
export function wireDataTables(root = document) {
  if (root.__ndWired) return; root.__ndWired = true;
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.nd-datatable-toggle'); if (!btn) return;
    const panel = btn.closest('.nd-chart'); const table = panel?.querySelector('.nd-datatable'); if (!table) return;
    const show = table.hidden; table.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    btn.textContent = show ? 'Skjul datatabell' : 'Vis datatabell';
    if (show) table.focus?.();
  });
}

// ---------------------------------------------------------------- small utilities
/** Announce to screen readers via a polite live region (#nd-live or created). */
export function announce(message) {
  let el = document.getElementById('nd-live');
  if (!el) { el = document.createElement('div'); el.id = 'nd-live'; el.className = 'nd-sr-only'; el.setAttribute('aria-live', 'polite'); el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = ''; requestAnimationFrame(() => { el.textContent = message; });
}
/** «for 12 min siden», «nå nettopp», «for 3 t siden», «for 2 d siden». */
export function relativeTime(ts, now = Date.now()) {
  const mins = Math.round((now - ts) / 60000);
  if (mins < 1) return 'nå nettopp';
  if (mins < 60) return `for ${mins} min siden`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `for ${hours} t siden`;
  return `for ${Math.round(hours / 24)} d siden`;
}
const pad2 = (n) => String(n).padStart(2, '0');
/** dd.MM HH:mm */
export function fmtDateTime(ms) { const d = new Date(ms); return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
/** Norwegian number: 1 234,5 */
export function fmtNumber(v, decimals = 1) { return v == null ? '–' : v.toLocaleString('nb-NO', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }); }
