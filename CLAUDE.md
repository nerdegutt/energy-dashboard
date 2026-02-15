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
GitHub Actions (cron, :15 hver time)
    ↓
/api/collect.js (Vercel serverless function, CommonJS)
    ↓ henter siste 24t fra Tibber GraphQL API (upsert, selvhelende)
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
- **Tibber**: Direkte GraphQL-kall med native fetch (ingen npm-pakke)
- **Temperatur**: Frost API (met.no, stasjon SN17280)
- **Grafer**: ECharts (via CDN)
- **Styling**: Tailwind CSS (via CDN)
- **Cron**: GitHub Actions (kjører :15 over hver time)
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

### GitHub Actions (Settings → Secrets and variables → Actions)

- **Repository secret**: `CRON_SECRET` – samme verdi som i Vercel
- **Repository variable**: `COLLECT_URL` – `https://energy-dashboard-tan.vercel.app/api/collect`

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
- **localStorage-cache** med 1 times TTL per hjem og periode (nøkkel: `energy_v3_<homeId>_<days>`)
- **Kompakt cache-format**: rader lagres som `[YYYYMMDDHH, kwh, temp]`-arrays – ~3.5× mindre enn fulle objekter
- Kun per-hjem-data caches – "Alle" bygges fra per-hjem-cacher via `mergeHomes()` (tar <1 ms)
- Cache-versjon bumpes (`v2` → `v3` osv.) ved formatendringer – gamle oppføringer ryddes automatisk
- **"Alle"-modus**: henter hvert hjem i parallell (`Promise.all`), deretter `mergeHomes()` som summerer `consumption_kwh` per timestamp og beholder første `outside_temp_c`
- Refresh-knapp tømmer cache og henter ferske data
- **Manglende timer fylles inn** med null-verdier (`fillMissingHours`) for komplett tidsrekke
- Alle beregninger (snitt, heatmap, weekday) filtrerer bort null-verdier

### URL-state
- Valgt hjem og periode persisteres i URL query params (`?home=<id>&days=<n>`)
- Default (første hjem, 24t) gir ren URL uten params. "Alle" og andre hjem gir `?home=all` / `?home=<id>`
- `history.replaceState` brukes for å unngå å forurense nettleserhistorikken

### Periodevelger og aggregering
- **24t**: Timedata, x-akse viser klokkeslett (hver 3. time), ingen rullende snitt
- **7d**: Timedata, x-akse viser datoer (hver dag), 24t rullende snitt
- **28d**: Timedata, x-akse viser datoer (hver mandag), 24t rullende snitt
- **1y**: Daglige snitt (aggregert client-side), x-akse viser "mnd år" (1. i hver mnd), 7d rullende snitt

### Grafer

**Alle perioder:**
- **Gauge**: Snitt for valgt periode (dynamisk label). I 24t-visning vises avvik fra forventet (sesongmodell)
- **Linjegraf** (dual-axis): Forbruk + rullende snitt (skjult i 24t-modus) + temperatur
- **Kumulativ strømstøtte** (kun individuelle hjem): Kumulativt forbruk denne måneden med projisert total mot 5000 kWh-grensen. Viser faktisk (hel linje), projisert (stiplet), usikkerhetsbånd (p10/p90), og daglig forbruk som søyler. Bruker temperaturprognose fra met.no + sesongmodell for prediksjon
- **Forbruksprognose** (7d + 21d): 7 dager tilbake med faktisk forbruk + 21 dager fremover med predikert forbruk. Dual-axis med temperatur. Usikkerhetsbånd for både forbruk og temperatur. Bruker timedata fra Locationforecast (kort horisont) og daglige snitt fra Subseasonal (lang horisont)
- **År-over-år sammenligning**: Alltid fullt år, 28d rullende snitt, sammenligner med nøyaktig 1 år tilbake (håndterer skuddår via `setFullYear`). Rød fyll mellom linjene der siste år > forrige periode, grønn fyll der siste år < forrige periode. Tooltip viser prosentvis differanse. Legend: "Siste år" (cyan) og "Forrige periode" (lilla).
- **Månedlig endring**: Prosentvis endring per måned vs. tilsvarende måned året før. Grønn = mindre, rød = mer. Labels over stolpene viser %-verdi. Tooltip: "x% mer/mindre enn året før".
- **Månedlig totalforbruk**: Gruppert stolpediagram som viser totalt forbruk per måned (jan–des), med én stolpe per tilgjengelig år. Henter data separat fra 1. januar `currentYear-2` (maks 2 hele foregående år + inneværende). Første ufullstendige måned skippes automatisk. Inneværende måned viser faktisk forbruk + projisert rest (transparent forlengelse) basert på `monthlyProjection`. Rød stiplet markLine på 5000 kWh (strømstøttegrense, kun individuelle hjem). Farger: oransje, lilla, cyan, grønn (syklisk). Tooltip viser faktisk + projisert total i parentes.

