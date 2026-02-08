# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Oversikt

Personlig strømforbruk-dashboard som henter timedata fra Tibber API, lagrer i Supabase, og visualiserer med ECharts. Hostet på Vercel. Grafana-inspirert mørkt tema.

## Utvikling

- **Ingen build step, ingen bundler, ingen React/Next.js** – ren HTML + vanilla JS + Vercel serverless functions
- Lokal utvikling: `vercel dev` (krever Vercel CLI og `.env`-fil med alle variabler fra Environment Variables-seksjonen)
- Deploy: push til `main` → Vercel bygger automatisk
- Manuell datainnsamling: `curl -X POST http://localhost:3000/api/collect -H "x-cron-secret: <din-nøkkel>"`
- Ingen tester, ingen linter konfigurert

## Arkitektur

```
GitHub Actions (cron, :15 hver time)
    ↓
/api/collect.js (Vercel serverless function)
    ↓ henter siste 24t fra Tibber API (upsert, selvhelende)
    ↓ henter temperatur fra Frost API (met.no)
    ↓
Supabase (PostgreSQL)
    ↓
/api/data.js?days=7 (Vercel serverless, verifiserer Supabase auth token)
    ↓
index.html (statisk, ECharts + Tailwind CSS + Supabase Auth)
```

## Filstruktur

```
/
├── api/
│   ├── collect.js        # Cron-endepunkt: Tibber + Frost → Supabase
│   └── data.js           # Data-endepunkt: Supabase → JSON (auth-beskyttet)
├── public/
│   └── index.html         # Dashboard: ECharts + Tailwind + Supabase Auth
├── vercel.json            # Vercel-konfigurasjon
├── .github/
│   └── workflows/
│       └── collect.yml    # GitHub Actions cron-trigger
├── .env.example           # Template for environment variables
└── CLAUDE.md
```

## Tech Stack

- **Runtime**: Vercel serverless functions (Node.js)
- **Database**: Supabase (PostgreSQL) – free tier
- **Auth**: Supabase Auth med Google OAuth
- **Grafer**: ECharts (via CDN)
- **Styling**: Tailwind CSS (via CDN)
- **Cron**: GitHub Actions (kjører :15 over hver time)
- **Ingen build step, ingen bundler, ingen React/Next.js**

## Supabase

### Tabell

```sql
CREATE TABLE consumption (
  timestamp TIMESTAMPTZ PRIMARY KEY,
  consumption_kwh NUMERIC NOT NULL,
  outside_temp_c NUMERIC
);
```

### RLS

- Aktiver Row Level Security på `consumption`-tabellen
- Policy: Tillat `SELECT` kun for autentiserte brukere
- Ingen public access – all lesing går via `/api/data.js` som verifiserer token

### Auth

- Sett opp Google OAuth provider i Supabase dashboard
- Konfigurer redirect URL til Vercel-domenet
- Begrens tilgang til spesifikke e-postadresser om ønskelig

## Environment Variables (Vercel)

```
TIBBER_API_TOKEN=           # Fra developer.tibber.com
TIBBER_HOME_ID=             # Home ID fra Tibber (finn via API explorer)
SUPABASE_URL=               # Supabase prosjekt-URL
SUPABASE_SERVICE_KEY=       # Supabase service_role key (kun server-side)
SUPABASE_ANON_KEY=          # Supabase anon key (brukes i frontend)
CRON_SECRET=                # Hemmelig nøkkel for å sikre collect-endepunktet
FROST_CLIENT_ID=            # Fra frost.met.no
```

## /api/collect.js

### Sikkerhet
- Sjekk `x-cron-secret` header mot `CRON_SECRET` env var
- Returner 401 hvis mismatch

### Tibber API
- GraphQL-endepunkt: `https://api.tibber.com/v1-beta/gql`
- Auth: `Bearer ${TIBBER_API_TOKEN}`
- Default: hent siste 24 timer (`last: 24`)
- Støtter `?hours=N` query parameter for backfill
- For hours > 744: loop i batches à 744 med `first`/`after` paginering

```graphql
{
  viewer {
    homes {
      consumption(resolution: HOURLY, last: 24) {
        nodes {
          from
          to
          consumption
        }
      }
    }
  }
}
```

### Frost API (met.no)
- Endepunkt: `https://frost.met.no/observations/v0.jsonld`
- Auth: Basic auth med `FROST_CLIENT_ID` som brukernavn, tomt passord
- Hent timetemperatur fra nærmeste værstasjon
- Krever `User-Agent`-header med kontaktinfo
- Slå opp passende stasjon-ID for brukerens lokasjon

### Upsert til Supabase
- Bruk `supabase.from('consumption').upsert()` med `timestamp` som conflict target
- Upsert gjør at gjentatte kjøringer er idempotente og selvhelende
- Skriv både `consumption_kwh` og `outside_temp_c` i samme operasjon

## /api/data.js

