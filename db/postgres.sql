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
  id               int not null,              -- Easee's session id (per charger)
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
