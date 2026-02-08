# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Oversikt

Personlig strømforbruk-dashboard som henter timedata fra Tibber API, lagrer i Supabase, og visualiserer med ECharts. Hostet på Vercel. Grafana-inspirert mørkt tema.

## Utvikling

- **Ingen build step, ingen bundler, ingen React/Next.js** – ren HTML + vanilla JS (ES modules) + Vercel serverless functions (CommonJS)
- Lokal utvikling: `vercel dev` (krever Vercel CLI og `.env`-fil med alle variabler fra Environment Variables-seksjonen)
- Deploy: push til `main` → Vercel bygger automatisk
- Manuell datainnsamling: `curl -X POST http://localhost:3000/api/collect -H "x-cron-secret: <din-nøkkel>"`
- Ingen tester, ingen linter konfigurert

## Arkitektur

```
GitHub Actions (cron, :15 hver time)
    ↓
/api/collect.js (Vercel serverless function, CommonJS)
    ↓ henter siste 24t fra Tibber API via tibber-api-pakken (upsert, selvhelende)
    ↓ henter temperatur fra Frost API (met.no, stasjon SN17280)
    ↓
Supabase (PostgreSQL)
    ↓
Frontend spør Supabase direkte via JS-klienten (RLS sikrer tilgang)
    ↓
public/index.html + ES modules (ECharts + Tailwind CSS + Supabase Auth)
```

## Filstruktur

```
/
├── api/
│   └── collect.js          # Cron-endepunkt: Tibber + Frost → Supabase (CommonJS)
├── public/
│   ├── index.html           # HTML-skjelett, CDN-imports, login-skjerm, dashboard-layout
│   └── js/
│       ├── app.js           # Entry point: auth, periodevelger, orkestrering
│       ├── auth.js          # Supabase-klient, login/logout, session-håndtering
│       ├── data.js          # Hent data fra Supabase, cache, beregninger
│       └── charts.js        # Alle 5 ECharts-konfigurasjoner og rendering
├── package.json             # Avhengigheter: @supabase/supabase-js, tibber-api
├── vercel.json              # Vercel-konfigurasjon (maxDuration: 60 for collect)
├── .github/
│   └── workflows/
│       └── collect.yml      # GitHub Actions cron-trigger
├── .env.example             # Template for environment variables
└── CLAUDE.md
```

## Tech Stack

- **Runtime**: Vercel serverless functions (Node.js)
- **Database**: Supabase (PostgreSQL) – free tier
- **Auth**: Supabase Auth med e-post/passord
- **Tibber**: `tibber-api@^5` npm-pakke (wrapper rundt GraphQL API)
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

- Row Level Security aktivert på `consumption`-tabellen
- Policy: Tillat `SELECT` kun for autentiserte brukere
- Frontend spør Supabase direkte – ingen egen API-rute for lesing

### Auth

- E-post/passord-innlogging via Supabase Auth
- Supabase anon key hardkodet i `public/js/auth.js`

## Environment Variables

### Vercel (Settings → Environment Variables)

```
TIBBER_API_TOKEN=           # Fra developer.tibber.com
TIBBER_HOME_ID=             # Home ID fra Tibber (finn via API explorer)
SUPABASE_URL=               # Supabase prosjekt-URL
SUPABASE_SERVICE_KEY=       # Supabase service_role key (kun server-side)
CRON_SECRET=                # Hemmelig nøkkel for å sikre collect-endepunktet
FROST_CLIENT_ID=            # Fra frost.met.no
```

### GitHub Actions (Settings → Secrets and variables → Actions)

- **Repository secret**: `CRON_SECRET` – samme verdi som i Vercel
- **Repository variable**: `COLLECT_URL` – `https://energy-dashboard-tan.vercel.app/api/collect`

## /api/collect.js

### Sikkerhet
- Kun POST-metode tillatt
- Sjekk `x-cron-secret` header mot `CRON_SECRET` env var
- Returner 401 hvis mismatch

### Tibber API
- Bruker `tibber-api` npm-pakken (`TibberQuery`)
- Henter for spesifikt hjem via `TIBBER_HOME_ID`
- Default: hent siste 24 timer via `getConsumption('HOURLY', 24, homeId)`
- Støtter `?hours=N` query parameter for backfill
- For hours > 744: paginerer med rå GraphQL (`first`/`after`) via `home(id: "...")`

### Frost API (met.no)
- Endepunkt: `https://frost.met.no/observations/v0.jsonld`
- Auth: Basic auth med `FROST_CLIENT_ID` som brukernavn, tomt passord
- Stasjon: SN17280 (Gullholmen)
- Krever `User-Agent`-header
- Frost-feil stopper ikke innsamlingen – temperatur settes til null

