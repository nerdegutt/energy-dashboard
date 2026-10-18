// Cloudflare Access: verifies the Access JWT on every request that is not public.
// A header alone can be forged by anything that reaches the app, so the token's signature, issuer,
// audience and expiry are checked against the team's public keys (hjemmeserver skill,
// references/domains-and-access.md). Off when CF_ACCESS_TEAM / CF_ACCESS_AUD are unset (local runs). They are set in Dokploy, which
// also covers the sslip.io test address: no Cloudflare in front there, so only the public paths answer.

import { createRemoteJWKSet, jwtVerify } from 'jose';

const team = process.env.CF_ACCESS_TEAM;
const aud = process.env.CF_ACCESS_AUD;
export const accessEnabled = Boolean(team && aud);

const issuer = `https://${team}.cloudflareaccess.com`;
const jwks = accessEnabled ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) : null;

function tokenFrom(req) {
  const header = req.headers['cf-access-jwt-assertion'];
  if (header) return header;
  const cookie = req.headers.cookie || '';
  return cookie.split(/;\s*/).find((c) => c.startsWith('CF_Authorization='))?.slice('CF_Authorization='.length);
}

// Returns the user's e-mail, or null when the request is not allowed.
export async function accessUser(req) {
  if (!accessEnabled) return 'access-off';
  const token = tokenFrom(req);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: aud });
    return payload.email || payload.sub || null;
  } catch {
    return null;
  }
}
