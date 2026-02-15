const USER_AGENT = 'energy-dashboard github.com/nerdegutt/energy-dashboard';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const lat = parseFloat(req.query.lat);
  const lon = parseFloat(req.query.lon);

  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Invalid lat/lon parameters' });
  }

  try {
    // Hent begge API-er parallelt
    const [locResp, subResp] = await Promise.all([
      fetch(
        `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${lat}&lon=${lon}`,
        { headers: { 'User-Agent': USER_AGENT } }
      ),
      fetch(
        `https://api.met.no/weatherapi/subseasonal/1.0/complete?lat=${lat}&lon=${lon}`,
        { headers: { 'User-Agent': USER_AGENT } }
      ),
    ]);

    // --- Locationforecast: timedata (0–65t) + 6-timers (til ~10d) ---
    const hourly = [];
    if (locResp.ok) {
      const locJson = await locResp.json();
      const timeseries = locJson.properties?.timeseries;
      if (Array.isArray(timeseries)) {
        for (const entry of timeseries) {
          const time = entry.time;
          const details = entry.data?.instant?.details;
          if (!time || !details) continue;
          hourly.push({
            time,
            temp: details.air_temperature ?? null,
            temp_p10: details.air_temperature_percentile_10 ?? null,
            temp_p90: details.air_temperature_percentile_90 ?? null,
          });
        }
      }
    } else {
      console.warn(`Locationforecast returned ${locResp.status}`);
    }

    // --- Subseasonal: daglige verdier (dag 1–21) ---
    const daily = [];
    if (subResp.ok) {
      const subJson = await subResp.json();
      const timeseries = subJson.properties?.timeseries;
      if (Array.isArray(timeseries)) {
        for (const entry of timeseries) {
          const date = entry.time?.slice(0, 10);
          const details = entry.data?.next_24_hours?.details;
          if (!date || !details) continue;
          daily.push({
            date,
            temp_mean: details.air_temperature_mean ?? null,
            temp_p10: details.air_temperature_mean_percentile_10 ?? null,
            temp_p90: details.air_temperature_mean_percentile_90 ?? null,
          });
        }
      }
    } else {
      console.warn(`Subseasonal returned ${subResp.status}`);
    }

    // --- Bygg samlet respons ---
    // hourly: brukes direkte for time-for-time prediksjon
    // daily: fallback for datoer som ikke dekkes av hourly
    // Kun ekskluder datoer med tilstrekkelig timedekning (≥20 av 24 timer)
    const hourlyCountByDate = new Map();
    for (const h of hourly) {
      const date = h.time.slice(0, 10);
      hourlyCountByDate.set(date, (hourlyCountByDate.get(date) || 0) + 1);
    }
    const wellCoveredDates = new Set(
      [...hourlyCountByDate.entries()].filter(([, count]) => count >= 20).map(([date]) => date)
    );
    const dailyFiltered = daily.filter(d => !wellCoveredDates.has(d.date));

    res.setHeader('Cache-Control', 'public, s-maxage=3600, max-age=0');
    return res.status(200).json({ hourly, daily: dailyFiltered });
  } catch (err) {
    console.error('forecast error:', err);
    return res.status(500).json({ error: err.message });
  }
};