**Kun årsvisning (365d):**
- **Scatter**: Temperatur vs forbruk med lineær, kvadratisk og sesongregresjon. Viser vinter-kurve (jan, blå stiplet) og sommer-kurve (jul, grønn stiplet) fra sesongmodellen. R²-verdier for alle tre modeller + antall fjernede outliers. Akser: `onZero: false` for å tvinge aksene til grid-kanten (unngår at y-aksen tegnes ved 0°C), x-akse-label sentrert under grafen
- **Heatmap**: Ukedag × klokketime
- **Snitt per ukedag**: Bar chart man–søn

### Datatabeller
- Hver graf (unntatt gauge) har en "Vis datatabell"-knapp som toggler en HTML-tabell med grafens data
- Tabellen er skjult som default, synlig for alle når den åpnes
- `buildTable(chartId, headers, rows)` i `app.js` bygger tabellen og setter inn i `.chart-table`-containeren
- Toggle via event delegation på `#charts-container` – oppdaterer `aria-expanded` og knappetekst
- Tabellene populeres i `loadData()` etter graf-rendering med data fra samme kilde som grafen
- Formatering: `DD.MM.YY HH:00` for timer, `DD.MM.YYYY` for dager, `.toFixed(2)` for kWh, `.toFixed(1)` for °C og %, `–` for null
- CSS: sticky header, `tabular-nums`, scrollbar med `max-h-64`

### Dashboard-layout

