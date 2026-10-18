-- Schema for energy (database `energy` in erlend-postgres). Applied by server.mjs at every start-up; idempotent.
-- Same tables as on Supabase (see the old README), without row level security: access control is Cloudflare
-- Access in server.mjs.

create table if not exists homes (
  id               text primary key,          -- Tibber home ID
  name             text not null,             -- display name ("Hjemme", "Hytta")
  sort_order       int default 0,
  lat              numeric,                   -- for the met.no temperature forecast
  lon              numeric,
  frost_station    text,                      -- Frost station for historical temperature (default SN17280)
  collect_enabled  boolean not null default true  -- false = collect skips the home, data is kept
);

create table if not exists consumption (
  home_id          text not null references homes(id),
  timestamp        timestamptz not null,
  consumption_kwh  numeric,
  outside_temp_c   numeric,
  primary key (home_id, timestamp)
);
create index if not exists idx_consumption_timestamp on consumption (timestamp);

-- EV charging from Easee (lib/easee.mjs, read-only API): kWh per charger per hour, so the house can be told
-- apart from the car. Hours, not sessions: a session can span days (10–17 Oct 2026 was one session).
create table if not exists chargers (
  id               text primary key,          -- Easee charger id (serial, e.g. EHHTPUS8)
  name             text not null,             -- name in the Easee app ("Garasje")
  home_id          text references homes(id), -- the meter it sits behind; set by hand (null = unknown)
  backfilled_at    timestamptz                -- set once the full hourly history has been fetched
);

create table if not exists ev_charging (
  charger_id       text not null references chargers(id),
  timestamp        timestamptz not null,      -- start of the hour (UTC), as consumption.timestamp
  energy_kwh       numeric not null,
  primary key (charger_id, timestamp)
);
create index if not exists idx_ev_charging_timestamp on ev_charging (timestamp);

-- Charging sessions from Easee: the only record before hourly reporting began (19 Sep 2025 for EHHTPUS8;
-- sessions go back to the first charge on 15 Oct 2024). Exact per session; where in the plug-in window the
-- energy went is only bounded by first/last transfer and charging_seconds.
create table if not exists ev_sessions (
  charger_id       text not null references chargers(id),
  id               bigint not null,           -- Easee's session id
  car_connected    timestamptz,
  car_disconnected timestamptz,
  energy_kwh       numeric,
  charging_seconds int,                       -- actualDurationSeconds: time energy actually flowed
  first_transfer   timestamptz,               -- firstEnergyTransferPeriodStarted
  last_transfer    timestamptz,               -- lastEnergyTransferPeriodEnd
  complete         boolean,
  primary key (charger_id, id)
);
create index if not exists idx_ev_sessions_connected on ev_sessions (car_connected);

-- Estimated EV energy per hour for the time before the charger reported hours (lib/ev-estimate.mjs): each session's
-- kWh spread over the hours of its transfer window where the meter rises most above its surroundings. Rewritten
-- after every Easee run; never mixed into ev_charging, which stays exact.
create table if not exists ev_charging_estimate (
  charger_id       text not null references chargers(id),
  timestamp        timestamptz not null,
  energy_kwh       numeric not null,
  primary key (charger_id, timestamp)
);

-- House and car per home and hour. consumption_kwh is the meter (Tibber); ev_kwh the chargers behind that meter
-- (chargers.home_id); house_kwh = consumption_kwh − ev_kwh. Homes without a charger: ev_kwh null, house = meter.
-- ev_kwh is 0 before the first session (no charging at home before Oct 2024), exact from the first Easee hour,
-- estimated in between (ev_estimated), and null after the newest Easee hour (not reported yet → house unknown).
-- Changing the columns needs `drop view … cascade` first (h49_hourly depends on it).
create or replace view energy_hourly as
with ev as (
  select ch.home_id, x.timestamp, sum(x.energy_kwh) as kwh
  from chargers ch
  join (select charger_id, timestamp, energy_kwh from ev_charging
        union all
        select charger_id, timestamp, energy_kwh from ev_charging_estimate) x on x.charger_id = ch.id
  where ch.home_id is not null
  group by ch.home_id, x.timestamp
), known as (
  select ch.home_id, min(e.first) as exact_from, max(e.last) as exact_until, min(s.first) as sessions_from
  from chargers ch
  left join (select charger_id, min(timestamp) as first, max(timestamp) as last from ev_charging group by charger_id) e
    on e.charger_id = ch.id
  left join (select charger_id, min(first_transfer) as first from ev_sessions group by charger_id) s
    on s.charger_id = ch.id
  where ch.home_id is not null
  group by ch.home_id
)
select c.home_id, c.timestamp, c.consumption_kwh,
       case when k.home_id is null then c.consumption_kwh else c.consumption_kwh - v.ev_kwh end as house_kwh,
       v.ev_kwh,
       coalesce(c.timestamp >= date_trunc('hour', k.sessions_from) and c.timestamp < coalesce(k.exact_from, 'infinity'),
                false) as ev_estimated,
       c.outside_temp_c
from consumption c
left join known k on k.home_id = c.home_id
left join ev on ev.home_id = c.home_id and ev.timestamp = c.timestamp
cross join lateral (
  select case when k.home_id is null then null
              when ev.kwh is not null then ev.kwh
              when c.timestamp <= coalesce(k.exact_until, '-infinity') then 0 end as ev_kwh
) v;

-- Read-only view for the family dashboard h49 (../h49-dashboard/docs/views-draft.md): the main house only; the flat
-- (Sidebygningen) shows the tenants' habits and stays out. The role h49 is created by Erlend; until then no grant.
create or replace view h49_hourly as
  select e.timestamp, e.consumption_kwh, e.house_kwh, e.ev_kwh, e.ev_estimated, e.outside_temp_c
  from energy_hourly e join homes h on h.id = e.home_id
  where h.name = 'Hovedbygningen';
do $$
begin
  if exists (select from pg_roles where rolname = 'h49') then
    grant select on h49_hourly to h49;
  end if;
end $$;
