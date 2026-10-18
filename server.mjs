// Energy dashboard on the home server (Dokploy): static frontend (public/) + a small JSON API on Postgres.
// Replaces the Vercel functions (api/), the browser's direct Supabase access and the cron-job.org job.
//
//   GET  /healthz                              200 when the database answers (Docker HEALTHCHECK)
//   GET  /api/homes                            homes for the selector (id, name, sort_order, lat, lon, has_charger)
//   GET  /api/consumption?home=<id>&since=<ISO> hourly rows of one home from <since>, oldest first (meter, house, car)
//   GET  /api/forecast?lat=<lat>&lon=<lon>     temperature forecast from met.no
//   POST /api/collect[?hours=&home=]           run the Tibber/Frost collector now (header x-cron-secret)
//   POST /api/collect-ev[?hours=&backfill=1]   run the Easee charging collector now (header x-cron-secret)
//
// Everything except /healthz, /api/collect and /api/collect-ev requires a valid Cloudflare Access token once
// CF_ACCESS_TEAM and CF_ACCESS_AUD are set (lib/access.mjs). Env: see AGENTS.md.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import pg from 'pg';
import { collect } from './lib/collect.mjs';
import { collectEv } from './lib/easee.mjs';
import { estimateEv } from './lib/ev-estimate.mjs';
import { forecast } from './lib/forecast.mjs';
import { accessEnabled, accessUser } from './lib/access.mjs';

const PORT = Number(process.env.PORT || 3000);
const ROOT = import.meta.dirname;
const PUBLIC = join(ROOT, 'public');
// Minute past each hour when the collector runs (Tibber has the previous hour by then).
const COLLECT_MINUTE = Number(process.env.COLLECT_MINUTE ?? 10);

// numeric → JS number, as the browser code expects (it sums consumption_kwh directly).
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

// --- Collector (replaces the cron-job.org job) --------------------------------------------------

// Tells healthchecks.io how a run went. Two checks: HEALTHCHECK_ENERGY_URL (Tibber + Frost, «Energy – innsamling»)
// and HEALTHCHECK_EASEE_URL (Easee + estimate, «Energy – elbillading»), so an e-mail says which source failed. A run
// with a failure pings /fail, so Erlend gets an e-mail at once; no pings at all (app down) alert after the grace
// period. Fire and forget: a slow or failing monitor must never block or break the app.
function heartbeat(url, ok, summary) {
  if (!url) return;
  fetch(ok ? url : `${url}/fail`, { method: 'POST', body: summary, signal: AbortSignal.timeout(10000) })
    .catch((err) => console.warn('heartbeat:', err.message));
}

// Easee, then the estimate for the hours before the charger reported hourly values (it reads the meter and the
// sessions, so it runs after both). Cheap (a year of rows), so it is simply redone every time.
async function collectAndEstimateEv(opts) {
  const result = await collectEv(db, opts);
  try {
    result.estimate = await estimateEv(db);
  } catch (err) {
    console.error('EV estimate failed:', err.message);
    result.estimate = { error: err.message };
    result.status = 502;
  }
  return result;
}

async function collectMeter() {
  if (!process.env.TIBBER_API_TOKEN) {
    console.warn('collect: TIBBER_API_TOKEN not set, skipping');
    return;
  }
  try {
    const result = await collect(db);
    const summary = JSON.stringify(result);
    console.log('collect:', summary);
    heartbeat(process.env.HEALTHCHECK_ENERGY_URL, result.status === 200, summary);
  } catch (err) {
    console.error('collect error:', err.message);
    heartbeat(process.env.HEALTHCHECK_ENERGY_URL, false, `collect error: ${err.message}`);
  }
}

// EV charging from Easee (optional: only when EASEE_USERNAME is set), whatever happened to the meter run.
async function collectCharging() {
  if (!process.env.EASEE_USERNAME) return;
  try {
    const result = await collectAndEstimateEv();
    const summary = JSON.stringify(result);
    console.log('collect-ev:', summary);
    heartbeat(process.env.HEALTHCHECK_EASEE_URL, result.status === 200, summary);
  } catch (err) {
    console.error('collect-ev error:', err.message);
    heartbeat(process.env.HEALTHCHECK_EASEE_URL, false, `collect-ev error: ${err.message}`);
  }
}

