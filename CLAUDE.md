# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Viktig: Aldri push uten brukerens godkjenning

**ALDRI kjør `git push` uten at brukeren eksplisitt har testet og bekreftet at endringene fungerer.** Commit lokalt, men vent alltid på brukerens godkjenning før push.

## Viktig: Hold README.md oppdatert

Når funksjonalitet legges til eller endres, **må README.md oppdateres i samme commit**. README er den primære oppsettguiden for prosjektet og inneholder database-skjema, oppsettsinstruksjoner og funksjonsbeskrivelser som må speile faktisk kode.

## Oversikt

Personlig strømforbruk-dashboard som henter timedata fra Tibber API, lagrer i Supabase, og visualiserer med ECharts. Hostet på Vercel. Grafana-inspirert mørkt tema. Støtter flere hjem (Tibber homes) via `homes`-tabell – brukeren velger hjem via dropdown i headeren.

## Utvikling

- **Ingen build step, ingen bundler, ingen React/Next.js** – ren HTML + vanilla JS (ES modules) + Vercel serverless functions (CommonJS)
- Lokal utvikling: `vercel dev` (krever Vercel CLI og `.env.local`-fil med alle variabler fra Environment Variables-seksjonen)
- Deploy: push til `main` → Vercel bygger automatisk
- Manuell datainnsamling: `curl -X POST http://localhost:3000/api/collect -H "x-cron-secret: <din-nøkkel>"`
- Ingen tester, ingen linter konfigurert

## Arkitektur

```
cron-job.org (ekstern cron, hver time)
    ↓
/api/collect.js (Vercel serverless function, CommonJS)
    ↓ henter siste 24t fra Tibber GraphQL API (upsert, selvhelende)
    ↓ henter temperatur fra Frost API (met.no, stasjon SN17280)
    ↓
Supabase (PostgreSQL)
    ↓
Frontend spør Supabase direkte via JS-klienten (RLS sikrer tilgang)
    ↓
public/index.html + ES modules (ECharts + Nerdesign + Supabase Auth)
```

## Filstruktur

```
/
├── api/
│   ├── collect.js           # Cron-endepunkt: Tibber + Frost → Supabase (CommonJS)
│   └── forecast.js          # Temperaturprognose-proxy: met.no → frontend (CommonJS)
├── public/
│   ├── index.html           # HTML-skjelett, CDN-imports, login-skjerm, dashboard-layout
│   └── js/
│       ├── app.js           # Entry point: auth, periodevelger, hjemvelger, datatabeller, orkestrering
│       ├── auth.js          # Supabase-klient, login/logout, session-håndtering
│       ├── data.js          # Hent data fra Supabase, cache, beregninger, regresjon, prognose
│       └── charts.js        # Alle 10 ECharts-konfigurasjoner og rendering
├── package.json             # Avhengighet: @supabase/supabase-js
├── vercel.json              # Vercel-konfigurasjon (maxDuration: 60 for collect, 10 for forecast)
├── .env.example             # Template for environment variables
└── CLAUDE.md
```

## Tech Stack

- **Runtime**: Vercel serverless functions (Node.js)
- **Database**: Supabase (PostgreSQL) – free tier
- **Auth**: Supabase Auth med e-post/passord
- **Tibber**: Direkte GraphQL-kall med native fetch (ingen npm-pakke)
- **Temperatur**: Frost API (met.no, stasjon SN17280)
- **Grafer**: ECharts (via CDN)
- **Styling**: Nerdesign (vendret i `public/nd/`, se «Design og tema»)
- **Cron**: cron-job.org (ekstern, hver time)
- **Ingen build step, ingen bundler, ingen React/Next.js**

## Supabase

### Tabeller

```sql
CREATE TABLE homes (
  id TEXT PRIMARY KEY,        -- Tibber home ID
  name TEXT NOT NULL,         -- Visningsnavn ("Hjemme", "Hytta")
  sort_order INT DEFAULT 0,
  lat NUMERIC,                -- Breddegrad (for temperaturprognose)
  lon NUMERIC,                -- Lengdegrad (for temperaturprognose)
  frost_station TEXT           -- Frost-stasjon (default: SN17280)
);

CREATE TABLE consumption (
  home_id TEXT NOT NULL REFERENCES homes(id),
  timestamp TIMESTAMPTZ NOT NULL,
  consumption_kwh NUMERIC,
  outside_temp_c NUMERIC,
  PRIMARY KEY (home_id, timestamp)
);
CREATE INDEX idx_consumption_timestamp ON consumption (timestamp);
```

