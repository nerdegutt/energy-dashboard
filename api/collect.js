const { createClient } = require('@supabase/supabase-js');

const TIBBER_URL = 'https://api.tibber.com/v1-beta/gql';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const hours = parseInt(req.query.hours) || 72;
  const filterHomeId = req.query.home || null;

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // --- Hent homes fra DB ---
    let homesQuery = supabase.from('homes').select('id, frost_station').order('sort_order');
    if (filterHomeId) homesQuery = homesQuery.eq('id', filterHomeId);
    const { data: homes, error: homesError } = await homesQuery;
    if (homesError) throw homesError;
    if (!homes || homes.length === 0) {
      return res.status(400).json({ error: 'No homes found' });
    }

    // --- Tibber: hent data for hvert hjem ---
    const allNodesByHome = [];
    for (const home of homes) {
      let nodes;
      if (hours <= 744) {
        nodes = await fetchTibber(home.id, `last: ${hours}`);
      } else {
        nodes = await fetchPaginated(home.id, hours);
      }
      nodes = nodes.filter((n) => n && n.from);
      allNodesByHome.push({ homeId: home.id, nodes });
    }

    // Samle alle noder for Frost-oppslag
    const allNodes = allNodesByHome.flatMap((h) => h.nodes);
    if (allNodes.length === 0) {
      return res.status(200).json({ message: 'No data returned', upserted: 0 });
    }

    // --- Frost (temperatur, én gang per unik stasjon) ---
    const stationToHomes = new Map();
    for (const home of homes) {
      const station = home.frost_station || 'SN17280';
      if (!stationToHomes.has(station)) stationToHomes.set(station, []);
      stationToHomes.get(station).push(home.id);
    }

    const tempMapByStation = new Map();
    for (const station of stationToHomes.keys()) {
      tempMapByStation.set(station, await fetchTemperatures(allNodes, station));
    }

    // Map homeId → tempMap
    const tempMapByHome = new Map();
    for (const [station, homeIds] of stationToHomes) {
      for (const hid of homeIds) {
        tempMapByHome.set(hid, tempMapByStation.get(station));
      }
    }

    // --- Bygg rader med home_id og upsert ---
    let totalUpserted = 0;
    for (const { homeId, nodes } of allNodesByHome) {
      const tempMap = tempMapByHome.get(homeId) || new Map();
      const rowMap = new Map();
      for (const n of nodes) {
        const ts = new Date(n.from).toISOString();
        const hourKey = ts.slice(0, 13);
        rowMap.set(ts, {
          home_id: homeId,
          timestamp: ts,
          consumption_kwh: n.consumption ?? null,
          outside_temp_c: tempMap.get(hourKey) ?? null,
        });
      }

      // Legg til rader for temperatur-timer som Tibber ikke har levert ennå
      for (const [hourKey, temp] of tempMap) {
        const ts = new Date(hourKey + ':00:00.000Z').toISOString();
        if (!rowMap.has(ts)) {
          rowMap.set(ts, {
            home_id: homeId,
            timestamp: ts,
            consumption_kwh: null,
            outside_temp_c: temp,
          });
        }
      }

      const rows = [...rowMap.values()];

      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const { error } = await supabase
          .from('consumption')
          .upsert(chunk, { onConflict: 'home_id,timestamp' });
        if (error) throw error;
        totalUpserted += chunk.length;
      }
    }

    const tempPoints = {};
    for (const [station, tMap] of tempMapByStation) {
      tempPoints[station] = tMap.size;
    }

    return res.status(200).json({
      message: 'OK',
      homes: homes.map((h) => h.id),
      upserted: totalUpserted,
      tempPoints,
    });
  } catch (err) {
    console.error('collect error:', err);
    return res.status(500).json({ error: err.message });
  }
};

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
