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
