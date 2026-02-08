import { sb } from './auth.js';

const CACHE_TTL = 60 * 60 * 1000; // 1 time
const CACHE_PREFIX = 'energy_';

export function clearCache() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
  }
}

function getCache(days) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + days);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.ts < CACHE_TTL) return cached.data;
    localStorage.removeItem(CACHE_PREFIX + days);
  } catch {}
  return null;
}

function setCache(days, data) {
  try {
    localStorage.setItem(CACHE_PREFIX + days, JSON.stringify({ data, ts: Date.now() }));
  } catch {}
}

export async function fetchData(days) {
  const cached = getCache(days);
  if (cached) return cached;

  const since = new Date();
  since.setDate(since.getDate() - days);

  const all = [];
  const pageSize = 1000;
  let from = 0;

  while (true) {
    const { data, error } = await sb
      .from('consumption')
      .select('timestamp, consumption_kwh, outside_temp_c')
      .gte('timestamp', since.toISOString())
      .order('timestamp', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  setCache(days, all);
  return all;
}

export function rollingAverage(data, windowSize = 24) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const window = data.slice(start, i + 1);
    const sum = window.reduce((s, d) => s + d.consumption_kwh, 0);
    result.push({
      timestamp: data[i].timestamp,
      value: sum / window.length,
    });
  }
  return result;
}

export function dailyAverage(data) {
  const buckets = new Map();

  for (const d of data) {
    const day = d.timestamp.slice(0, 10); // "YYYY-MM-DD"
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(d);
  }

  return [...buckets.entries()].map(([day, rows]) => ({
    timestamp: day + 'T12:00:00',
    consumption_kwh: rows.reduce((s, r) => s + r.consumption_kwh, 0) / rows.length,
    outside_temp_c: rows.some((r) => r.outside_temp_c != null)
      ? rows.filter((r) => r.outside_temp_c != null).reduce((s, r) => s + r.outside_temp_c, 0) /
        rows.filter((r) => r.outside_temp_c != null).length
      : null,
  }));
}

export function avgByWeekday(data) {
  const days = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];
  const buckets = Array.from({ length: 7 }, () => []);

  for (const d of data) {
    const day = new Date(d.timestamp).getDay();
    buckets[day].push(d.consumption_kwh);
  }

  // Rekkefølge: man-søn
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.map((i) => ({
    day: days[i],
    avg: buckets[i].length > 0
      ? buckets[i].reduce((s, v) => s + v, 0) / buckets[i].length
      : 0,
  }));
}

export function heatmapData(data) {
  // [ukedag (0=man), klokketime, snittverdi]
  const buckets = {};

  for (const d of data) {
    const dt = new Date(d.timestamp);
    let day = dt.getDay() - 1; // 0=man, 6=søn
    if (day < 0) day = 6;
    const hour = dt.getHours();
    const key = `${day}-${hour}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(d.consumption_kwh);
  }

  const result = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const key = `${day}-${hour}`;
      const vals = buckets[key] || [];
      const avg = vals.length > 0
        ? vals.reduce((s, v) => s + v, 0) / vals.length
        : 0;
      result.push([hour, day, +avg.toFixed(3)]);
    }
  }
  return result;
}
