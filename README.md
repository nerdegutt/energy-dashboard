# Energy Dashboard

Personlig dashboard for strømforbruk. Henter timedata fra [Tibber](https://tibber.com/) og utetemperatur fra [Frost API](https://frost.met.no/) (met.no), lagrer alt i PostgreSQL og visualiserer med [ECharts](https://echarts.apache.org/). Kjører på familiens hjemmeserver (Dokploy, bak Cloudflare Tunnel og Cloudflare Access). Grafana-inspirert mørkt tema med JetBrains Mono.

Støtter flere hjem (Tibber homes) med individuell temperaturstasjon og koordinater for prognose.

![Dashboard - årsvisning](screencapture-1y.png)

## Hva viser det?

**Alle perioder (24t, 7d, 28d, 1y):**
- **Gauge** med gjennomsnittsforbruk for valgt periode. I 24t-visning: avvik fra sesongmodellens forventning
- **Linjegraf** med forbruk, rullende snitt og utetemperatur (dual y-akse)
- **Kumulativ strømstøtte** (kun individuelle hjem): kumulativt forbruk denne måneden med projisert total mot 5000 kWh-grensen, basert på temperaturprognose
- **Forbruksprognose**: 7 dager tilbake + 21 dager fremover med usikkerhetsbånd, basert på met.no-prognose
- **År-over-år sammenligning** med sentrert rullende snitt (±7 dager) og rød/grønn fyll som viser om forbruket har gått opp eller ned. For hjem med elbillader kan elbilen skrus av («Uten elbil»), så man ser om tiltak i huset har virket; det gjelder også månedlig endring
- **Månedlig endring** i prosent sammenlignet med tilsvarende måned året før
- **Månedlig totalforbruk** per år som gruppert stolpediagram (jan–des, maks 2 foregående år + inneværende) med projisert rest for inneværende måned
- **Elbillading per måned** (hjem med lader): eksakt fra laderens timeverdier, anslått fra ladeøktene før de fantes

**Hus og elbil:** For hjem med elbillader viser linjegrafen elbilen som egen serie (huset i tooltip og datatabell). Gauge-avviket,
punktdiagrammet og forbruksprognosen gjelder huset uten elbil. Strømstøtte-prognosen og månedsprognosen gjelder hele måleren:
huset etter modellen pluss elbilens snitt per time siste 28 døgn.

**Kun årsvisning (365d):**
- **Scatter plot** med temperatur vs. forbruk, lineær/kvadratisk/sesongregresjon, vinter- og sommerkurver
- **Heatmap** med snittforbruk per ukedag og klokketime
- **Snitt per ukedag** som bar chart

## Regresjonsmodell

Forbruksprediksjon bruker en robust sesongmodell:

```
kWh = a + b·T + c·T² + d·sin(2π·doy/365) + e·cos(2π·doy/365)
```

- Fourier-leddene fanger sesongavhengig forbruk (f.eks. basseng om sommeren) som temperatur alene ikke forklarer
- Modellen tilpasses **husforbruket uten elbil** (`house_kwh`, se under), så ladingen ikke forstyrrer normalen
- MAD-basert outlier-fjerning tar bort enkeltstående topper som modellen ikke forklarer
- Modellen beregnes fra siste 1 års timedata og brukes av alle prognosegrafer + gauge-avvik

### Husforbruk og elbil

Laderen (Easee) står bak Hovedbygningens måler. Viewet `energy_hourly` deler måleren per time: `house_kwh = consumption_kwh −
ev_kwh`.

- Fra 20. sep 2025: `ev_kwh` er laderens egne timeverdier (eksakt).
- 15. okt 2024 – 19. sep 2025: bare ladeøkter finnes. Hver økts kWh fordeles på timene mellom første og siste
  strømoverføring der måleren stiger mest over medianen for ±12 timer (høyst laderens største timeverdi per time, i høyst
  `ceil(ladesekunder / 3600) + 2` timer). Øktens sum stemmer; timene er anslått (`ev_estimated`). Testet mot perioden med
  fasit: 80 % av energien havner i riktig time, 91 % på riktig døgn.
- Før 15. okt 2024: ingen lading hjemme, `ev_kwh = 0`.

## Arkitektur

```
server.mjs (Node, Docker, Dokploy)
  ├─ innsamling hver time (Tibber siste 72 t + Frost-temperatur) → PostgreSQL
  ├─ ladedata fra Easee hver time (kWh per time og ladeøkter, bare lesing) → PostgreSQL, deretter anslaget før timeverdiene
  ├─ /api/homes, /api/consumption → frontend
  ├─ /api/forecast → temperaturprognose fra met.no
  └─ public/ (HTML + vanilla JS + ECharts + Nerdesign)
```

Ingen build step, ingen bundler, ingen React. Innloggingen gjøres av Cloudflare Access foran appen; serveren sjekker
Access-tokenet. Ingen ekstern cron: appen samler inn selv og melder fra til healthchecks.io, som sender e-post hvis
innsamlingen feiler eller stopper.

## Tech stack

| Hva | Tjeneste |
|-----|----------|
| Hosting | Egen server med Dokploy (Docker) |
| Database | PostgreSQL 18 |
| Innlogging | Cloudflare Access |
| Strømdata | Tibber GraphQL API |
| Elbillading | Easee API (valgfritt; kWh per time og økter) |
| Temperatur (historisk) | Frost API (met.no, konfigurerbar stasjon per hjem) |
| Temperatur (prognose) | met.no Locationforecast + Subseasonal |
| Grafer | ECharts (CDN) |
| Styling | Nerdesign (vendret i `public/nd/`) |
| Overvåking | healthchecks.io |

## Oppsett

1. Kontoer hos [Tibber Developer](https://developer.tibber.com/) og [Frost (met.no)](https://frost.met.no/).
2. En Postgres-database; appen lager tabellene selv (`db/postgres.sql`).
3. Bygg og kjør `Dockerfile` med miljøvariablene `DATABASE_URL`, `TIBBER_API_TOKEN`, `FROST_CLIENT_ID` (og valgfritt
   `HEALTHCHECK_ENERGY_URL`, `CRON_SECRET`, `CF_ACCESS_TEAM`, `CF_ACCESS_AUD`). Port 3000.
4. Legg inn hjemmene i `homes`:

```sql
INSERT INTO homes (id, name, sort_order, lat, lon, frost_station) VALUES
  ('<TIBBER_HOME_ID>', 'Hjemme', 1, 59.43, 10.65, 'SN17280');
```

5. Backfill historikk fra Tibber: `curl -X POST "<adresse>/api/collect?hours=100000" -H "x-cron-secret: <CRON_SECRET>"`.
6. Valgfritt, elbillader: sett `EASEE_USERNAME` og `EASEE_PASSWORD` (en vanlig anleggsbruker holder; finner kontoen ikke
   laderen, sett `EASEE_CHARGER_IDS`). Første kjøring henter hele historikken selv
   (timer og økter fra `EASEE_HISTORY_FROM`, standard 2024-10-01); siden hver time sammen med Tibber.
7. Knytt laderen til måleren den står bak, så husforbruket kan skilles fra bilen:
   `UPDATE chargers SET home_id = '<TIBBER_HOME_ID>' WHERE id = '<laderens serienummer>';`

## Vibe-kodet

Dette prosjektet er nær 100 % vibe-kodet med [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Alt av kode -- frontend, backend, databehandling, grafer og cron-oppsett -- er skrevet av Claude gjennom naturlig dialog på norsk. Det eneste som er gjort manuelt er opprettelse av kontoer hos de ulike tjenestene og konfigurasjon av API-nøkler.

## Lokal kjøring

```bash
docker network create entest
docker run -d --rm --name entest-db --network entest -e POSTGRES_USER=energy -e POSTGRES_PASSWORD=test -e POSTGRES_DB=energy postgres:18
docker build -t energy .
docker run --rm --network entest -p 3000:3000 -e DATABASE_URL=postgresql://energy:test@entest-db:5432/energy energy
```
