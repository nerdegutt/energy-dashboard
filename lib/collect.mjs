// Fetches hourly consumption from Tibber for every home with collect_enabled, adds the outside temperature
// from Frost (met.no) and upserts into consumption. Called by the hourly scheduler in server.mjs and by
// POST /api/collect (x-cron-secret) for backfill (?hours=100000, ?home=<id>).
// A failure for one home does not stop the others; they are reported in `failed`.

const TIBBER_URL = 'https://api.tibber.com/v1-beta/gql';

export async function collect(db, { hours = 72, homeId = null } = {}) {
  const params = [];
  let where = 'collect_enabled';
  if (homeId) { params.push(homeId); where += ' and id = $1'; }
  const { rows: homes } = await db.query(`select id, frost_station from homes where ${where} order by sort_order`, params);
  if (homes.length === 0) return { status: 400, error: 'No homes found' };

  // --- Tibber: data for each home ---
  const allNodesByHome = [];
  const failed = [];
  for (const home of homes) {
    try {
      let nodes = hours <= 744 ? await fetchTibber(home.id, `last: ${hours}`) : await fetchPaginated(home.id, hours);
      nodes = nodes.filter((n) => n && n.from);
      allNodesByHome.push({ homeId: home.id, nodes });
    } catch (err) {
      console.error(`Tibber fetch failed for home ${home.id}:`, err.message);
      failed.push({ homeId: home.id, error: err.message });
    }
  }

  const allNodes = allNodesByHome.flatMap((h) => h.nodes);
  if (allNodes.length === 0) {
    return failed.length > 0
      ? { status: 502, error: 'Tibber fetch failed', failed, upserted: 0 }
      : { status: 200, message: 'No data returned', upserted: 0 };
  }

  // --- Frost (temperature, once per unique station) ---
  const okHomeIds = new Set(allNodesByHome.map((h) => h.homeId));
  const stationToHomes = new Map();
  for (const home of homes.filter((h) => okHomeIds.has(h.id))) {
    const station = home.frost_station || 'SN17280';
    if (!stationToHomes.has(station)) stationToHomes.set(station, []);
    stationToHomes.get(station).push(home.id);
  }
  const tempMapByStation = new Map();
  for (const station of stationToHomes.keys()) {
    tempMapByStation.set(station, await fetchTemperatures(allNodes, station));
  }
  const tempMapByHome = new Map();
  for (const [station, homeIds] of stationToHomes) {
    for (const hid of homeIds) tempMapByHome.set(hid, tempMapByStation.get(station));
  }

  // --- Rows per home, upserted ---
  let totalUpserted = 0;
  for (const { homeId: hid, nodes } of allNodesByHome) {
    const tempMap = tempMapByHome.get(hid) || new Map();
    const rowMap = new Map();
    for (const n of nodes) {
      const ts = new Date(n.from).toISOString();
      rowMap.set(ts, { home_id: hid, timestamp: ts, consumption_kwh: n.consumption ?? null, outside_temp_c: tempMap.get(ts.slice(0, 13)) ?? null });
    }
    // Rows for temperature hours Tibber has not delivered yet
    for (const [hourKey, temp] of tempMap) {
      const ts = new Date(hourKey + ':00:00.000Z').toISOString();
      if (!rowMap.has(ts)) rowMap.set(ts, { home_id: hid, timestamp: ts, consumption_kwh: null, outside_temp_c: temp });
    }
    const rows = [...rowMap.values()];
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      await db.query(
        `insert into consumption (home_id, timestamp, consumption_kwh, outside_temp_c)
         select home_id, timestamp, consumption_kwh, outside_temp_c
         from jsonb_to_recordset($1::jsonb) as r(home_id text, timestamp timestamptz, consumption_kwh numeric, outside_temp_c numeric)
         on conflict (home_id, timestamp) do update
           set consumption_kwh = excluded.consumption_kwh, outside_temp_c = excluded.outside_temp_c`,
        [JSON.stringify(chunk)]
      );
      totalUpserted += chunk.length;
    }
  }

  const tempPoints = {};
  for (const [station, tMap] of tempMapByStation) tempPoints[station] = tMap.size;
  return {
    status: failed.length > 0 ? 502 : 200,
    message: failed.length > 0 ? 'Partial failure' : 'OK',
    homes: [...okHomeIds],
    failed,
    upserted: totalUpserted,
    tempPoints,
  };
}

async function tibberGql(query) {
  const resp = await fetch(TIBBER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TIBBER_API_TOKEN}`,
    },
    body: JSON.stringify({ query }),
  });

  if (!resp.ok) {
    throw new Error(`Tibber API returned ${resp.status}: ${await resp.text()}`);
  }

  const json = await resp.json();
  if (json.errors) {
    throw new Error(`Tibber GraphQL error: ${json.errors[0].message}`);
  }
  return json.data;
}

async function fetchTibber(homeId, pagination) {
  const data = await tibberGql(`{
    viewer {
      home(id: "${homeId}") {
        consumption(resolution: HOURLY, ${pagination}) {
          nodes { from to consumption }
        }
      }
    }
  }`);
  return data.viewer.home.consumption.nodes;
}

async function fetchPaginated(homeId, totalHours) {
  const allNodes = [];
  let cursor = null;
  const batchSize = 744;

  while (allNodes.length < totalHours) {
    const remaining = totalHours - allNodes.length;
    const count = Math.min(remaining, batchSize);

    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const data = await tibberGql(`{
      viewer {
        home(id: "${homeId}") {
          consumption(resolution: HOURLY, first: ${count}${afterClause}) {
            pageInfo { hasNextPage endCursor }
            nodes { from to consumption }
          }
        }
      }
    }`);

    const consumption = data.viewer.home.consumption;
    const nodes = consumption.nodes;

    if (!nodes || nodes.length === 0) break;

    allNodes.push(...nodes);
    cursor = consumption.pageInfo?.endCursor;

    if (!consumption.pageInfo?.hasNextPage) break;
  }

  return allNodes;
}

async function fetchTemperatures(consumptionNodes, station = 'SN17280') {
  const tempMap = new Map();

  try {
    const dates = consumptionNodes.map((n) => new Date(n.from));
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    maxDate.setHours(maxDate.getHours() + 1);

    const refTime = `${minDate.toISOString().slice(0, 16)}/${maxDate.toISOString().slice(0, 16)}`;
    const params = new URLSearchParams({
      sources: station,
      elements: 'air_temperature',
      referencetime: refTime,
      timeresolutions: 'PT1H',
    });

    const url = `https://frost.met.no/observations/v0.jsonld?${params}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(process.env.FROST_CLIENT_ID + ':').toString('base64')}`,
        'User-Agent': 'energy-dashboard github.com/nerdegutt/energy-dashboard',
      },
    });

    if (!resp.ok) {
      console.warn(`Frost API returned ${resp.status}, continuing without temperature data`);
      return tempMap;
    }

    const json = await resp.json();
    if (json.data) {
      for (const obs of json.data) {
        const ts = new Date(obs.referenceTime).toISOString();
        const hourKey = ts.slice(0, 13);
        const tempObs = obs.observations.find(
          (o) => o.elementId === 'air_temperature'
        );
        if (tempObs) {
          tempMap.set(hourKey, tempObs.value);
        }
      }
    }
  } catch (err) {
    console.warn('Frost fetch failed, continuing without temperature:', err.message);
  }

  return tempMap;
}
