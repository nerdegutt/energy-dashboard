const { createClient } = require('@supabase/supabase-js');
const { TibberQuery } = require('tibber-api');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const hours = parseInt(req.query.hours) || 24;

  try {
    // --- Tibber ---
    const tibberConfig = {
      active: true,
      apiEndpoint: {
        apiKey: process.env.TIBBER_API_TOKEN,
        queryUrl: 'https://api.tibber.com/v1-beta/gql',
      },
    };
    const tibberQuery = new TibberQuery(tibberConfig);

    const homeId = process.env.TIBBER_HOME_ID;

    let consumptionNodes;
    if (hours <= 744) {
      consumptionNodes = await tibberQuery.getConsumption('HOURLY', hours, homeId);
    } else {
      consumptionNodes = await fetchPaginated(tibberQuery, hours, homeId);
    }

    // Filtrer ut noder uten data
    consumptionNodes = consumptionNodes.filter(
      (n) => n && n.from && n.consumption != null
    );

    if (consumptionNodes.length === 0) {
      return res.status(200).json({ message: 'No consumption data returned', upserted: 0 });
    }

    // --- Frost (temperatur) ---
    const tempMap = await fetchTemperatures(consumptionNodes);

    // --- Upsert til Supabase ---
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const rowMap = new Map();
    for (const n of consumptionNodes) {
      const ts = new Date(n.from).toISOString();
      const hourKey = ts.slice(0, 13); // "YYYY-MM-DDTHH"
      rowMap.set(ts, {
        timestamp: ts,
        consumption_kwh: n.consumption,
        outside_temp_c: tempMap.get(hourKey) ?? null,
      });
    }
    const rows = [...rowMap.values()];

    // Upsert i chunks à 1000
    let upserted = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const chunk = rows.slice(i, i + 1000);
      const { error } = await supabase
        .from('consumption')
        .upsert(chunk, { onConflict: 'timestamp' });
      if (error) throw error;
      upserted += chunk.length;
    }

    return res.status(200).json({
      message: 'OK',
      upserted,
      tempPoints: tempMap.size,
    });
  } catch (err) {
    console.error('collect error:', err);
    return res.status(500).json({ error: err.message });
  }
};

async function fetchPaginated(tibberQuery, totalHours, homeId) {
  const allNodes = [];
  let cursor = null;
  const batchSize = 744;

  while (allNodes.length < totalHours) {
    const remaining = totalHours - allNodes.length;
    const count = Math.min(remaining, batchSize);

    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const gql = `{
      viewer {
        home(id: "${homeId}") {
          consumption(resolution: HOURLY, first: ${count}${afterClause}) {
            pageInfo { hasNextPage endCursor }
            nodes { from to consumption }
          }
        }
      }
    }`;

    const result = await tibberQuery.query(gql);
    const home = result.viewer.home;
    const nodes = home.consumption.nodes;

    if (!nodes || nodes.length === 0) break;

    allNodes.push(...nodes);
    cursor = home.consumption.pageInfo?.endCursor;

    if (!home.consumption.pageInfo?.hasNextPage) break;
  }

  return allNodes;
}

async function fetchTemperatures(consumptionNodes) {
  const tempMap = new Map();

  try {
    const dates = consumptionNodes.map((n) => new Date(n.from));
    const minDate = new Date(Math.min(...dates));
    const maxDate = new Date(Math.max(...dates));
    // Utvid litt for å sikre at vi får alle timer
    maxDate.setHours(maxDate.getHours() + 1);

    const refTime = `${minDate.toISOString().slice(0, 16)}/${maxDate.toISOString().slice(0, 16)}`;
    const params = new URLSearchParams({
      sources: 'SN17280',
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
