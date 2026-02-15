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
  since.setMinutes(0, 0, 0);
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
  if (data.length === 0) return data;

  // Start fra første datapunkt, slutt ved siste hele time (forrige time)
  const first = new Date(data[0].timestamp);
  first.setMinutes(0, 0, 0);

  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() - 1);

  const lookup = new Map();
  for (const d of data) {
    const key = d.timestamp.slice(0, 13); // "YYYY-MM-DDTHH"
    lookup.set(key, d);
  }

  const result = [];
  const cursor = new Date(first);
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

export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function solveLinearSystem(A, b) {
  const n = A.length;
  // Augmented matrix
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > maxVal) {
        maxVal = Math.abs(M[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return null; // Singular
    if (maxRow !== col) [M[col], M[maxRow]] = [M[maxRow], M[col]];

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }

  // Back substitution
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j];
    x[i] /= M[i][i];
  }
  return x;
}

export function seasonalRegression(points) {
  // points: [[temp, doy, kwh], ...]
  // Model: kwh = a + b*T + c*T² + d*sin(2π*doy/365) + e*cos(2π*doy/365)
  const n = points.length;
  if (n < 6) return null;

  const TWO_PI_365 = (2 * Math.PI) / 365;

  // Build X'X (5x5) and X'y (5)
  const XtX = Array.from({ length: 5 }, () => new Array(5).fill(0));
  const Xty = new Array(5).fill(0);

  for (const [temp, doy, kwh] of points) {
    const t2 = temp * temp;
    const sinD = Math.sin(TWO_PI_365 * doy);
    const cosD = Math.cos(TWO_PI_365 * doy);
    const row = [1, temp, t2, sinD, cosD];

    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) XtX[i][j] += row[i] * row[j];
      Xty[i] += row[i] * kwh;
    }
  }

  const sol = solveLinearSystem(XtX, Xty);
  if (!sol) return null;
  return { a: sol[0], b: sol[1], c: sol[2], d: sol[3], e: sol[4] };
}

export function robustSeasonalRegression(points, madThreshold = 3) {
  const first = seasonalRegression(points);
  if (!first) return null;

  const TWO_PI_365 = (2 * Math.PI) / 365;
  const predict = (temp, doy) =>
    first.a + first.b * temp + first.c * temp * temp +
    first.d * Math.sin(TWO_PI_365 * doy) + first.e * Math.cos(TWO_PI_365 * doy);

  // Compute residuals
  const residuals = points.map(([temp, doy, kwh]) => Math.abs(kwh - predict(temp, doy)));

  // MAD (median absolute deviation)
  const sorted = [...residuals].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[Math.floor(sorted.length / 2)];
  const mad = median * 1.4826; // Scale to approximate std dev

  if (mad < 1e-10) return { ...first, removedCount: 0 };

  const threshold = madThreshold * mad;
  const filtered = points.filter(([temp, doy, kwh]) =>
    Math.abs(kwh - predict(temp, doy)) <= threshold
  );
  const removedCount = points.length - filtered.length;

  if (filtered.length < 6) return { ...first, removedCount: 0 };

  const refined = seasonalRegression(filtered);
  if (!refined) return { ...first, removedCount: 0 };
  return { ...refined, removedCount };
}

export function makePredictFn(coeffs) {
  if (!coeffs) return null;
  const { a, b, c, d, e } = coeffs;
  if (d != null && e != null) {
    const TWO_PI_365 = (2 * Math.PI) / 365;
    return (temp, doy) => Math.max(0,
      a + b * temp + c * temp * temp +
      d * Math.sin(TWO_PI_365 * doy) + e * Math.cos(TWO_PI_365 * doy)
    );
  }
  // Fallback for old 3-coeff format
  return (temp) => Math.max(0, a + b * temp + c * temp * temp);
}

