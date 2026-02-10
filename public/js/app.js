import { sb, getSession, signIn, signOut } from './auth.js';
import { fetchData, clearCache, fillMissingHours, rollingAverage, dailyAverage, yearOverYear, avgByWeekday, heatmapData } from './data.js';
import {
  renderGauge,
  renderLineChart,
  renderScatterChart,
  renderYoyChart,
  renderMonthlyChangeChart,
  renderHeatmap,
  renderWeekdayChart,
  clearCharts,
  handleResize,
} from './charts.js';

const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('main-content');
const loading = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const chartsContainer = document.getElementById('charts-container');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const periodSelector = document.getElementById('period-selector');

// --- URL-state ---
const VALID_DAYS = [1, 7, 28, 365];

function readUrlState() {
  const params = new URLSearchParams(window.location.search);
  const days = parseInt(params.get('days'));
  const home = params.get('home');
  return {
    days: VALID_DAYS.includes(days) ? days : 1,
    home: home || 'all',
  };
}

function updateUrl() {
  const params = new URLSearchParams();
  if (currentDays !== 1) params.set('days', currentDays);
  if (currentHomeId !== 'all') params.set('home', currentHomeId);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : window.location.pathname);
}

const initialState = readUrlState();
let currentDays = initialState.days;
let currentHomeId = initialState.home;

// --- Datatabell ---
const WEEKDAYS = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];

