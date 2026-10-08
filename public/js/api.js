// GET a JSON endpoint of the app's own API (server.mjs). Cloudflare Access sends the login cookie along.
export async function getJson(path) {
  const resp = await fetch(path, { credentials: 'same-origin' });
  if (!resp.ok) throw new Error(`${path} svarte ${resp.status}`);
  return resp.json();
}
