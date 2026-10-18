// Fetches hourly charging energy from Easee for every charger the account can see and upserts it into
// ev_charging (db/postgres.sql). Read-only: only login, the charger and site lists, lifetime-energy and sessions are
// called – never the control endpoints. Env: EASEE_USERNAME, EASEE_PASSWORD (Dokploy), optional EASEE_CHARGER_IDS.
//
// API (developer.easee.com, checked 18 Oct 2026):
//   POST /api/accounts/login {userName, password}       → {accessToken, expiresIn (3600), refreshToken, …}
//   GET  /api/chargers                                  → [{id, name, productCode, …}] (2 requests/min)
//        Only chargers the account owns or administers: an ordinary site user gets [] (h49 test, 18 Oct 2026), but
//        sees the site and can read the charger directly. So, if empty:
//   GET  /api/sites                                     → [{id, name, …}]
//   GET  /api/sites/{siteId}/chargers                   → [{id, name, userRole, …}]
//        and as a last resort the ids in EASEE_CHARGER_IDS (comma-separated, e.g. EHHTPUS8).
//   GET  /api/chargers/lifetime-energy/{id}/hourly?from&to&tz
//                                                       → [{year, month, day, hour, consumption, date}]
// `consumption` is kWh in that hour: on 18 Oct 2026 the hours 02–09 summed to 36.4 kWh against the session's
// 36.07 kWh. `date` carries the Oslo offset; it is stored as the UTC start of the hour.
//
//   GET  /api/sessions/charger/{id}/sessions/{from}/{to} → [{id, carConnected, carDisconnected, kiloWattHours,
//        actualDurationSeconds, firstEnergyTransferPeriodStarted, lastEnergyTransferPeriodEnd, isComplete, …}]
//        (10 requests/hour). Sessions go back to the first charge; hourly energy only to 19 Sep 2025.
//
// The first run for a charger (backfilled_at null) fetches hours month by month and all sessions from
// EASEE_HISTORY_FROM (default 2024-10-01, when the charger was installed); later runs fetch the last `hours`
// hours and the sessions of the last 14 days.

const BASE = 'https://api.easee.com';
const HISTORY_FROM = process.env.EASEE_HISTORY_FROM || '2024-10-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = null; // { access, until }

