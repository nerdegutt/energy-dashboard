// Local preview of a static site without Vercel. Copy this file into a project
// (`cp ~/dev/nerdegutt/nerdesign-private/tools/dev-server.mjs .`) and run:
//
//   node dev-server.mjs            → http://localhost:3000
//   PORT=3111 node dev-server.mjs  → another port
//
// It serves `public/` when that directory exists, otherwise the project root,
// and answers /api/config with SUPABASE_URL and SUPABASE_ANON_KEY read from
// .env / .env.local so the browser client can start. Nothing else is emulated –
// use `vercel dev` for the other serverless functions.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const project = import.meta.dirname;
const root = existsSync(join(project, 'public')) ? join(project, 'public') : project;
const port = +(process.env.PORT || 3000);

const env = {};
for (const f of ['.env', '.env.local']) {
  if (!existsSync(join(project, f))) continue;
  for (const line of readFileSync(join(project, f), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.woff2': 'font/woff2', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain',
};

createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (p === '/api/config') {
    const supabaseUrl = process.env.SUPABASE_URL || env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
    const body = supabaseUrl && supabaseAnonKey
      ? { supabaseUrl, supabaseAnonKey }
      : { error: 'SUPABASE_URL / SUPABASE_ANON_KEY mangler i .env eller .env.local' };
    res.writeHead(supabaseUrl ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(body));
  }
  try {
    const file = join(root, p);
    if (!file.startsWith(root)) throw new Error('forbidden');
    const st = await stat(file);
    const target = st.isDirectory() ? join(file, 'index.html') : file;
    res.writeHead(200, { 'Content-Type': types[extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(target));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(port, () => console.log(`${root.split('/').slice(-2).join('/')} → http://localhost:${port}`));
