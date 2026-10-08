# AGENTS.md

Instruksjoner for kodeagenter i dette repoet (`CLAUDE.md` peker hit). **Repoet er offentlig** – ingen hemmeligheter i Git.

## Viktig: Aldri push uten brukerens godkjenning

**ALDRI kjør `git push` uten at brukeren eksplisitt har testet og bekreftet at endringene fungerer.** Commit lokalt, men vent alltid på brukerens godkjenning før push.

## Viktig: Hold README.md oppdatert

Når funksjonalitet legges til eller endres, **må README.md oppdateres i samme commit**. README er den primære oppsettguiden for prosjektet og inneholder database-skjema, oppsettsinstruksjoner og funksjonsbeskrivelser som må speile faktisk kode.

## Oversikt

Personlig strømforbruk-dashboard som henter timedata fra Tibber og utetemperatur fra Frost (met.no), lagrer i Postgres
og visualiserer med ECharts. Kjører på familiens hjemmeserver (Dokploy, bak Cloudflare Tunnel), flyttet fra Vercel +
Supabase i oktober 2026. Støtter flere hjem (Tibber homes) via `homes`-tabellen – brukeren velger hjem i headeren.

Følg skillen `hjemmeserver` (`~/dev/nerdegutt/m920q/skill/hjemmeserver/`): les eller skriv aldri hemmeligheter, spør
Erlend før deploy eller endringer i Dokploy, ingen brancher uten at Erlend ber om det.

## Utvikling

- **Ingen build step, ingen bundler, ingen React** – ren HTML + vanilla JS (ES modules) i `public/`, og en liten
  Node-server (`server.mjs`, ES modules, ingen rammeverk).
- Lokalt: `docker build -t energy . ` og en `postgres:18`-container; sett `DATABASE_URL` (og ev. `TIBBER_API_TOKEN`,
  `FROST_CLIENT_ID`) som miljøvariabler. Uten `TIBBER_API_TOKEN` hopper innsamlingen over.
- Deploy: push til `main` → Dokploy bygger `Dockerfile` (når webhooken når fram; til da starter Erlend eller en agent
  med ja deployen).
- Ingen tester, ingen linter konfigurert.

## Arkitektur

```
server.mjs (Dokploy-appen energy, port 3000)
  ├─ planlagt innsamling: rett etter oppstart og hver time kl. hh:10 (UTC) → lib/collect.mjs
  │     ↓ Tibber GraphQL (siste 72 t, selvhelende) + Frost (met.no, temperatur per stasjon)
  │     ↓ upsert i databasen `energy` (erlend-postgres)
  ├─ GET /api/homes, /api/consumption?home=&since=  → leses av public/js
  ├─ GET /api/forecast?lat=&lon=                     → met.no-prognose (lib/forecast.mjs)
  ├─ POST /api/collect[?hours=&home=]                → manuell kjøring/backfill (x-cron-secret)
  └─ statiske filer fra public/
```

Cloudflare Access («Familien») står foran `energy.offline.no`; `lib/access.mjs` sjekker Access-tokenet på alt unntatt
`/healthz` og `/api/collect` når `CF_ACCESS_TEAM` og `CF_ACCESS_AUD` er satt. Uten dem (testadressen
`http://energy.192.168.50.10.sslip.io`, bare hjemmenett og VPN) er det ingen innlogging. «Logg ut» lenker til
`/cdn-cgi/access/logout`. Den gamle Supabase-innloggingen er fjernet.

## Filstruktur

```
/
├── server.mjs               # HTTP-server, API, planlagt innsamling, hjerteslag
├── lib/
│   ├── collect.mjs          # Tibber + Frost → consumption
│   ├── forecast.mjs         # met.no-prognose
│   └── access.mjs           # Cloudflare Access-sjekk
├── db/postgres.sql          # Tabellene; kjøres ved hver oppstart (idempotent)
├── public/
│   ├── index.html
│   └── js/ (app.js, api.js, data.js, charts.js)
├── scripts/kopier-fra-supabase.mjs   # Engangskopi av historikken fra Supabase
├── Dockerfile, .dockerignore
└── AGENTS.md
```

## Database (`energy` i erlend-postgres)

Tabellene står i `db/postgres.sql` (samme som på Supabase, uten RLS):

- `homes` (`id` = Tibber home ID, `name`, `sort_order`, `lat`/`lon` for prognosen, `frost_station` (default
  `SN17280`), `collect_enabled`)
