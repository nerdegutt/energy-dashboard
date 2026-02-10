import { sb } from './auth.js';

const CACHE_TTL = 60 * 60 * 1000; // 1 time
const CACHE_PREFIX = 'energy_v3_';

// Rydd opp gamle cache-oppføringer
try {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('energy_') && !key.startsWith('energy_v3_')) {
      localStorage.removeItem(key);
    }
  }
} catch {}

export function clearCache() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
  }
}

// Kompakt cache: [YYYYMMDDHH, kwh, temp] i stedet for fulle objekter
function packRows(rows) {
  return rows.map(r => {
    const t = r.timestamp.replace(/[-T:]/g, '').slice(0, 10);
    return [t, r.consumption_kwh, r.outside_temp_c];
  });
}

function unpackRows(packed) {
  return packed.map(([t, kwh, temp]) => ({
    timestamp: `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:00:00.000Z`,
    consumption_kwh: kwh,
    outside_temp_c: temp,
  }));
}

function getCache(days, homeId) {
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${homeId}_${days}`);
    if (!raw) return null;
    const cached = JSON.parse(raw);
    if (Date.now() - cached.ts < CACHE_TTL) return cached.data ? unpackRows(cached.data) : null;
    localStorage.removeItem(`${CACHE_PREFIX}${homeId}_${days}`);
  } catch {}
  return null;
}

function setCache(days, homeId, data) {
  try {
    localStorage.setItem(`${CACHE_PREFIX}${homeId}_${days}`, JSON.stringify({ data: packRows(data), ts: Date.now() }));
  } catch {}
}

function mergeHomes(rows) {
  const grouped = new Map();
  for (const r of rows) {
    const key = r.timestamp;
    if (!grouped.has(key)) {
      grouped.set(key, { timestamp: key, kwh: [], temp: null });
    }
    const g = grouped.get(key);
    if (r.consumption_kwh != null) g.kwh.push(r.consumption_kwh);
    if (r.outside_temp_c != null && g.temp == null) g.temp = r.outside_temp_c;
  }
  return [...grouped.values()]
    .map((g) => ({
      timestamp: g.timestamp,
      consumption_kwh: g.kwh.length > 0 ? g.kwh.reduce((s, v) => s + v, 0) : null,
      outside_temp_c: g.temp,
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

async function fetchSingleHome(days, homeId) {
  const cached = getCache(days, homeId);
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
      .eq('home_id', homeId)
      .gte('timestamp', since.toISOString())
      .order('timestamp', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    all.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  setCache(days, homeId, all);
  return all;
}

export async function fetchData(days, homeId = 'all') {
  if (homeId === 'all') {
    const { data: homes } = await sb.from('homes').select('id').order('sort_order');
    if (!homes || homes.length === 0) return [];
    const perHome = await Promise.all(homes.map(h => fetchSingleHome(days, h.id)));
    return mergeHomes(perHome.flat());
  }

  return fetchSingleHome(days, homeId);
}

export function fillMissingHours(data, days) {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const start = new Date(now);
  start.setDate(start.getDate() - days);

  const lookup = new Map();
  for (const d of data) {
    const key = d.timestamp.slice(0, 13); // "YYYY-MM-DDTHH"
    lookup.set(key, d);
  }

  const result = [];
  const cursor = new Date(start);
  while (cursor <= now) {
    const key = cursor.toISOString().slice(0, 13);
    if (lookup.has(key)) {
      result.push(lookup.get(key));
    } else {
      result.push({
        timestamp: cursor.toISOString(),
        consumption_kwh: null,
        outside_temp_c: null,
      });
    }
    cursor.setHours(cursor.getHours() + 1);
  }
  return result;
}

export function rollingAverage(data, windowSize = 24) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - windowSize + 1);
    const window = data.slice(start, i + 1).filter((d) => d.consumption_kwh != null);
    if (window.length === 0) {
      result.push({ timestamp: data[i].timestamp, value: null });
    } else {
      const sum = window.reduce((s, d) => s + d.consumption_kwh, 0);
      result.push({ timestamp: data[i].timestamp, value: sum / window.length });
    }
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

  return [...buckets.entries()].map(([day, rows]) => {
    const validKwh = rows.filter((r) => r.consumption_kwh != null);
    const validTemp = rows.filter((r) => r.outside_temp_c != null);
    return {
      timestamp: day + 'T12:00:00',
      consumption_kwh: validKwh.length > 0
        ? validKwh.reduce((s, r) => s + r.consumption_kwh, 0) / validKwh.length
        : null,
      outside_temp_c: validTemp.length > 0
        ? validTemp.reduce((s, r) => s + r.outside_temp_c, 0) / validTemp.length
        : null,
    };
  });
}

export function yearOverYear(data, days) {
  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setDate(periodStart.getDate() - days);

  // Forrige periode: nøyaktig 1 år tilbake (håndterer skuddår)
  const prevEnd = new Date(now);
  prevEnd.setFullYear(prevEnd.getFullYear() - 1);
  const prevStart = new Date(periodStart);
  prevStart.setFullYear(prevStart.getFullYear() - 1);

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  const fmtDate = (d) => `${d.getDate()}.${MONTHS[d.getMonth()]} ${String(d.getFullYear()).slice(2)}`;
  const fmtRange = (from, to) => `${fmtDate(from)} – ${fmtDate(to)}`;

  const current = data.filter((d) => {
    const t = new Date(d.timestamp);
    return t >= periodStart && t <= now;
  });
  const previous = data.filter((d) => {
    const t = new Date(d.timestamp);
    return t >= prevStart && t < prevEnd;
  });

  const avg = (arr) => arr && arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null;

  // Grupper per dato (YYYY-MM-DD) → dagsnitt
  const toDailyMap = (rows) => {
    const buckets = new Map();
    for (const r of rows) {
      if (r.consumption_kwh == null) continue;
      const day = r.timestamp.slice(0, 10);
      if (!buckets.has(day)) buckets.set(day, []);
      buckets.get(day).push(r.consumption_kwh);
    }
    const result = new Map();
    for (const [day, vals] of buckets) {
      result.set(day, vals.reduce((s, v) => s + v, 0) / vals.length);
    }
    return result;
  };

  const currentDaily = toDailyMap(current);
  const previousDaily = toDailyMap(previous);

  // Kronologisk liste av datoer i nåværende periode (nå helt til høyre)
  const currentDates = [...currentDaily.keys()].sort();

  const labels = [];
  const currentVals = [];
  const previousVals = [];

  for (const dateStr of currentDates) {
    labels.push(dateStr); // YYYY-MM-DD sorterer kronologisk
    currentVals.push(currentDaily.get(dateStr) ?? null);
    // Finn tilsvarende dato 1 år tilbake
    const d = new Date(dateStr);
    d.setFullYear(d.getFullYear() - 1);
    const prevDateStr = d.toISOString().slice(0, 10);
    previousVals.push(previousDaily.get(prevDateStr) ?? null);
  }

  // 14-dagers sentrert rullende snitt (±7 dager)
  const rolling = (vals) => {
    const half = 7;
    return vals.map((_, i) => {
      const start = Math.max(0, i - half);
      const end = Math.min(vals.length, i + half + 1);
      const window = vals.slice(start, end).filter((v) => v != null);
      return window.length > 0 ? window.reduce((s, v) => s + v, 0) / window.length : null;
    });
  };

  // Prosentvis endring per måned (med årstall for korrekt matching)
  const monthlyChange = () => {
    const bucket = (rows) => {
      const m = {};
      for (const r of rows) {
        if (r.consumption_kwh == null) continue;
        const d = new Date(r.timestamp);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (!m[key]) m[key] = [];
        m[key].push(r.consumption_kwh);
      }
      return m;
    };
    const curMonths = bucket(current);
    const prevMonths = bucket(previous);

    // Kronologisk sorterte år-måneder fra current
    const curKeys = Object.keys(curMonths).sort();

    return curKeys.map((key) => {
      const [y, m] = key.split('-').map(Number);
      const prevKey = `${y - 1}-${String(m).padStart(2, '0')}`;
      const curAvg = avg(curMonths[key]);
      const prevAvg = avg(prevMonths[prevKey]);
      const prevLabel = `${MONTHS[m - 1]} ${String(y - 1).slice(2)}`;
      if (curAvg == null || prevAvg == null || prevAvg === 0) {
        return { month: `${MONTHS[m - 1]} ${String(y).slice(2)}`, prevMonth: prevLabel, pct: null };
      }
      return { month: `${MONTHS[m - 1]} ${String(y).slice(2)}`, prevMonth: prevLabel, pct: ((curAvg - prevAvg) / prevAvg) * 100 };
    }).filter((d) => d.pct != null);
  };

  return {
    labels,
    current: rolling(currentVals),
    previous: rolling(previousVals),
    monthlyChange: monthlyChange(),
    currentLabel: fmtRange(periodStart, now),
    previousLabel: fmtRange(prevStart, prevEnd),
  };
}

export function avgByWeekday(data) {
  const days = ['Søn', 'Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør'];
  const buckets = Array.from({ length: 7 }, () => []);

  for (const d of data) {
    if (d.consumption_kwh == null) continue;
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
    if (d.consumption_kwh == null) continue;
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