export function quadraticRegression(points) {
  const n = points.length;
  let sx = 0, sx2 = 0, sx3 = 0, sx4 = 0, sy = 0, sxy = 0, sx2y = 0;
  for (const [x, y] of points) {
    const x2 = x * x;
    sx += x; sx2 += x2; sx3 += x2 * x; sx4 += x2 * x2;
    sy += y; sxy += x * y; sx2y += x2 * y;
  }
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

export function consumptionDeviation(data, coeffs) {
  if (!coeffs || data.length === 0) return null;
  const predict = makePredictFn(coeffs);
  if (!predict) return null;

  const latest = new Date(data[data.length - 1].timestamp);
  const cutoff = new Date(latest);
  cutoff.setHours(cutoff.getHours() - 24);

  const recent = data.filter(d => {
    const t = new Date(d.timestamp);
    return t >= cutoff && d.consumption_kwh != null && d.outside_temp_c != null;
  });

  if (recent.length < 6) return null;

  let actual = 0, expected = 0;
  for (const d of recent) {
    actual += d.consumption_kwh;
    const dt = new Date(d.timestamp);
    expected += predict(d.outside_temp_c, dayOfYear(dt));
  }

  if (expected === 0) return null;
  return ((actual - expected) / expected) * 100;
}

// --- Prognose-funksjoner ---

export async function fetchForecast(lat, lon) {
  try {
    const cacheKey = `${CACHE_PREFIX}forecast_${lat}_${lon}`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const cached = JSON.parse(raw);
        if (Date.now() - cached.ts < CACHE_TTL) return cached.data;
        localStorage.removeItem(cacheKey);
      }
    } catch {}

    const resp = await fetch(`/api/forecast?lat=${lat}&lon=${lon}`, { cache: 'no-cache' });
    if (!resp.ok) return null;
    const json = await resp.json();
    // { hourly: [{ time, temp, temp_p10, temp_p90 }], daily: [{ date, temp_mean, temp_p10, temp_p90 }] }
    const result = { hourly: json.hourly || [], daily: json.daily || [] };

    try {
      localStorage.setItem(cacheKey, JSON.stringify({ data: result, ts: Date.now() }));
    } catch {}

    return result;
  } catch (err) {
    console.warn('fetchForecast failed:', err.message);
    return null;
  }
}