### Auth
- Les `Authorization: Bearer <token>` fra request header
- Verifiser token med Supabase: `supabase.auth.getUser(token)`
- Returner 401 hvis ugyldig

### Query
- Aksepter `?days=N` parameter (default: 7)
- Hent rader fra Supabase sortert på timestamp
- Returner JSON-array med `{ timestamp, consumption_kwh, outside_temp_c }`

## GitHub Actions Workflow

```yaml
name: Collect energy data
on:
  schedule:
    - cron: '15 * * * *'
  workflow_dispatch:        # Manuell trigger for testing
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -f -X POST ${{ vars.COLLECT_URL }} \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
```

- `COLLECT_URL` som repository variable (ikke secret, bare URL)
- `CRON_SECRET` som repository secret
- `workflow_dispatch` for å kunne trigge manuelt
- `-f` flag på curl for å feile ved HTTP-feil

## Frontend (index.html)

### Avhengigheter (CDN)
- ECharts: `https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js`
- Tailwind CSS: `https://cdn.tailwindcss.com`
- Supabase JS: `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`
- Font: JetBrains Mono fra Google Fonts

### Auth-flyt
1. Initialiser Supabase-klient med `SUPABASE_URL` og `SUPABASE_ANON_KEY`
2. Sjekk `supabase.auth.getSession()`
3. Hvis ikke innlogget: vis "Logg inn med Google"-knapp
4. Knappen kaller `supabase.auth.signInWithOAuth({ provider: 'google' })`
5. Etter redirect tilbake: hent session og bruk access_token til API-kall

### Dashboard-layout

```
┌──────────────────────────────────────────────┐
│  ⚡ Strømforbruk                  [7d 30d 1y] │  ← Periodevelger
├──────────┬───────────────────────────────────┤
│          │                                   │
│  GAUGE   │     Linjegraf                     │
│  1.2 kW  │     (rådata + 24t rullende snitt) │
│  snitt   │                                   │
│  24t     │     [════════ dataZoom ══════════] │
│          │                                   │
├──────────┴───────────────────────────────────┤
│                                              │
│  Temperatur vs forbruk (scatter/dual-axis)   │
│                                              │
├──────────────────────────────────────────────┤
│                                              │
│  Heatmap: ukedag × klokketime               │
│                                              │
├──────────────────────────────────────────────┤
│                                              │
│  Snitt per ukedag (bar chart)                │
│                                              │
└──────────────────────────────────────────────┘
```

### Grafana-inspirert tema

Felles ECharts-konfigurasjon for alle grafer:

- Bakgrunn: `transparent` (siden har mørk bakgrunn)
- Sidebakgrunn: `#0f0f23` eller `#1a1a2e`
- Paneler: halvtransparente med subtile borders (`rgba(255,255,255,0.05)`), `backdrop-blur`
- Tekstfarge: `#a0a0b0`
- Font: `JetBrains Mono, monospace` for tall og akser
- Grid-linjer: `rgba(255,255,255,0.05)`
- Akselinjer: `#333`
- Primærfarge (forbruk): `#22d3ee` (cyan)
- Sekundærfarge (temperatur): `#f97316` (oransje)
- Linjegraf med gradient areaStyle (farge → transparent nedover)
- `smooth: true` på linjer
- dataZoom-komponent for zoom/pan på tidsakse

### Client-side beregninger

All aggregering gjøres i JavaScript etter at rådata er hentet:

- **Rullende 24t-snitt**: sliding window over 24 datapunkter
- **Snitt per ukedag**: grupper på `getDay()`, beregn gjennomsnitt
- **Snitt per klokketime**: grupper på `getHours()`, beregn gjennomsnitt
- **Heatmap-data**: kryss av ukedag × klokketime med snittverdi

## Backfill (initial datainnhenting)

Kjøres én gang manuelt for å fylle databasen med historisk data:

```bash
curl -X POST "https://din-app.vercel.app/api/collect?hours=8760" \
  -H "x-cron-secret: din-nøkkel"
```

- Tibber har data 1-2 år tilbake
- For å finne hvor langt tilbake: spør med `last: 100000`, den returnerer bare det som finnes
- Funksjonen looper automatisk i batches à 744 timer ved hours > 744

## Viktige detaljer

- Tibber API bruker GraphQL med Bearer token auth
- Frost API bruker Basic auth (client_id som brukernavn, tomt passord) og krever User-Agent header
- Supabase anon key er trygg å eksponere i frontend – sikkerhet styres av RLS og token-verifisering
- Supabase service key brukes KUN i serverless functions, aldri i frontend
- Vercel free tier (Hobby) er tilstrekkelig – cron håndteres av GitHub Actions
- Supabase free tier holder i årevis med denne datamengden (~8760 rader/år)
- GitHub Actions cron er ikke presis (5-15 min forsinkelse), men irrelevant for timedata
- Kjør cron :15 over hver time for å gi Tibber tid til å aggregere