- `consumption` (`home_id`, `timestamp`, `consumption_kwh`, `outside_temp_c`; nøkkel `home_id, timestamp`)
- `consumption_kwh` kan være NULL (Tibber har ikke aggregert de siste timene ennå).
- Hjem legges inn og endres direkte i `homes` (`psql` i containeren, som `energy`-brukeren). `collect_enabled = false`
  får innsamlingen til å hoppe over hjemmet (f.eks. utleid sidebygning); data og hjemvalg beholdes.
- `numeric` leveres som JS-tall av serveren (`pg.types.setTypeParser(1700, Number)`), som frontenden forventer.

## Miljøvariabler (settes av Erlend i Dokploy, bare navn her)

```
DATABASE_URL            # databasen energy (DATABASE_URL_ENERGY i m920q/.env)
TIBBER_API_TOKEN        # fra developer.tibber.com
FROST_CLIENT_ID         # fra frost.met.no
HEALTHCHECK_ENERGY_URL  # ping-adresse på healthchecks.io (HC_PING_ENERGY i m920q/.env)
CRON_SECRET             # valgfri: tillater POST /api/collect (backfill)
CF_ACCESS_TEAM, CF_ACCESS_AUD  # Cloudflare Access; tomme på testadressen
COLLECT_MINUTE          # valgfri, minutt over hver time (standard 10)
```

## Innsamling (lib/collect.mjs)

- Kjøres av en tidtaker i appen (ingen ekstern cron; cron-job.org er avviklet): én gang rett etter oppstart, deretter
  hver time kl. hh:10 UTC. Henter alltid siste 72 t, så kjøringer som falt bort mens appen var nede, fylles inn neste
  gang.
- Henter hjem med `collect_enabled = true`. Feil for ett hjem stopper ikke de andre: vellykkede lagres, feilede listes
  i `failed` og gir status 502.
- **Varsling:** etter hver kjøring pinger appen `HEALTHCHECK_ENERGY_URL` (healthchecks.io-sjekken «Energy –
  innsamling»). Feil (også delvis) går til `/fail`, så Erlend får e-post med en gang; ingen ping på 90 min gir e-post.
- Tibber: GraphQL mot `https://api.tibber.com/v1-beta/gql`, `last: 72` som standard, `?hours=N` for backfill
  (over 744 t paginert med `first`/`after`), `?home=<id>` for ett hjem.
- Frost: `https://frost.met.no/observations/v0.jsonld`, Basic auth med `FROST_CLIENT_ID` og tomt passord, krever
  `User-Agent`. Frost-feil stopper ikke innsamlingen – temperaturen blir null. Hentes én gang per unik stasjon.
- Upsert i bolker à 1000 rader på `home_id, timestamp`; idempotent.

## /api/forecast

- Locationforecast 2.0 (timedata 0–65 t + 6-timers til ~10 d) og Subseasonal 1.0 (daglig dag 1–21), hentet parallelt
  med `User-Agent`. `daily` tar bare med datoer med færre enn 20 timeoppføringer i `hourly`.
- Svar `{ hourly, daily }`.

## Design og tema – Nerdesign

UI-en bruker designsystemet **Nerdesign** (https://nerdesign.offline.no/), kopiert
inn i `public/nd/` fra en fast release (versjonslinjen står øverst i `nd/nd.css`).
Ikke rediger `nd/`; oppgrader med
`~/dev/nerdegutt/nerdesign/tools/copy-to.sh public --with-fonts --release vX.Y.Z`.
Bruk Claude-skillen `nerdesign` for tokens og markup.

- Ingen Tailwind, ingen Google Fonts: `nd/nd-fonts.css` (JetBrains Mono, selvhostet) + `nd/nd.css`.
  ECharts kommer fortsatt fra jsDelivr.
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

## Historikk og backfill

- Historikken fra Supabase ble kopiert med `node --env-file=.env.local scripts/kopier-fra-supabase.mjs` (Supabase REST
  med de gamle nøklene i `.env.local`, som aldri skrives ut; `--tell` teller bare). Trygt å kjøre igjen.
- Backfill fra Tibber (1–2 år tilbake) for et nytt hjem: `POST /api/collect?hours=100000&home=<id>` med
  `x-cron-secret` (krever `CRON_SECRET` i Dokploy).

## Viktige detaljer

- Tibber-data kan ha hull for inneværende dag; prognosefunksjonene fyller hull med modellprediksjoner time for time.
- Alle beregninger i nettleseren håndterer null i `consumption_kwh`.
- Sesongmodellen beregnes fra siste års timedata (~8760 punkter) og brukes av alle prognosegrafer og gauge-avviket.
- MAD-outlier-fjerning er robust mot de samme outlierne den fjerner; én iterasjon holder.
