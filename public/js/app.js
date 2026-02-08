import { sb, getSession, signIn, signOut } from './auth.js';
import { fetchData, clearCache, rollingAverage, dailyAverage, avgByWeekday, heatmapData } from './data.js';
import {
  renderGauge,
  renderLineChart,
  renderScatterChart,
  renderHeatmap,
  renderWeekdayChart,
  handleResize,
} from './charts.js';

const loginScreen = document.getElementById('login-screen');
const dashboard = document.getElementById('dashboard');
const loading = document.getElementById('loading');
const emptyState = document.getElementById('empty-state');
const chartsContainer = document.getElementById('charts-container');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const periodSelector = document.getElementById('period-selector');

let currentDays = 7;

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

// --- Period selector ---
periodSelector.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-days]');
  if (!btn) return;

  const days = parseInt(btn.dataset.days);
  if (days === currentDays) return;

  currentDays = days;
  periodSelector.querySelectorAll('.period-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  loadData(days);
});

// --- App flow ---
function showLogin() {
  loginScreen.classList.remove('hidden');
  dashboard.classList.add('hidden');
}

function showDashboard() {
  loginScreen.classList.add('hidden');
  dashboard.classList.remove('hidden');
  loadData(currentDays);
}

async function loadData(days) {
  loading.classList.remove('hidden');
  emptyState.classList.add('hidden');
  chartsContainer.classList.add('hidden');

  try {
    const data = await fetchData(days);

    if (data.length === 0) {
      loading.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }

    loading.classList.add('hidden');
    chartsContainer.classList.remove('hidden');

    const chartData = days >= 365 ? dailyAverage(data) : data;
    const rolling = rollingAverage(chartData, days >= 365 ? 7 : 24);
    const weekday = avgByWeekday(data);
    const heatmap = heatmapData(data);

    renderGauge(data);
    renderLineChart(chartData, rolling, days);
    renderScatterChart(chartData);
    renderHeatmap(heatmap);
    renderWeekdayChart(weekday);
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
