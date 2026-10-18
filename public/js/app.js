import { getJson } from './api.js';
import { fetchData, clearCache, fillMissingHours, rollingAverage, dailyAverage, yearOverYear, avgByWeekday, heatmapData, monthlyTotals, robustSeasonalRegression, dayOfYear, consumptionDeviation, fetchForecast, historicalDailyTemps, monthlyProjection, forecastTimeline, asHouse, evPerHour, evMonthly } from './data.js';
import * as nd from '../nd/nd-echarts.js';
import { ndTheme } from '../nd/nd-theme.js';
import {
  renderGauge,
  renderLineChart,
  renderScatterChart,
  renderYoyChart,
  renderMonthlyChangeChart,
  renderMonthlyTotalChart,
  renderEvMonthlyChart,
  renderHeatmap,
  renderWeekdayChart,
  renderCumulativeChart,
  renderForecastChart,
  clearCharts,
  handleResize,
} from './charts.js';

const dashboard = document.getElementById('main-content');
const loading = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const chartsContainer = document.getElementById('charts-container');
const periodSelector = document.getElementById('period-selector');

// --- URL-state ---
const VALID_DAYS = [1, 7, 28, 365];

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const days = parseInt(params.get('days'));
  const home = params.get('home');
  return {
    days: VALID_DAYS.includes(days) ? days : 1,
    home: home || null,
  };
}

function updateUrl() {
  const params = new URLSearchParams();
  if (currentDays !== 1) params.set('days', currentDays);
  const defaultHomeId = homesData.length > 0 ? homesData[0].id : null;
  if (currentHomeId && currentHomeId !== defaultHomeId) params.set('home', currentHomeId);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
}

const initialState = readUrlState();
let currentDays = initialState.days;
let currentHomeId = initialState.home;

// --- Datatabell ---
const WEEKDAYS = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];

// Every column except the first holds numbers, so right-align all but column 0.
function buildTable(chartId, headers, rows, caption) {
  const container = document.getElementById(chartId).closest('.nd-chart')?.querySelector('.nd-datatable');
  if (!container) return;
  nd.buildDataTable(container, headers, rows, {
    caption: caption || document.getElementById(chartId).closest('.nd-chart').querySelector('.nd-chart-title')?.textContent,
    numeric: headers.map((_, i) => i).slice(1),
  });
}

function fmtTs(ts, daily) {
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  if (daily) return `${dd}.${mm}.${d.getFullYear()}`;
  const yy = String(d.getFullYear()).slice(2);
  const hh = String(d.getHours()).padStart(2, '0');
  return `${dd}.${mm}.${yy} ${hh}:00`;
}

function fmtKwh(v) { return v != null ? v.toFixed(2) : '\u2013'; }
function fmtTemp(v) { return v != null ? v.toFixed(1) : '\u2013'; }
function fmtPct(v) { return v != null ? v.toFixed(1) : '\u2013'; }

nd.wireDataTables();
const announce = nd.announce;

document.getElementById('refresh-btn').addEventListener('click', () => {
  clearCache();
  loadData(currentDays);
});

// --- Home selector ---
document.getElementById('home-selector').addEventListener('change', (e) => {
  currentHomeId = e.target.value;
  updateUrl();
  announce(`Viser ${e.target.options[e.target.selectedIndex].textContent}`);
  loadData(currentDays);
});

let homesData = [];

async function loadHomes() {
  homesData = await getJson('/api/homes');
  const selector = document.getElementById('home-selector');
  selector.innerHTML = '';
  selector.add(new Option('Alle', 'all'));
  for (const home of homesData) selector.add(new Option(home.name, home.id));
  if (!currentHomeId && homesData.length > 0) currentHomeId = homesData[0].id;
  selector.value = currentHomeId;
}

// --- Period selector ---
const periodLabels = { 1: '24 timer', 7: '7 dager', 28: '28 dager', 365: '1 år' };

function syncPeriodButtons() {
  periodSelector.querySelectorAll('[data-days]').forEach((b) => {
    b.setAttribute('aria-current', String(parseInt(b.dataset.days) === currentDays));
  });
}