- `consumption_kwh` tillater NULL (Tibber returnerer null for nylige timer som ikke er aggregert ennå)
- `home_id` refererer til `homes`-tabellen – hvert hjem har egne forbruksrader
- Homes konfigureres direkte i `homes`-tabellen (ikke via env vars)
- `lat`/`lon` brukes av prognosegrafer til å hente temperaturprognose fra met.no
- `frost_station` er valgfri – default `SN17280` (Gullholmen). Hvert hjem kan ha sin egen stasjon

### RLS

- Row Level Security aktivert på `consumption`- og `homes`-tabellene
- Policy: Tillat `SELECT` kun for autentiserte brukere
- Frontend spør Supabase direkte – ingen egen API-rute for lesing

### Auth

- E-post/passord-innlogging via Supabase Auth
- Supabase anon key hardkodet i `public/js/auth.js`

## Environment Variables

### Vercel (Settings → Environment Variables)

```
TIBBER_API_TOKEN=           # Fra developer.tibber.com
SUPABASE_URL=               # Supabase prosjekt-URL
SUPABASE_SERVICE_KEY=       # Supabase service_role key (kun server-side)
CRON_SECRET=                # Hemmelig nøkkel for å sikre collect-endepunktet
FROST_CLIENT_ID=            # Fra frost.met.no
```

- Home IDs konfigureres i `homes`-tabellen i Supabase, ikke som env var

### Cron (cron-job.org)

Ekstern cron-jobb som POSTer til collect-endepunktet:
- **URL**: `https://energy-dashboard-tan.vercel.app/api/collect`
- **Metode**: `POST`
- **Header**: `x-cron-secret` = samme verdi som `CRON_SECRET` i Vercel
- **Schedule**: hver time

## /api/collect.js

### Sikkerhet
- Kun POST-metode tillatt
- Sjekk `x-cron-secret` header mot `CRON_SECRET` env var
- Returner 401 hvis mismatch

### Tibber API
- Direkte GraphQL-kall med native fetch mot `https://api.tibber.com/v1-beta/gql`
- Henter homes fra `homes`-tabellen i Supabase, looper over alle
- Støtter `?home=<id>` query parameter for å kjøre innsamling for ett spesifikt hjem (nyttig for backfill)
- Default: hent siste 72 timer (`last: 72`)
- Støtter `?hours=N` query parameter for backfill
- For hours > 744: paginerer med `first`/`after` i batches à 744

### Frost API (met.no)
- Endepunkt: `https://frost.met.no/observations/v0.jsonld`
- Auth: Basic auth med `FROST_CLIENT_ID` som brukernavn, tomt passord
- Stasjon: konfigurerbar per hjem via `frost_station`-kolonne i `homes`-tabellen (default: SN17280 Gullholmen)
- Krever `User-Agent`-header
- Frost-feil stopper ikke innsamlingen – temperatur settes til null

### Upsert til Supabase
- Dedupliserer rader på timestamp per hjem (Map) før innsetting
- Legg til `home_id` i hver rad
- Upsert i chunks à 1000 rader med `onConflict: 'home_id,timestamp'`
- Frost-temperatur hentes én gang per unik stasjon, deretter fordeles til hjem via stasjon-mapping
- Idempotent – gjentatte kjøringer er trygge

## /api/forecast.js

### Temperaturprognose-proxy
- GET-endepunkt, åpent (ingen auth) – brukes av frontend for temperaturprognose
- Query params: `?lat=<breddegrad>&lon=<lengdegrad>`
- Validerer lat/lon-input

### Datakilder (hentes parallelt)
- **Locationforecast 2.0** (met.no): Timedata 0–65t + 6-timers intervaller til ~10 dager. Returnerer `temp`, `temp_p10`, `temp_p90` per time
- **Subseasonal 1.0** (met.no): Daglige snitt dag 1–21. Returnerer `temp_mean`, `temp_p10`, `temp_p90` per dag
- Begge bruker `User-Agent`-header (påkrevd av met.no)

### Respons
- `{ hourly: [...], daily: [...] }` – daily filtreres: kun datoer med ≥20 timeoppføringer i hourly ekskluderes (typisk de første 2–3 dagene med full timedekning). Datoer med sparse 6-timersdata (4 oppføringer/dag) beholdes i daily
- HTTP-cache: `Cache-Control: public, s-maxage=3600, max-age=0` – CDN cacher i 1t, nettleseren revaliderer alltid (unngår stale data ved kodeendringer)
- Vercel maxDuration: 10s

## Cron (cron-job.org)

