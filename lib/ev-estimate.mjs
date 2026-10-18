// Estimates EV energy per hour for the time before a charger reported hourly values (EHHTPUS8: sessions from
// 15 Oct 2024, hours from 19 Sep 2025) and writes it to ev_charging_estimate (db/postgres.sql).
//
// Per session, the kWh not already covered by exact hours is spread over the hours of its transfer window
// [first_transfer, last_transfer] where the meter rises most above its baseline (median of the meter ±12 h):
// greedily, at most min(rise, charger cap) per hour, in at most ceil(charging_seconds / 3600) + 2 hours. What the
// rises cannot hold is spread over the remaining room under the meter, so each session keeps its total kWh
// (unless the meter itself is lower than the session, which has not happened).
//
// Backtest on the 163 sessions with exact hours (18 Oct 2026): 80 % of the energy in the right hour, 91 % on the
// right day (spreading evenly over the window: 45 % and 76 %).

const H = 3600e3;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function estimateCharger(meter, exact, sessions, cap) {
  const used = new Map(); // hour → kWh already given to a session (back-to-back sessions can share an hour)
  const baseline = (h) => {
    const near = [];
    for (let i = -12; i <= 12; i++) { const v = meter.get(h + i * H); if (v != null) near.push(v); }
    return median(near);
  };
  for (const s of sessions) {
    const hours = [];
    let covered = 0;
    for (let h = Math.floor(s.first / H) * H; h <= s.last; h += H) {
      if (exact.has(h)) covered += exact.get(h);
      else if (meter.has(h)) hours.push(h);
    }
    let left = s.kwh - covered;
    if (left <= 0.001 || !hours.length) continue;
    const room = (h) => Math.max(0, Math.min(cap, meter.get(h)) - (used.get(h) ?? 0));
    const rise = new Map(hours.map((h) => [h, Math.min(room(h), Math.max(0, meter.get(h) - baseline(h)))]));
    const order = hours.sort((a, b) => rise.get(b) - rise.get(a)).slice(0, Math.ceil(s.seconds / 3600) + 2);
    for (const h of order) {
      const x = Math.min(rise.get(h), left);
      used.set(h, (used.get(h) ?? 0) + x);
      left -= x;
      if (left <= 0) break;
    }
    if (left > 0.001) {
      const free = order.map((h) => [h, room(h)]);
      const total = free.reduce((sum, [, r]) => sum + r, 0);
      for (const [h, r] of free) used.set(h, (used.get(h) ?? 0) + (total > 0 ? Math.min(r, left * r / total) : left / free.length));
    }
  }
  return used;
}

export async function estimateEv(db) {
  const { rows: chargers } = await db.query(
    `select c.id, c.home_id, min(e.timestamp) as exact_from, max(e.energy_kwh) as cap
     from chargers c left join ev_charging e on e.charger_id = c.id
     where c.home_id is not null group by c.id, c.home_id`);
  const result = { hours: 0, kwh: 0 };
  for (const c of chargers) {
    const until = c.exact_from ?? new Date();
    const { rows: sessions } = await db.query(
      `select first_transfer as first, last_transfer as last, energy_kwh as kwh, coalesce(charging_seconds, 0) as seconds
       from ev_sessions
       where charger_id = $1 and first_transfer is not null and last_transfer is not null and energy_kwh > 0
         and first_transfer < $2
       order by first_transfer`, [c.id, until]);
    const from = sessions.length ? new Date(sessions[0].first.getTime() - 13 * H) : until;
    const to = new Date((sessions.length ? Math.max(...sessions.map((s) => s.last.getTime())) : until.getTime()) + 13 * H);
    const { rows: meterRows } = await db.query(
      `select timestamp, consumption_kwh from consumption
       where home_id = $1 and timestamp >= $2 and timestamp <= $3 and consumption_kwh is not null`, [c.home_id, from, to]);
    const { rows: exactRows } = await db.query(
      'select timestamp, energy_kwh from ev_charging where charger_id = $1 and timestamp >= $2 and timestamp <= $3', [c.id, from, to]);
    const meter = new Map(meterRows.map((r) => [r.timestamp.getTime(), Number(r.consumption_kwh)]));
    const exact = new Map(exactRows.map((r) => [r.timestamp.getTime(), Number(r.energy_kwh)]));
    const sessionRows = sessions.map((s) => ({ first: s.first.getTime(), last: s.last.getTime(), kwh: Number(s.kwh), seconds: s.seconds }));

    const est = [...estimateCharger(meter, exact, sessionRows, Number(c.cap) || 11)]
      .filter(([, kwh]) => kwh > 0.0005)
      .map(([h, kwh]) => ({ timestamp: new Date(h).toISOString(), energy_kwh: Math.round(kwh * 1000) / 1000 }));
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query('delete from ev_charging_estimate where charger_id = $1', [c.id]);
      if (est.length) await client.query(
        `insert into ev_charging_estimate (charger_id, timestamp, energy_kwh)
         select $1, timestamp, energy_kwh from jsonb_to_recordset($2::jsonb) as r(timestamp timestamptz, energy_kwh numeric)`,
        [c.id, JSON.stringify(est)]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
    result.hours += est.length;
    result.kwh += est.reduce((sum, r) => sum + r.energy_kwh, 0);
  }
  result.kwh = Math.round(result.kwh * 10) / 10;
  return result;
}