periodSelector.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-days]');
  if (!btn) return;

  const days = parseInt(btn.dataset.days);
  if (days === currentDays) return;

  currentDays = days;
  updateUrl();
  syncPeriodButtons();
  announce(`Viser ${periodLabels[days] || days + ' dager'}`);
  loadData(days);
});

// --- År mot år: hele måleren eller uten elbil ---
// Uten elbil viser om tiltak i huset har virket, uavhengig av hvor mye bilen ble ladet.
const yoyMode = document.getElementById('yoy-mode');
let yoyHouseOnly = false;
let yoySource = [];

function renderYoy() {
  yoyMode.querySelectorAll('[data-house]').forEach((b) => {
    b.setAttribute('aria-pressed', String((b.dataset.house === '1') === yoyHouseOnly));
  });
  document.getElementById('yoy-note').textContent = yoyHouseOnly
    ? 'huset uten elbil, siste år mot forrige periode' : 'siste år mot forrige periode';
  document.getElementById('monthly-change-note').textContent = yoyHouseOnly
    ? 'huset uten elbil, prosent mot året før' : 'prosent mot året før';
  const yoy = yearOverYear(yoyHouseOnly ? asHouse(yoySource) : yoySource, 365);
  renderYoyChart(yoy);
  renderMonthlyChangeChart(yoy.monthlyChange);

  buildTable('yoy-chart',
    ['Dato', 'Siste \u00e5r (kWh)', 'Forrige periode (kWh)'],
    yoy.labels.map((label, i) => [
      fmtTs(label + 'T00:00:00', true),
      fmtKwh(yoy.current[i]),
      fmtKwh(yoy.previous[i]),
    ])
  );
  buildTable('monthly-change-chart',
    ['M\u00e5ned', 'Endring (%)'],
    yoy.monthlyChange.map((d) => [d.month, fmtPct(d.pct)])
  );
}

yoyMode.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-house]');
  if (!btn || (btn.dataset.house === '1') === yoyHouseOnly) return;
  yoyHouseOnly = btn.dataset.house === '1';
  renderYoy();
  announce(yoyHouseOnly ? 'År mot år viser huset uten elbil' : 'År mot år viser hele måleren');
});

// --- App flow ---
async function showDashboard() {
  dashboard.hidden = false;
  const heading = dashboard.querySelector('h1');
  if (heading) setTimeout(() => heading.focus(), 100);
  await loadHomes();
  syncPeriodButtons();
  loadData(currentDays);
}

