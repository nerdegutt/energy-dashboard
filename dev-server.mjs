// Local preview without Vercel: serves public/ and answers /api/config
// from .env.local / .env (SUPABASE_URL, SUPABASE_ANON_KEY). No dependencies.
//   node dev-server.mjs            → http://localhost:3000
// Collect (/api/collect) is not served here – use `vercel dev` for that.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const root = join(import.meta.dirname, 'public');   // static root, as on Vercel
const port = +(process.env.PORT || 3000);
const env = {};
for (const f of ['.env', '.env.local']) if (existsSync(join(import.meta.dirname, f))) {
  for (const line of readFileSync(join(import.meta.dirname, f), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line); if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p === '/api/config') {
    const supabaseUrl = process.env.SUPABASE_URL || env.SUPABASE_URL, supabaseAnonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY missing in .env or .env.local' })); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ supabaseUrl, supabaseAnonKey }));
  }
  try {
    const file = join(root, p === '/' ? 'index.html' : p);
    if (!file.startsWith(root)) throw new Error('forbidden');
    if ((await stat(file)).isDirectory()) throw new Error('dir');
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, () => console.log(`energy-dashboard → http://localhost:${port}  (config from ${['.env', '.env.local'].filter((f) => existsSync(join(import.meta.dirname, f))).join(', ') || 'process.env'})`));