// The first Easee run fetches the full history (1–2 minutes), so the start-up run can still be going at hh:10.
let collecting = false;

// Meter first, then charging: the estimate reads the meter rows the first part has just written.
async function scheduledCollect() {
  if (collecting) {
    console.warn('collect: previous run still going, skipping');
    return;
  }
  collecting = true;
  try {
    await collectMeter();
    await collectCharging();
  } finally {
    collecting = false;
  }
}

function scheduleHourly() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(COLLECT_MINUTE, 0, 0);
  if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
  setTimeout(() => {
    scheduledCollect();
    scheduleHourly();
  }, next - now);
}

// --- Static files ------------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(path, res) {
  const file = normalize(join(PUBLIC, path.endsWith('/') ? `${path}index.html` : path));
  if (!file.startsWith(PUBLIC + '/')) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
  } catch {
    return false;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(await readFile(file));
  return true;
}

// --- HTTP --------------------------------------------------------------------------------------

function httpError(status, message) {
  return Object.assign(new Error(message), { statusCode: status });
}

function json(res, status, body, cacheControl = 'private, no-store') {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': cacheControl });
  res.end(JSON.stringify(body));
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  const q = url.searchParams;

  if (path === '/healthz') {
    await db.query('select 1');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (path === '/api/collect' && req.method === 'POST') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) return json(res, 401, { error: 'Unauthorized' });
    const { status, ...body } = await collect(db, { hours: parseInt(q.get('hours')) || 72, homeId: q.get('home') });
    return json(res, status, body);
  }
  if (path === '/api/collect-ev' && req.method === 'POST') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers['x-cron-secret'] !== secret) return json(res, 401, { error: 'Unauthorized' });
    if (!process.env.EASEE_USERNAME) return json(res, 400, { error: 'EASEE_USERNAME not set' });
    const { status, ...body } = await collectAndEstimateEv({ hours: parseInt(q.get('hours')) || 48, backfill: q.get('backfill') === '1' });
    return json(res, status, body);
  }

  // Everything below is for the family only.
  if (!(await accessUser(req))) return json(res, 403, { error: 'Cloudflare Access login required' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });

  if (path === '/api/homes') {
    const { rows } = await db.query('select id, name, sort_order, lat, lon, exists (select from chargers c where c.home_id = homes.id) as has_charger from homes order by sort_order');
    return json(res, 200, rows);
  }
  if (path === '/api/consumption') {
    const since = new Date(q.get('since'));
    if (!q.get('home') || !q.get('since') || Number.isNaN(since.getTime())) throw httpError(400, 'home and since (ISO) are required');
    const { rows } = await db.query(
      `select timestamp, consumption_kwh, outside_temp_c, house_kwh, ev_kwh, ev_estimated
       from energy_hourly where home_id = $1 and timestamp >= $2 order by timestamp`,
      [q.get('home'), since]
    );
    return json(res, 200, rows);
  }
  if (path === '/api/forecast') {
    const lat = parseFloat(q.get('lat'));
    const lon = parseFloat(q.get('lon'));
    if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return json(res, 400, { error: 'Invalid lat/lon parameters' });
    }
    return json(res, 200, await forecast(lat, lon), 'private, max-age=0');
  }
  if (!(await serveStatic(path, res))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Finnes ikke');
  }
}

// --- Start -------------------------------------------------------------------------------------

async function migrate() {
  // The database may still be starting when the app does; try for about a minute.
  for (let attempt = 1; ; attempt++) {
    try {
      await db.query(await readFile(join(ROOT, 'db/postgres.sql'), 'utf8'));
      return;
    } catch (err) {
      if (attempt >= 12) throw err;
      console.warn(`database not ready (${err.message}), retrying in 5 s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

await migrate();
createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.statusCode || 500;
    if (status >= 500) console.error(`${req.method} ${req.url}:`, err);
    if (!res.headersSent) json(res, status, { error: err.message });
    else res.end();
  });
}).listen(PORT, () => {
  console.log(`energy listening on :${PORT}, Cloudflare Access ${accessEnabled ? 'ON' : 'off (local only)'}`);
});
// One run shortly after start-up (it fetches the last 72 hours, so nothing missed while down is lost), then hourly.
setTimeout(scheduledCollect, 60 * 1000);
scheduleHourly();