async function loadData(days) {
  clearCharts();
  loading.hidden = false;
  emptyState.hidden = true;
  chartsContainer.hidden = true;
  announce('Henter data...');

  try {
    const data = await fetchData(days, currentHomeId);

    if (data.length === 0) {
      loading.hidden = true;
      emptyState.hidden = false;
      announce('Ingen data funnet');
      return;
    }

    loading.hidden = true;
    chartsContainer.hidden = false;

    // Hjem med elbillader: modellen og husgrafene bruker husforbruket (måler minus elbil), og bilen vises for seg.
    const hasCharger = currentHomeId === 'all'
      ? homesData.some(h => h.has_charger)
      : !!homesData.find(h => h.id === currentHomeId)?.has_charger;

    const filled = days < 365 ? fillMissingHours(data, days) : data;
    const chartData = days >= 365 ? dailyAverage(data) : filled;
    const rolling = days <= 1 ? [] : rollingAverage(chartData, days >= 365 ? 7 : 24);
    const weekday = avgByWeekday(data);
    const heatmap = heatmapData(data);

    // YoY: alltid fullt år, uavhengig av valgt periode
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const yoyDays = Math.ceil((Date.now() - twoYearsAgo.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const yoyData = await fetchData(yoyDays, currentHomeId);
    const houseYoy = asHouse(yoyData);

    // Regresjonsmodell (temp → kWh) – beregnes én gang, brukes av gauge + prognose
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const regressionPoints = houseYoy
      .filter(d => new Date(d.timestamp) >= oneYearAgo && d.consumption_kwh != null && d.outside_temp_c != null)
      .map(d => {
        const dt = new Date(d.timestamp);
        return [d.outside_temp_c, dayOfYear(dt), d.consumption_kwh];
      });

    const coeffs = regressionPoints.length > 100 ? robustSeasonalRegression(regressionPoints) : null;
    // Hele måleren (5000 kWh-grensen): huset etter modellen pluss elbilens snitt per time siste 28 døgn.
    const evHourly = hasCharger ? evPerHour(yoyData) : 0;
    const coeffsMeter = coeffs ? { ...coeffs, a: coeffs.a + evHourly } : null;

    let deviation = null;
    if (days <= 1 && coeffs) {
      deviation = consumptionDeviation(asHouse(data), coeffs);
    }

    renderGauge(data, days, deviation, hasCharger);
    renderLineChart(chartData, rolling, days, hasCharger);

    // Linjegraf-tabell
    const isDaily = days >= 365;
    buildTable('line-chart',
      ['Tidspunkt', 'Forbruk (kWh)', ...(hasCharger ? ['Hus (kWh)', 'Elbil (kWh)'] : []), 'Rullende snitt', 'Temperatur (\u00b0C)'],
      chartData.map((d, i) => [
        fmtTs(d.timestamp, isDaily),
        fmtKwh(d.consumption_kwh),
        ...(hasCharger ? [fmtKwh(d.house_kwh), fmtKwh(d.ev_kwh) + (d.ev_estimated && d.ev_kwh ? ' (anslag)' : '')] : []),
        fmtKwh(rolling[i]?.value),
        fmtTemp(d.outside_temp_c),
      ])
    );

    const scatterPanel = document.getElementById('scatter-chart').closest('.nd-chart');
    if (days >= 365) {
      scatterPanel.hidden = false;
      const scatterData = hasCharger ? asHouse(chartData) : chartData;
      document.getElementById('scatter-note').textContent = hasCharger
        ? 'huset uten elbil, med regresjonslinjer' : 'punkter med regresjonslinjer';
      renderScatterChart(scatterData, coeffs);
      // Scatter-tabell
      const scatterRows = scatterData
        .filter((d) => d.consumption_kwh != null && d.outside_temp_c != null)
        .map((d) => [fmtTemp(d.outside_temp_c), fmtKwh(d.consumption_kwh)]);
      buildTable('scatter-chart', ['Temperatur (\u00b0C)', 'Forbruk (kWh)'], scatterRows);
    } else {
      scatterPanel.hidden = true;
    }

    yoyMode.hidden = !hasCharger;
    if (!hasCharger) yoyHouseOnly = false;
    yoySource = yoyData;
    renderYoy();

    // --- Prognose: kumulativ + forecast ---
    const cumulativePanel = document.getElementById('cumulative-panel');
    const forecastPanel = document.getElementById('forecast-panel');
    let projectedMonthTotal = null;

    try {
      // Finn lat/lon for gjeldende hjem (ved "Alle": bruk første hjem)
      const homeForCoords = currentHomeId === 'all'
        ? homesData[0]
        : homesData.find(h => h.id === currentHomeId);

      const lat = homeForCoords?.lat;
      const lon = homeForCoords?.lon;

      if (coeffs && lat != null && lon != null) {
        const forecastData = await fetchForecast(lat, lon);
        const histTemps = historicalDailyTemps(yoyData);

        // Månedsprojeksjon (brukes av kumulativ graf + månedlig totalforbruk)
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const monthData = yoyData.filter(d => new Date(d.timestamp) >= monthStart);
        const projResult = monthlyProjection(monthData, forecastData, histTemps, coeffsMeter);
        const lastProj = projResult.projected.filter(v => v != null);
        if (lastProj.length > 0) projectedMonthTotal = lastProj[lastProj.length - 1];

        // Kumulativ strømstøtte-graf (kun individuelle hjem)
        if (currentHomeId !== 'all') {
          cumulativePanel.hidden = false;
          document.getElementById('cumulative-note').textContent = hasCharger
            ? `kWh denne måneden mot 5000 kWh, elbil ${(evHourly * 24).toLocaleString('nb-NO', { maximumFractionDigits: 1 })} kWh/døgn (snitt 28 d)`
            : 'kWh denne måneden mot 5000 kWh';
          renderCumulativeChart(projResult);
          buildTable('cumulative-chart',
            ['Dato', 'Daglig (kWh)', 'Faktisk (kWh)', 'Prognose (kWh)', 'Høy (kWh)', 'Lav (kWh)'],
            projResult.dates.map((d, i) => [
              fmtTs(d + 'T00:00:00', true),
              projResult.dailyKwh[i] != null ? Math.round(projResult.dailyKwh[i]).toString() : '\u2013',
              projResult.actual[i] != null ? Math.round(projResult.actual[i]).toString() : '\u2013',
              projResult.projected[i] != null ? Math.round(projResult.projected[i]).toString() : '\u2013',
              projResult.projectedHigh[i] != null ? Math.round(projResult.projectedHigh[i]).toString() : '\u2013',
              projResult.projectedLow[i] != null ? Math.round(projResult.projectedLow[i]).toString() : '\u2013',
            ])
          );
        } else {
          cumulativePanel.hidden = true;
        }

        // Forbruksprognose-graf (alle moduser)
        const timelineResult = forecastTimeline(hasCharger ? houseYoy : yoyData, forecastData, histTemps, coeffs);
        document.getElementById('forecast-note').textContent = hasCharger
          ? 'huset uten elbil, 7 dager tilbake, 21 fremover' : '7 dager tilbake, 21 fremover';
        forecastPanel.hidden = false;
        renderForecastChart(timelineResult);
        buildTable('forecast-chart',
          ['Dato', 'Forbruk (kWh)', 'Prognose (kWh)', 'Temperatur (\u00b0C)', 'Temp.prognose (\u00b0C)'],
          timelineResult.dates.map((d, i) => [
            fmtTs(d + 'T00:00:00', true),
            fmtKwh(timelineResult.actualConsumption[i]),
            fmtKwh(timelineResult.predictedConsumption[i]),
            fmtTemp(timelineResult.actualTemp[i]),
            fmtTemp(timelineResult.forecastTemp[i]),
          ])
        );
      } else {
        cumulativePanel.hidden = true;
        forecastPanel.hidden = true;
      }
    } catch (forecastErr) {
      console.warn('Prognose-beregning feilet:', forecastErr);
      cumulativePanel.hidden = true;
      forecastPanel.hidden = true;
    }

    // Gauge-stats: siste 12 mnd + forventet denne måneden, med endring vs forrige periode
    {
      const statsEl = document.getElementById('gauge-stats');
      const now = new Date();
      const oneYearAgo = new Date(now);
      oneYearAgo.setFullYear(now.getFullYear() - 1);
      const twoYearsAgo = new Date(now);
      twoYearsAgo.setFullYear(now.getFullYear() - 2);

      const yearTotal = yoyData
        .filter(d => d.consumption_kwh != null && new Date(d.timestamp) >= oneYearAgo)
        .reduce((s, d) => s + d.consumption_kwh, 0);
      const prevYearTotal = yoyData
        .filter(d => { const t = new Date(d.timestamp); return d.consumption_kwh != null && t >= twoYearsAgo && t < oneYearAgo; })
        .reduce((s, d) => s + d.consumption_kwh, 0);

      const status = nd.readTokens().status;
      const fmtChange = (curr, prev) => {
        if (!prev) return '';
        const pct = ((curr - prev) / prev) * 100;
        const color = pct <= 0 ? status.ok : status.error;
        const sign = pct > 0 ? '+' : '';
        return `<span style="color:${color}">(${sign}${pct.toFixed(0)} %)</span>`;
      };

      const lines = [`12 mnd: ${Math.round(yearTotal).toLocaleString('nb-NO')} kWh ${fmtChange(yearTotal, prevYearTotal)}`];
      if (hasCharger) {
        const evYear = yoyData
          .filter(d => d.ev_kwh != null && new Date(d.timestamp) >= oneYearAgo)
          .reduce((s, d) => s + d.ev_kwh, 0);
        lines.push(`herav elbil: ${Math.round(evYear).toLocaleString('nb-NO')} kWh`);
      }
      if (projectedMonthTotal != null) {
        const lastYearMonth = yoyData.filter(d => {
          const t = new Date(d.timestamp);
          return d.consumption_kwh != null && t.getMonth() === now.getMonth() && t.getFullYear() === now.getFullYear() - 1;
        });
        const prevMonthTotal = lastYearMonth.reduce((s, d) => s + d.consumption_kwh, 0);
        const monthName = now.toLocaleString('nb-NO', { month: 'short' }).replace('.', '');
        lines.push(`Progn. ${monthName}: ${Math.round(projectedMonthTotal).toLocaleString('nb-NO')} kWh ${fmtChange(projectedMonthTotal, prevMonthTotal)}`);
      }
      statsEl.innerHTML = lines.join('<br>');
    }

    // Månedlig totalforbruk: maks 2 hele foregående år + inneværende
    const mtStart = new Date(new Date().getFullYear() - 2, 0, 1);
    const mtDays = Math.ceil((Date.now() - mtStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const mtData = await fetchData(mtDays, currentHomeId);
    const mt = monthlyTotals(mtData);
    renderMonthlyTotalChart(mt, projectedMonthTotal, currentHomeId !== 'all');
    buildTable('monthly-total-chart',
      ['M\u00e5ned', ...mt.years.map(String)],
      mt.months.map((m, i) => [
        m,
        ...mt.years.map(y => mt.series[y][i] != null ? mt.series[y][i].toLocaleString('nb-NO') : '\u2013'),
      ])
    );

    const evPanel = document.getElementById('ev-monthly-panel');
    const evMonths = hasCharger ? evMonthly(mtData) : [];
    evPanel.hidden = evMonths.length === 0;
    if (evMonths.length > 0) {
      renderEvMonthlyChart(evMonths);
      buildTable('ev-monthly-chart',
        ['M\u00e5ned', 'Eksakt (kWh)', 'Anslag (kWh)', 'Sum (kWh)'],
        evMonths.map(m => [m.month, Math.round(m.exact).toString(), Math.round(m.estimated).toString(), Math.round(m.exact + m.estimated).toString()])
      );
    }

    const heatmapPanel = document.getElementById('heatmap-chart').closest('.nd-chart');
    const weekdayPanel = document.getElementById('weekday-chart').closest('.nd-chart');
    if (days >= 365) {
      heatmapPanel.hidden = false;
      weekdayPanel.hidden = false;
      renderHeatmap(heatmap);
      renderWeekdayChart(weekday);
      // Heatmap-tabell
      buildTable('heatmap-chart',
        ['Ukedag', 'Klokketime', 'Forbruk (kWh)'],
        heatmap.map((d) => [WEEKDAYS[d[1]], String(d[0]).padStart(2, '0') + ':00', fmtKwh(d[2])])
      );
      // Ukedag-tabell
      buildTable('weekday-chart',
        ['Ukedag', 'Snitt (kWh)'],
        weekday.map((d) => [d.day, fmtKwh(d.avg)])
      );
    } else {
      heatmapPanel.hidden = true;
      weekdayPanel.hidden = true;
    }

    announce(`Data lastet for ${periodLabels[days] || days + ' dager'}`);
  } catch (err) {
    console.error('Failed to load data:', err);
    loading.textContent = 'Feil ved lasting av data.';
  }
}

// --- Resize ---
window.addEventListener('resize', handleResize);

// --- Theme ---
// The charts are built directly with ECharts (not nd.mount), and ECharts binds
// the theme at init, so a theme change means re-running the render pass.
ndTheme.init();
ndTheme.mount(document.getElementById('theme-toggle'));
nd.onThemeChange(() => { if (!dashboard.hidden) loadData(currentDays); });

// --- Init ---
// Cloudflare Access guards the page (server.mjs checks its token), so show the dashboard straight away.
showDashboard();