async function login() {
  const r = await fetch(`${BASE}/api/accounts/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ userName: process.env.EASEE_USERNAME, password: process.env.EASEE_PASSWORD }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`Easee login returned ${r.status}`);
  const j = await r.json();
  token = { access: j.accessToken, until: Date.now() + Math.max(60, (j.expiresIn ?? 3600) - 120) * 1000 };
}

async function easeeGet(path, retry = true) {
  if (!token || token.until < Date.now()) await login();
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${token.access}`, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (r.status === 401 && retry) { token = null; return easeeGet(path, false); }
  if (r.status === 429 && retry) { await sleep(60000); return easeeGet(path, false); }
  if (!r.ok) throw new Error(`Easee ${path.split('?')[0]} returned ${r.status}`);
  return r.json();
}

async function hourly(chargerId, from, to) {
  const rows = await easeeGet(`/api/chargers/lifetime-energy/${encodeURIComponent(chargerId)}/hourly?from=${from.toISOString()}&to=${to.toISOString()}&tz=Europe/Oslo`);
  return (rows || []).filter((r) => r.consumption != null && r.date)
    .map((r) => ({ timestamp: new Date(r.date).toISOString(), energy_kwh: r.consumption }));
}

async function sessions(db, chargerId, from, to) {
  const list = await easeeGet(`/api/sessions/charger/${encodeURIComponent(chargerId)}/sessions/${from.toISOString()}/${to.toISOString()}`);
  const rows = (list || []).filter((x) => x.id != null).map((x) => ({
    id: x.id, car_connected: x.carConnected ?? null, car_disconnected: x.carDisconnected ?? null, energy_kwh: x.kiloWattHours ?? null,
    charging_seconds: x.actualDurationSeconds ?? null, first_transfer: x.firstEnergyTransferPeriodStarted ?? null,
    last_transfer: x.lastEnergyTransferPeriodEnd ?? null, complete: x.isComplete ?? null,
  }));
  if (rows.length) await db.query(
    `insert into ev_sessions (charger_id, id, car_connected, car_disconnected, energy_kwh, charging_seconds, first_transfer, last_transfer, complete)
     select $1, id, car_connected, car_disconnected, energy_kwh, charging_seconds, first_transfer, last_transfer, complete
     from jsonb_to_recordset($2::jsonb) as r(id bigint, car_connected timestamptz, car_disconnected timestamptz, energy_kwh numeric,
       charging_seconds int, first_transfer timestamptz, last_transfer timestamptz, complete boolean)
     on conflict (charger_id, id) do update set car_connected = excluded.car_connected, car_disconnected = excluded.car_disconnected,
       energy_kwh = excluded.energy_kwh, charging_seconds = excluded.charging_seconds, first_transfer = excluded.first_transfer,
       last_transfer = excluded.last_transfer, complete = excluded.complete`,
    [chargerId, JSON.stringify(rows)]);
  return rows.length;
}

async function upsert(db, chargerId, rows) {
  for (let i = 0; i < rows.length; i += 1000) {
    await db.query(
      `insert into ev_charging (charger_id, timestamp, energy_kwh)
       select $1, timestamp, energy_kwh from jsonb_to_recordset($2::jsonb) as r(timestamp timestamptz, energy_kwh numeric)
       on conflict (charger_id, timestamp) do update set energy_kwh = excluded.energy_kwh`,
      [chargerId, JSON.stringify(rows.slice(i, i + 1000))]
    );
  }
  return rows.length;
}

// The chargers this account can read: its own, else those on its sites, else EASEE_CHARGER_IDS (name null: the
// name already stored is kept).
async function chargerList() {
  const own = await easeeGet('/api/chargers');
  if (Array.isArray(own) && own.length) return own;
  // An ordinary site user sees the site but gets 403 on its charger list (18 Oct 2026), so failures here only
  // move on to EASEE_CHARGER_IDS.
  const found = new Map();
  try {
    for (const site of (await easeeGet('/api/sites')) || []) {
      try {
        const onSite = await easeeGet(`/api/sites/${encodeURIComponent(site.id)}/chargers`);
        for (const c of onSite || []) if (c?.id) found.set(c.id, c);
      } catch (err) {
        console.warn(`Easee: no charger list for site ${site.id} (${err.message})`);
      }
    }
  } catch (err) {
    console.warn(`Easee: no site list (${err.message})`);
  }
  if (found.size) return [...found.values()];
  return (process.env.EASEE_CHARGER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean).map((id) => ({ id, name: null }));
}

export async function collectEv(db, { hours = 48, backfill = false } = {}) {
  const list = await chargerList();
  const result = { status: 200, chargers: [], upserted: 0, failed: [] };
  if (!list.length) return { ...result, status: 502, error: 'no charger visible to this Easee account (set EASEE_CHARGER_IDS?)' };
  for (const c of list) {
    try {
      const { rows: [known] } = await db.query(
        `insert into chargers (id, name) values ($1, coalesce($2, $1))
         on conflict (id) do update set name = coalesce($2, chargers.name) returning backfilled_at`, [c.id, c.name || null]);
      const now = new Date();
      let n = 0, s = 0;
      if (backfill || !known.backfilled_at) {
        // month by month from the installation (each call is one month of hours). Easee returns zeros for
        // hours before its hourly reporting began (for EHHTPUS8 the first real hour is 19 Sep 2025, although
        // the charger is from Oct 2024), so leading zeros are skipped: no row means «unknown», not «0 kWh».
        let seen = false;
        for (let m = new Date(`${HISTORY_FROM}T00:00:00Z`); m < now;) {
          const next = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1));
          const rows = (await hourly(c.id, m, next < now ? next : now)).filter((r) => (seen ||= r.energy_kwh > 0));
          n += await upsert(db, c.id, rows);
          m = next;
          await sleep(3000);
        }
        s = await sessions(db, c.id, new Date(`${HISTORY_FROM}T00:00:00Z`), now);
        await db.query('update chargers set backfilled_at = now() where id = $1', [c.id]);
      } else {
        n = await upsert(db, c.id, await hourly(c.id, new Date(now.getTime() - hours * 3600e3), now));
        s = await sessions(db, c.id, new Date(now.getTime() - 14 * 864e5), now);
      }
      result.chargers.push({ id: c.id, name: c.name, upserted: n, sessions: s, backfilled: backfill || !known.backfilled_at });
      result.upserted += n;
    } catch (err) {
      console.error(`Easee collect failed for charger ${c.id}:`, err.message);
      result.failed.push({ chargerId: c.id, error: err.message });
    }
  }
  if (result.failed.length) result.status = 502;
  return result;
}