Datainnsamlingen trigges av en ekstern cron-tjeneste ([cron-job.org](https://cron-job.org)) som POSTer til collect-endepunktet hver time med `x-cron-secret`-headeren. GitHub Actions brukes ikke – planlagte workflows struper sub-timesintervaller mot ~hver time. collect henter uansett siste 72t, så tapte kjøringer etterfylles automatisk neste gang.

## Design og tema – Nerdesign

UI-en bruker designsystemet **Nerdesign** (https://offline.no/nerdesign/), kopiert
inn i `public/nd/` fra en fast release (versjonslinjen står øverst i `nd/nd.css`).
Ikke rediger `nd/`; oppgrader med
`~/dev/nerdegutt/nerdesign-private/tools/copy-to.sh public --with-fonts --release vX.Y.Z`.
Bruk Claude-skillen `nerdesign` for tokens og markup.

- Ingen Tailwind, ingen Google Fonts: `nd/nd-fonts.css` (JetBrains Mono, selvhostet) + `nd/nd.css`.
  ECharts og Supabase kommer fortsatt fra jsDelivr.
- Lyst og mørkt følger systeminnstillingen eller bryteren i toppstripen (`nd-theme.js`).
  Ved temabytte kjøres `loadData()` på nytt (ECharts binder tema ved `init`).
- `charts.js` har ingen hardkodede farger: `syncTokens()` leser `--nd-*` fra siden og
  setter CYAN/ORANGE/VIOLET/GREEN/RED/BLUE/TEAL, grid, akser og font. Den kalles fra
  `getOrCreate()`, som alle renderne bruker.
- Grafene ligger i `.nd-chart`-seksjoner med `.nd-chart-title`, `.nd-chart-canvas`
  (`role="img"` i markupen) og `.nd-datatable`. ECharts' egen `title` er fjernet –
  panelets overskrift navngir grafen.
- Datatabellene bygges med `nd.buildDataTable` (tekst, ikke HTML) og styres av
  `nd.wireDataTables()`. `nd.announce` erstatter den lokale live-regionen.
- Synlighet styres med `hidden`-attributtet, ikke klasser.
- Regresjonsformlene skriver tekst i tekstfargen med et lite fargemerke foran –
  farget tekst gav for lav kontrast.

## Backfill (initial datainnhenting)

Kjøres én gang manuelt per hjem for å fylle databasen med historisk data:

```bash
# Alle hjem:
curl -X POST "https://energy-dashboard-tan.vercel.app/api/collect?hours=100000" \
  -H "x-cron-secret: din-nøkkel"

# Spesifikt hjem:
curl -X POST "https://energy-dashboard-tan.vercel.app/api/collect?hours=100000&home=<TIBBER_HOME_ID>" \
  -H "x-cron-secret: din-nøkkel"
```

- Tibber har data 1-2 år tilbake
- `hours=100000` henter alt som finnes (returnerer bare det som eksisterer)
- `home=<id>` begrenser til ett hjem (nyttig ved nytt hjem uten å kjøre alle på nytt)
- Funksjonen paginerer automatisk i batches à 744 timer
- Deduplisering sikrer at gjentatte kjøringer er trygge

## Viktige detaljer

- `api/collect.js` er CommonJS (Vercel default uten framework)
- Frontend-JS er ES modules (`<script type="module">`)
- Tibber API aksesseres via direkte GraphQL-kall med native fetch
- Frost API bruker Basic auth (client_id som brukernavn, tomt passord) og krever User-Agent header
- Supabase anon key er trygg å eksponere i frontend – sikkerhet styres av RLS
- Supabase service key brukes KUN i `api/collect.js`, aldri i frontend
- Vercel free tier (Hobby) er tilstrekkelig – cron håndteres av cron-job.org (ekstern)
- Supabase free tier holder i årevis med denne datamengden (~8760 rader/år per hjem)
- cron-job.org kjører hver time; collect henter uansett siste 72t, så tapte/forsinkede kjøringer etterfylles automatisk
- `vercel dev` leser `.env.local` (ikke `.env`) – bruk `vercel env pull` eller opprett manuelt
- Collect lagrer rader med null consumption (Tibber returnerer null for nylige timer) – temperaturdata bevares
- Tibber-data kan ha hull (manglende timer) for inneværende dag pga forsinkelser – prognosefunksjoner fyller hull med modellprediksjoner time-for-time
- Alle client-side beregninger håndterer null-verdier i consumption_kwh
- met.no API-er (Locationforecast, Subseasonal) krever `User-Agent`-header – proxyes via `/api/forecast.js` for å unngå CORS
- Sesongmodellen beregnes fra siste 1 års timedata (~8760 punkter) og brukes av alle prognosegrafer + gauge-avvik
- MAD-outlier-fjerning er robust mot de samme outlierene den fjerner (i motsetning til standardavvik), én iterasjon er tilstrekkelig
