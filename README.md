# Energy Dashboard

Personlig dashboard for strømforbruk. Henter timedata fra [Tibber](https://tibber.com/) og utetemperatur fra [Frost API](https://frost.met.no/) (met.no), lagrer alt i [Supabase](https://supabase.com/) (PostgreSQL), og visualiserer med [ECharts](https://echarts.apache.org/). Hostet på [Vercel](https://vercel.com/). Grafana-inspirert mørkt tema med JetBrains Mono.

![Dashboard - årsvisning](screencapture-1y.png)

## Hva viser det?

- **Gauge** med gjennomsnittsforbruk for valgt periode
- **Linjegraf** med forbruk, rullende snitt og utetemperatur (dual y-akse)
- **År-over-år sammenligning** med sentrert rullende snitt (±7 dager) og rød/grønn fyll som viser om forbruket har gått opp eller ned
- **Månedlig endring** i prosent sammenlignet med tilsvarende måned året før
- **Scatter plot** med temperatur vs. forbruk og regresjonslinjer (kun årsvisning)
- **Heatmap** med snittforbruk per ukedag og klokketime (kun årsvisning)
- **Snitt per ukedag** som bar chart (kun årsvisning)

Fire perioder: 24 timer, 7 dager, 28 dager og 1 år.

## Arkitektur

```
GitHub Actions (cron hvert kvarter)
    ↓
/api/collect.js (Vercel serverless, henter siste 72t)
    ↓ Tibber GraphQL API → forbruksdata
    ↓ Frost API (met.no) → temperaturdata
    ↓
Supabase (PostgreSQL, upsert)
    ↓
Frontend spør Supabase direkte (RLS + auth)
    ↓
Ren HTML + vanilla JS + ECharts
```

Ingen build step, ingen bundler, ingen React. Bare HTML, vanilla JavaScript (ES modules) og en serverless function (CommonJS).

## Tech stack

| Hva | Tjeneste |
|-----|----------|
| Hosting + serverless | Vercel (free tier) |
| Database | Supabase PostgreSQL (free tier) |
| Autentisering | Supabase Auth (e-post/passord) |
| Strømdata | Tibber GraphQL API |
| Temperatur | Frost API (met.no, stasjon SN17280) |
| Grafer | ECharts (CDN) |
| Styling | Tailwind CSS (CDN) |
| Cron | GitHub Actions |

## Oppsett

1. Opprett kontoer hos Vercel, Supabase, Tibber Developer og Frost (met.no)
2. Opprett en `consumption`-tabell i Supabase:
   ```sql
   CREATE TABLE consumption (
     timestamp TIMESTAMPTZ PRIMARY KEY,
     consumption_kwh NUMERIC,
     outside_temp_c NUMERIC
   );
   ```
3. Aktiver Row Level Security med SELECT-tilgang for autentiserte brukere
4. Opprett en bruker i Supabase Auth
5. Sett environment variables i Vercel:
   ```
   TIBBER_API_TOKEN
   TIBBER_HOME_ID
   SUPABASE_URL
   SUPABASE_SERVICE_KEY
   CRON_SECRET
   FROST_CLIENT_ID
   ```
6. Sett opp GitHub Actions med `CRON_SECRET` som secret og `COLLECT_URL` som variabel
7. Deploy til Vercel (`git push` til `main`)
8. Kjør en backfill for å hente historisk data:
   ```bash
   curl -X POST "https://din-app.vercel.app/api/collect?hours=100000" \
     -H "x-cron-secret: din-nøkkel"
   ```

## Vibe-kodet

Dette prosjektet er nær 100 % vibe-kodet med [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Alt av kode -- frontend, backend, databehandling, grafer og GitHub Actions-oppsett -- er skrevet av Claude gjennom naturlig dialog på norsk. Det eneste som er gjort manuelt er opprettelse av kontoer hos de ulike tjenestene og konfigurasjon av API-nøkler.