### Upsert til Supabase
- Dedupliserer rader på timestamp (Map) før innsetting
- Upsert i chunks à 1000 rader med `onConflict: 'timestamp'`
- Idempotent – gjentatte kjøringer er trygge

## GitHub Actions Workflow

```yaml
name: Collect energy data
on:
  schedule:
    - cron: '15 * * * *'
  workflow_dispatch:
jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -f -X POST ${{ vars.COLLECT_URL }} \
            -H "x-cron-secret: ${{ secrets.CRON_SECRET }}"
```

## Frontend

### Avhengigheter (CDN)
- ECharts: `https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js`
- Tailwind CSS: `https://cdn.tailwindcss.com`
- Supabase JS: `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`
- Font: JetBrains Mono fra Google Fonts

### Auth-flyt
1. Initialiser Supabase-klient med hardkodede `SUPABASE_URL` og `SUPABASE_ANON_KEY` i `auth.js`
2. Sjekk `supabase.auth.getSession()`
3. Hvis ikke innlogget: vis login-skjerm med e-post/passord
4. Kaller `supabase.auth.signInWithPassword()`
5. Etter innlogging: hent data direkte fra Supabase via JS-klienten

### Data-henting og cache
- Frontend spør Supabase direkte (ingen `/api/data.js`-rute)
- Paginerer i batches à 1000 rader (Supabase default-limit)
- **localStorage-cache** med 1 times TTL per periode (7d/30d/365d)
- Refresh-knapp tømmer cache og henter ferske data

### Periodevelger og aggregering
- **7d**: Timedata, x-akse viser hele timer, 24t rullende snitt
- **30d**: Timedata, x-akse viser datoer, 24t rullende snitt
- **1y**: Daglige snitt (aggregert client-side), x-akse viser måneder, 7d rullende snitt

### Dashboard-layout

```
┌──────────────────────────────────────────────────────┐
│  Strømforbruk              [7d 30d 1y] [↻] [Logg ut] │
├──────────┬───────────────────────────────────────────┤
│          │                                           │
│  GAUGE   │  Linjegraf (dual-axis)                    │
│  snitt   │  - Forbruk (cyan) + rullende snitt (lilla)│
│  24t     │  - Temperatur (oransje, høyre y-akse)     │
│          │  [════════ dataZoom ══════════]            │
│          │                                           │
├──────────┴───────────────────────────────────────────┤
│  Temperatur vs forbruk (scatter)                     │
├──────────────────────────────────────────────────────┤
│  Heatmap: ukedag × klokketime                       │
├──────────────────────────────────────────────────────┤
│  Snitt per ukedag (bar chart)                        │
└──────────────────────────────────────────────────────┘
```

### Grafana-inspirert tema

- Sidebakgrunn: `#0f0f23`
- Paneler: `rgba(26, 26, 46, 0.8)` med `backdrop-filter: blur(8px)` og border `rgba(255,255,255,0.05)`
- Tekstfarge: `#a0a0b0`
- Font: `JetBrains Mono, monospace`
- Grid-linjer: `rgba(255,255,255,0.05)`
- Primærfarge (forbruk): `#22d3ee` (cyan)
- Snitt-linje: `#a78bfa` (lilla)
- Temperatur: `#f97316` (oransje)

### Client-side beregninger (data.js)

- **Rullende snitt**: sliding window (24 timer eller 7 dager)
- **Daglig snitt**: aggregering per dato for årsvisning
- **Snitt per ukedag**: grupper på `getDay()`, rekkefølge man–søn
- **Heatmap-data**: kryss av ukedag (man=0) × klokketime med snittverdi

## Backfill (initial datainnhenting)

Kjøres én gang manuelt for å fylle databasen med historisk data:

```bash
curl -X POST "https://energy-dashboard-tan.vercel.app/api/collect?hours=100000" \
  -H "x-cron-secret: din-nøkkel"
```

- Tibber har data 1-2 år tilbake
- `hours=100000` henter alt som finnes (returnerer bare det som eksisterer)
- Funksjonen paginerer automatisk i batches à 744 timer
- Deduplisering sikrer at gjentatte kjøringer er trygge

## Viktige detaljer

- `api/collect.js` er CommonJS (Vercel default uten framework)
- Frontend-JS er ES modules (`<script type="module">`)
- Tibber API aksesseres via `tibber-api` npm-pakke, ikke rå GraphQL
- Frost API bruker Basic auth (client_id som brukernavn, tomt passord) og krever User-Agent header
- Supabase anon key er trygg å eksponere i frontend – sikkerhet styres av RLS
- Supabase service key brukes KUN i `api/collect.js`, aldri i frontend
- Vercel free tier (Hobby) er tilstrekkelig – cron håndteres av GitHub Actions
- Supabase free tier holder i årevis med denne datamengden (~8760 rader/år)
- GitHub Actions cron er ikke presis (5-15 min forsinkelse), men irrelevant for timedata