export function historicalDailyTemps(data) {
  const buckets = new Map();
  for (const d of data) {
    if (d.outside_temp_c == null) continue;
    const dt = new Date(d.timestamp);
    const key = `${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(d.outside_temp_c);
  }
  const result = new Map();
  for (const [key, vals] of buckets) {
    result.set(key, vals.reduce((s, v) => s + v, 0) / vals.length);
  }
  return result;
}

export function monthlyProjection(monthData, forecast, historicalTemps, coeffs) {
  const LIMIT = 5000;
  const predict = makePredictFn(coeffs);

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const todayDate = now.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  // Build hourly forecast lookup: "YYYY-MM-DDTHH" → { temp, p10, p90 }
  const hourlyMap = new Map();
  if (forecast?.hourly) {
    for (const h of forecast.hourly) {
      const key = h.time.slice(0, 13); // "YYYY-MM-DDTHH"
      hourlyMap.set(key, h);
    }
  }

  // Build daily forecast lookup: date string → { temp_mean, temp_p10, temp_p90 }
  const dailyMap = new Map();
  if (forecast?.daily) {
    for (const d of forecast.daily) dailyMap.set(d.date, d);
  }

  // Aggregate actual daily consumption from monthData
  const actualDaily = new Map();
  for (const d of monthData) {
    if (d.consumption_kwh == null) continue;
    const day = new Date(d.timestamp).getDate();
    actualDaily.set(day, (actualDaily.get(day) || 0) + d.consumption_kwh);
  }

  const dates = [];
  const actual = [];
  const projected = [];
  const projectedHigh = [];
  const projectedLow = [];
  const dailyKwh = [];

  let cumActual = 0;
  let cumProjected = 0;
  let cumHigh = 0;
  let cumLow = 0;

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    dates.push(dateStr);

    if (day < todayDate) {
      const dayVal = actualDaily.get(day) || 0;
      cumActual += dayVal;
      actual.push(cumActual);
      projected.push(null);
      projectedHigh.push(null);
      projectedLow.push(null);
      dailyKwh.push(dayVal);
    } else if (day === todayDate) {
      // I dag: faktisk forbruk + predikert for gjenstående timer
      const actualSoFar = actualDaily.get(day) || 0;
      const currentHour = now.getHours();

      // Tell timer med faktisk data i dag
      const todayHours = new Set();
      for (const d of monthData) {
        const dt = new Date(d.timestamp);
        if (dt.getDate() === todayDate && d.consumption_kwh != null) {
          todayHours.add(dt.getHours());
        }
      }
      const hoursWithData = todayHours.size || currentHour;

      // Prediker gjenstående timer
      let remainingKwh = 0;
      const remainingHours = 24 - Math.max(hoursWithData, currentHour);
      const doy = dayOfYear(new Date(dateStr));
      if (remainingHours > 0) {
        for (let h = 24 - remainingHours; h < 24; h++) {
          const hKey = `${dateStr}T${String(h).padStart(2, '0')}`;
          const hf = hourlyMap.get(hKey);
          const t = hf?.temp ?? (dailyMap.get(dateStr)?.temp_mean ?? historicalTemps.get(`${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`) ?? 5);
          remainingKwh += predict(t, doy);
        }
      }

      const dayTotal = actualSoFar + remainingKwh;
      cumActual += dayTotal;
      actual.push(cumActual);
      cumProjected = cumActual;
      cumHigh = cumActual;
      cumLow = cumActual;
      projected.push(cumProjected);
      projectedHigh.push(cumHigh);
      projectedLow.push(cumLow);
      dailyKwh.push(dayTotal);
    } else {
      actual.push(null);

      // Samle timedata for denne dagen
      const dayHourly = [];
      for (let h = 0; h < 24; h++) {
        const hKey = `${dateStr}T${String(h).padStart(2, '0')}`;
        if (hourlyMap.has(hKey)) dayHourly.push(hourlyMap.get(hKey));
      }

      const doyFuture = dayOfYear(new Date(dateStr));
      let dayPredicted;
      if (dayHourly.length >= 20) {
        let dayMean = 0, dayHigh = 0, dayLow = 0;
        for (const hf of dayHourly) {
          const t = hf.temp ?? 5;
          const tp10 = hf.temp_p10 ?? t - 3;
          const tp90 = hf.temp_p90 ?? t + 3;
          dayMean += predict(t, doyFuture);
          dayHigh += predict(tp10, doyFuture);
          dayLow += predict(tp90, doyFuture);
        }
        const scale = 24 / dayHourly.length;
        dayPredicted = dayMean * scale;
        cumProjected += dayPredicted;
        cumHigh += dayHigh * scale;
        cumLow += dayLow * scale;
      } else {
        const fc = dailyMap.get(dateStr);
        const mmdd = `${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const tempMean = fc?.temp_mean ?? historicalTemps.get(mmdd) ?? 5;
        const tempP10 = fc?.temp_p10 ?? tempMean - 3;
        const tempP90 = fc?.temp_p90 ?? tempMean + 3;
        dayPredicted = predict(tempMean, doyFuture) * 24;
        cumProjected += dayPredicted;
        cumHigh += predict(tempP10, doyFuture) * 24;
        cumLow += predict(tempP90, doyFuture) * 24;
      }
      projected.push(cumProjected);
      projectedHigh.push(cumHigh);
      projectedLow.push(cumLow);
      dailyKwh.push(dayPredicted);
    }
  }

  return {
    dates,
    actual,
    projected,
    projectedHigh,
    projectedLow,
    dailyKwh,
    limit: LIMIT,
    willExceed: (cumProjected || cumActual) > LIMIT,
    projectedTotal: cumProjected || cumActual,
  };
}

