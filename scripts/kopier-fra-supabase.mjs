// Copies the history of homes and consumption from Supabase into the database `energy` on the home
// server. Reads Supabase through its REST API with SUPABASE_URL and SUPABASE_SERVICE_KEY from .env (the keys
// the Vercel-era code used; they are never printed), and writes with psql inside the erlend-postgres container
// over SSH. Safe to run again: rows that already exist (same primary key) are skipped.
//
//   node --env-file=.env.local scripts/kopier-fra-supabase.mjs          copy
//   node --env-file=.env.local scripts/kopier-fra-supabase.mjs --tell   only count the rows in Supabase

import { spawn } from 'node:child_process';

const TABLES = [['homes', 'id'], ['consumption', 'home_id,timestamp']]; // homes first (foreign key)
const PAGE = 1000; // Supabase returns at most 1000 rows per request by default
const SERVER = 'erlend@192.168.50.10';
const DB_SERVICE = 'erlend-postgres-9xar1z';
const countOnly = process.argv.includes('--tell');

const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('SUPABASE_URL og SUPABASE_SERVICE_KEY må stå i .env.local (kjør med node --env-file=.env.local).');
  process.exit(1);
}
const headers = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` };

async function fetchAll(table, order) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?select=*&order=${order.split(',').map((c) => `${c}.asc`).join(',')}&limit=${PAGE}&offset=${offset}`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error(`Supabase svarte ${resp.status} for ${table}: ${await resp.text()}`);
    const page = await resp.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

// One JSON document per line, loaded with COPY in CSV mode with quote/delimiter characters that never occur in
// JSON text, so psql takes every line as is (no escape processing), then inserted with jsonb_populate_record.
function sqlFor(table, rows) {
  return [
    `\\echo ${table}:`,
    `select count(*) || ' rader før' from ${table};`,
    'create temp table inn (doc jsonb);',
    "copy inn from stdin with (format csv, quote e'\\x01', delimiter e'\\x02');",
    ...rows.map((r) => JSON.stringify(r)),
    '\\.',
    `insert into ${table} select (jsonb_populate_record(null::${table}, doc)).* from inn on conflict do nothing;`,
    `select count(*) || ' rader etter' from ${table};`,
    'drop table inn;',
  ].join('\n');
}

function psql(script) {
  return new Promise((resolve, reject) => {
    const remote = `c=$(sudo docker ps -q -f name=${DB_SERVICE}) && test -n "$c" && sudo docker exec -i $c psql -q -At -v ON_ERROR_STOP=1 -U energy -d energy -f -`;
    const ssh = spawn('ssh', [SERVER, remote], { stdio: ['pipe', 'inherit', 'inherit'] });
    ssh.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`psql avsluttet med ${code}`))));
    ssh.stdin.end(script + '\n');
  });
}

for (const [table, order] of TABLES) {
  const rows = await fetchAll(table, order);
  console.log(`${table}: ${rows.length} rader i Supabase`);
  if (!countOnly && rows.length) await psql(sqlFor(table, rows));
}