function buildTable(chartId, headers, rows) {
  const section = document.getElementById(chartId).closest('section');
  const container = section.querySelector('.chart-table');
  if (!container) return;
  const thead = headers.map((h) => `<th>${h}</th>`).join('');
  const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  container.innerHTML = `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
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

// Toggle-handler (event delegation)
chartsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.table-toggle');
  if (!btn) return;
  const container = btn.closest('section').querySelector('.chart-table');
  const isHidden = container.classList.toggle('hidden');
  btn.textContent = isHidden ? 'Vis datatabell' : 'Skjul datatabell';
  btn.setAttribute('aria-expanded', String(!isHidden));
});

// --- Skjermleser-annonseringer ---
function announce(message) {
  const el = document.getElementById('sr-announcements');
  if (!el) return;
  el.textContent = message;
  setTimeout(() => { el.textContent = ''; }, 1000);
}

// --- Auth ---
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginError.classList.add('hidden');

  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const error = await signIn(email, password);

  if (error) {
    loginError.textContent = error.message;
    loginError.classList.remove('hidden');
  } else {
    showDashboard();
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOut();
  showLogin();
});

document.getElementById('refresh-btn').addEventListener('click', () => {
  clearCache();
  loadData(currentDays);
});

// --- Home selector ---
document.getElementById('home-selector').addEventListener('change', (e) => {
  currentHomeId = e.target.value;
  updateUrl();
  clearCache();
  announce(`Viser ${e.target.options[e.target.selectedIndex].textContent}`);
  loadData(currentDays);
});

async function loadHomes() {
  const { data } = await sb.from('homes').select('id, name, sort_order').order('sort_order');
  const selector = document.getElementById('home-selector');
  selector.innerHTML = '';
  selector.add(new Option('Alle', 'all'));
  if (data) {
    for (const home of data) selector.add(new Option(home.name, home.id));
  }
  selector.value = currentHomeId;
}

// --- Period selector ---
const periodLabels = { 1: '24 timer', 7: '7 dager', 28: '28 dager', 365: '1 år' };

function syncPeriodButtons() {
  periodSelector.querySelectorAll('.period-btn').forEach((b) => {
    const active = parseInt(b.dataset.days) === currentDays;
    b.classList.toggle('active', active);
    b.setAttribute('aria-current', String(active));
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

// --- App flow ---
function showLogin() {
  loginScreen.classList.remove('hidden');
  dashboard.classList.add('hidden');
  const emailInput = document.getElementById('login-email');
  if (emailInput) setTimeout(() => emailInput.focus(), 100);
}

async function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboard.classList.remove('hidden');
  const heading = dashboard.querySelector('h1');
  if (heading) setTimeout(() => heading.focus(), 100);
  await loadHomes();
  syncPeriodButtons();
  loadData(currentDays);
}

async function loadData(days) {
  clearCharts();
  loading.classList.remove('hidden');
  emptyState.classList.add('hidden');
  chartsContainer.classList.add('hidden');
  announce('Henter data...');

  try {
    const data = await fetchData(days, currentHomeId);

    if (data.length === 0) {
      loading.classList.add('hidden');
      emptyState.classList.remove('hidden');
      announce('Ingen data funnet');
      return;
    }

    loading.classList.add('hidden');
    chartsContainer.classList.remove('hidden');

    const filled = days < 365 ? fillMissingHours(data, days) : data;
    const chartData = days >= 365 ? dailyAverage(data) : filled;
    const rolling = rollingAverage(chartData, days >= 365 ? 7 : 24);
    const weekday = avgByWeekday(data);
    const heatmap = heatmapData(data);

    // YoY: alltid fullt år, uavhengig av valgt periode
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const yoyDays = Math.ceil((Date.now() - twoYearsAgo.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const yoyData = await fetchData(yoyDays, currentHomeId);
    const yoy = yearOverYear(yoyData, 365);

    renderGauge(data, days);
    renderLineChart(chartData, rolling, days);

    // Linjegraf-tabell
    const isDaily = days >= 365;
    buildTable('line-chart',
      ['Tidspunkt', 'Forbruk (kWh)', 'Rullende snitt', 'Temperatur (\u00b0C)'],
      chartData.map((d, i) => [
        fmtTs(d.timestamp, isDaily),
        fmtKwh(d.consumption_kwh),
        fmtKwh(rolling[i]?.value),
        fmtTemp(d.outside_temp_c),
      ])
    );

    const scatterPanel = document.getElementById('scatter-chart').closest('.panel');
    if (days >= 365) {
      scatterPanel.classList.remove('hidden');
      renderScatterChart(chartData);
      // Scatter-tabell
      const scatterRows = chartData
        .filter((d) => d.consumption_kwh != null && d.outside_temp_c != null)
        .map((d) => [fmtTemp(d.outside_temp_c), fmtKwh(d.consumption_kwh)]);
      buildTable('scatter-chart', ['Temperatur (\u00b0C)', 'Forbruk (kWh)'], scatterRows);
    } else {
      scatterPanel.classList.add('hidden');
    }

    renderYoyChart(yoy);
    renderMonthlyChangeChart(yoy.monthlyChange);

    // YoY-tabell
    buildTable('yoy-chart',
      ['Dato', 'Siste \u00e5r (kWh)', 'Forrige periode (kWh)'],
      yoy.labels.map((label, i) => [
        fmtTs(label + 'T00:00:00', true),
        fmtKwh(yoy.current[i]),
        fmtKwh(yoy.previous[i]),
      ])
    );

    // Månedlig endring-tabell
    buildTable('monthly-change-chart',
      ['M\u00e5ned', 'Endring (%)'],
      yoy.monthlyChange.map((d) => [d.month, fmtPct(d.pct)])
    );

    const heatmapPanel = document.getElementById('heatmap-chart').closest('.panel');
    const weekdayPanel = document.getElementById('weekday-chart').closest('.panel');
    if (days >= 365) {
      heatmapPanel.classList.remove('hidden');
      weekdayPanel.classList.remove('hidden');
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
      heatmapPanel.classList.add('hidden');
      weekdayPanel.classList.add('hidden');
    }

    announce(`Data lastet for ${periodLabels[days] || days + ' dager'}`);
  } catch (err) {
    console.error('Failed to load data:', err);
    loading.textContent = 'Feil ved lasting av data.';
  }
}

// --- Resize ---
window.addEventListener('resize', handleResize);

// --- Init ---
async function init() {
  const session = await getSession();
  if (session) {
    showDashboard();
  } else {
    showLogin();
  }
}

// Lytt på auth-endringer (f.eks. etter redirect)
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session) {
    showDashboard();
  } else if (event === 'SIGNED_OUT') {
    showLogin();
  }
});

init();