export function forecastTimeline(recentData, forecast, historicalTemps, coeffs) {
  const predict = makePredictFn(coeffs);

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  // Build hourly forecast lookup: "YYYY-MM-DDTHH" → { temp, p10, p90 }
  const hourlyMap = new Map();
  if (forecast?.hourly) {
    for (const h of forecast.hourly) {
      const key = h.time.slice(0, 13);
      hourlyMap.set(key, h);
    }
  }

  // Build daily forecast lookup
  const dailyMap = new Map();
  if (forecast?.daily) {
    for (const d of forecast.daily) dailyMap.set(d.date, d);
  }

  const pastDays = 7;
  const futureDays = 21;

  // Aggregate recent data into daily buckets
  const dailyBuckets = new Map();
  for (const d of recentData) {
    const dt = new Date(d.timestamp);
    const dayStr = dt.toISOString().slice(0, 10);
    if (!dailyBuckets.has(dayStr)) dailyBuckets.set(dayStr, { kwh: [], temp: [] });
    const bucket = dailyBuckets.get(dayStr);
    if (d.consumption_kwh != null) bucket.kwh.push(d.consumption_kwh);
    if (d.outside_temp_c != null) bucket.temp.push(d.outside_temp_c);
  }

  const dates = [];
  const actualConsumption = [];
  const predictedConsumption = [];
  const predictedHigh = [];
  const predictedLow = [];
  const actualTemp = [];
  const forecastTemp = [];
  const forecastTempP10 = [];
  const forecastTempP90 = [];

  // Past 7 days
  for (let i = pastDays; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    dates.push(dateStr);

    const bucket = dailyBuckets.get(dateStr);
    const totalKwh = bucket?.kwh.length > 0
      ? bucket.kwh.reduce((s, v) => s + v, 0)
      : null;
    const avgTemp = bucket?.temp.length > 0
      ? bucket.temp.reduce((s, v) => s + v, 0) / bucket.temp.length
      : null;

    actualConsumption.push(totalKwh);
    actualTemp.push(avgTemp);

    if (i === 0) {
      predictedConsumption.push(totalKwh);
      predictedHigh.push(totalKwh);
      predictedLow.push(totalKwh);
      forecastTemp.push(avgTemp);
      forecastTempP10.push(avgTemp);
      forecastTempP90.push(avgTemp);
    } else {
      predictedConsumption.push(null);
      predictedHigh.push(null);
      predictedLow.push(null);
      forecastTemp.push(null);
      forecastTempP10.push(null);
      forecastTempP90.push(null);
    }
  }

  // Future 21 days
  for (let i = 1; i <= futureDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    dates.push(dateStr);

    actualConsumption.push(null);
    actualTemp.push(null);

    // Samle timedata for denne dagen
    const dayHourly = [];
    for (let h = 0; h < 24; h++) {
      const hKey = `${dateStr}T${String(h).padStart(2, '0')}`;
      if (hourlyMap.has(hKey)) dayHourly.push(hourlyMap.get(hKey));
    }

    const doy = dayOfYear(d);
    if (dayHourly.length >= 20) {
      // Har timedata: prediker per datapunkt, skaler til dagstotal
      let dayKwh = 0, dayHigh = 0, dayLow = 0;
      let tempSum = 0, tp10Sum = 0, tp90Sum = 0;
      for (const hf of dayHourly) {
        const t = hf.temp ?? 5;
        const tp10 = hf.temp_p10 ?? t - 3;
        const tp90 = hf.temp_p90 ?? t + 3;
        dayKwh += predict(t, doy);
        dayHigh += predict(tp10, doy);
        dayLow += predict(tp90, doy);
        tempSum += t;
        tp10Sum += tp10;
        tp90Sum += tp90;
      }
      const n = dayHourly.length;
      const scale = 24 / n;
      predictedConsumption.push(dayKwh * scale);
      predictedHigh.push(dayHigh * scale);
      predictedLow.push(dayLow * scale);
      forecastTemp.push(tempSum / n);
      forecastTempP10.push(tp10Sum / n);
      forecastTempP90.push(tp90Sum / n);
    } else {
      // Daglig snitt fra subseasonal eller historikk
      const fc = dailyMap.get(dateStr);
      const mmdd = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const tempMean = fc?.temp_mean ?? historicalTemps.get(mmdd) ?? 5;
      const tempP10 = fc?.temp_p10 ?? tempMean - 3;
      const tempP90 = fc?.temp_p90 ?? tempMean + 3;

      predictedConsumption.push(predict(tempMean, doy) * 24);
      predictedHigh.push(predict(tempP10, doy) * 24);
      predictedLow.push(predict(tempP90, doy) * 24);
      forecastTemp.push(tempMean);
      forecastTempP10.push(tempP10);
      forecastTempP90.push(tempP90);
    }
  }

  return {
    dates,
    actualConsumption,
    predictedConsumption,
    predictedHigh,
    predictedLow,
    actualTemp,
    forecastTemp,
    forecastTempP10,
    forecastTempP90,
  };
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