```
┌──────────────────────────────────────────────────────────┐
│  Strømforbruk  [▾ Alle] [24t 7d 28d 1y] [↻] [Logg ut]   │
├──────────┬───────────────────────────────────────────────┤
│  GAUGE   │  Linjegraf (dual-axis)                        │
│  snitt   │  - Forbruk (cyan) + rullende snitt (lilla)    │
│  periode │  - Temperatur (oransje, høyre y-akse)         │
├──────────┴───────────────────────────────────────────────┤
│  Kumulativt forbruk (strømstøtte) [kun individuelle hjem]│
├──────────────────────────────────────────────────────────┤
│  Forbruksprognose (7d + 21d)                             │
├──────────────────────────────────────────────────────────┤
│  Temperatur vs forbruk (scatter) [kun 1y]                │
├──────────────────────────────────────────────────────────┤
│  År-over-år sammenligning (28d rullende snitt)           │
├──────────────────────────────────────────────────────────┤
│  Månedlig endring vs. forrige år (bar chart)             │
├──────────────────────────────────────────────────────────┤
│  Månedlig totalforbruk per år (gruppert bar chart)        │
├──────────────────────────────────────────────────────────┤
│  Heatmap: ukedag × klokketime [kun 1y]                   │
├──────────────────────────────────────────────────────────┤
│  Snitt per ukedag (bar chart) [kun 1y]                   │
└──────────────────────────────────────────────────────────┘
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
- **Chart-hjelpefunksjoner** i `charts.js`: `baseTextStyle()`, `baseAxisLine()`, `baseSplitLine()`, `baseTooltip(overrides)` – felles config som gjenbrukes av alle grafer. `baseTooltip` returnerer `confine`, `backgroundColor`, `borderColor` og `textStyle`, og tar imot overrides (typisk `trigger` og `formatter`)
- **`hideOverlap: true`** på `axisLabel` i linje- og YoY-graf – ECharts skjuler automatisk overlappende labels på smale skjermer

### Client-side beregninger (data.js)

- **`packRows`/`unpackRows`**: Komprimerer rader til `[YYYYMMDDHH, kwh, temp]` for localStorage-cache
- **`fetchSingleHome`**: Henter data for ett hjem med paginering, cacher resultatet
- **`mergeHomes`**: Grupperer rader per timestamp, summerer `consumption_kwh`, beholder første `outside_temp_c` (brukes for "Alle"-visning)
- **`fillMissingHours`**: Fyller inn manglende timer med null-verdier for komplett tidsrekke
- **`rollingAverage`**: Sliding window (24 timer eller 7 dager), filtrerer null
- **`dailyAverage`**: Aggregering per dato for årsvisning, filtrerer null
- **`yearOverYear`**: Sammenligner siste år med 1 år tilbake (dato-for-dato via `setFullYear`), 14d sentrert rullende snitt (±7 dager), månedlig prosentvis endring. Skuddår: 29. feb matcher 1. mars i ikke-skuddår (JavaScript `setFullYear`-adferd), jevnes ut av rullende snitt
- **`avgByWeekday`**: Grupper på `getDay()`, rekkefølge man–søn, filtrerer null
- **`monthlyTotals`**: Grupperer forbruk per måned og år. Skipper første måned hvis data ikke starter på den 1. (ufullstendig). Returnerer `{ months, years, series }` for gruppert stolpediagram
- **`heatmapData`**: Kryss av ukedag (man=0) × klokketime med snittverdi, filtrerer null

### Regresjonsmodell og prognose (data.js)

- **`dayOfYear(date)`**: Returnerer dag-i-året (1–366)
- **`quadraticRegression(points)`**: Klassisk 2.grads regresjon `kWh = a + b·T + c·T²` via Cramers regel. Brukes fortsatt av scatter-chartet for den rene kvadratiske kurven
- **`seasonalRegression(points)`**: Utvidet modell med Fourier-sesongtermer: `kWh = a + b·T + c·T² + d·sin(2π·doy/365) + e·cos(2π·doy/365)`. Bygger 5×5 normallikningssystem, løser med Gauss-eliminasjon (`solveLinearSystem`). Input: `[[temp, doy, kwh], ...]`
- **`robustSeasonalRegression(points, madThreshold=3)`**: Wrapper rundt `seasonalRegression` med MAD-basert outlier-fjerning. Kjører regresjon → beregner residualer → MAD × 1.4826 → fjerner punkter > 3×MAD → kjører regresjon på nytt. Fjerner typisk 2–4% av punktene (elbil-lading). Returnerer `{a, b, c, d, e, removedCount}`
- **`makePredictFn(coeffs)`**: Factory som returnerer `(temp, doy) => kWh`. Én kilde til sannhet for prediksjonsformelen. Håndterer både 3-koeff (legacy) og 5-koeff (sesong) format. Brukes av `consumptionDeviation`, `monthlyProjection` og `forecastTimeline`
- **`consumptionDeviation(data, coeffs)`**: Beregner avvik mellom faktisk og forventet forbruk siste 24t. Bruker sesongmodell med doy for sesongkorrigert forventning
- **`fetchForecast(lat, lon)`**: Henter temperaturprognose fra `/api/forecast` med `cache: 'no-cache'` (bypass nettleserens HTTP-cache), cacher i localStorage (1t TTL)
- **`historicalDailyTemps(data)`**: Bygger lookup `MM-DD → snitttemperatur` fra historisk data. Brukes som fallback når prognose mangler
- **`monthlyProjection(monthData, forecast, histTemps, coeffs)`**: Beregner kumulativt forbruk for inneværende måned. Kombinerer faktisk forbruk (fortid), sesongmodell + temperaturprognose (fremtid), med usikkerhetsbånd (p10/p90). Fallback-kjede: timeprognose (≥20 datapunkter/dag) → dagsprognose (Subseasonal) → historisk snitt
- **`forecastTimeline(recentData, forecast, histTemps, coeffs)`**: 7 dager tilbake + 21 dager fremover. Faktisk forbruk/temp for fortiden, predikert via sesongmodell for fremtiden. Bruker timedata kun for dager med ≥20 datapunkter (full timedekning); 6-timersdata (4 punkter/dag) faller til Subseasonal dagsprognose for å unngå temperaturspiker ved overgang mellom datakilder. **Bias-korreksjon**: beregner ratio mellom faktisk og modell-predikert forbruk for siste 7 komplette dager (≥20 timer, ≥3 dager kreves), skalerer alle prognoseverdier med denne faktoren for sømløs overgang. **Overgangsdager** med delvis faktisk data blandes: `faktisk_kWh + predikert_resterende × biasRatio`, temperatur vektes tilsvarende

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
- Vercel free tier (Hobby) er tilstrekkelig – cron håndteres av GitHub Actions
- Supabase free tier holder i årevis med denne datamengden (~8760 rader/år per hjem)
- GitHub Actions cron er ikke presis (5-15 min forsinkelse), men irrelevant for timedata
- `vercel dev` leser `.env.local` (ikke `.env`) – bruk `vercel env pull` eller opprett manuelt
- Collect lagrer rader med null consumption (Tibber returnerer null for nylige timer) – temperaturdata bevares
- Alle client-side beregninger håndterer null-verdier i consumption_kwh
- met.no API-er (Locationforecast, Subseasonal) krever `User-Agent`-header – proxyes via `/api/forecast.js` for å unngå CORS
- Sesongmodellen beregnes fra siste 1 års timedata (~8760 punkter) og brukes av alle prognosegrafer + gauge-avvik
- MAD-outlier-fjerning er robust mot de samme outlierene den fjerner (i motsetning til standardavvik), én iterasjon er tilstrekkelig
