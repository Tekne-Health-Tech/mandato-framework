// Supabase access-token verification (design 0002 §7). Asymmetric keys only (ES256, RS256) from the project JWKS.
//   cache: 10 min; an unknown kid refetches at most once per 5 min; a key dropped from the set is evicted on the next
//   fetch; when the endpoint is down the last good set is used for up to 1 h from its fetch, then requests fail closed.
import { importJWK, jwtVerify, decodeProtectedHeader } from 'jose';

const ALGS = ['ES256', 'RS256'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class AuthError extends Error {}

export function createVerifier({ issuer, jwksUri, fetchFn = fetch, now = () => Date.now(),
  ttlMs = 10 * 60_000, cooldownMs = 5 * 60_000, staleMs = 60 * 60_000, timeoutMs = 3000 }) {
  if (!issuer || !jwksUri) throw new Error('jwt: issuer and jwksUri are required');
  let keys = null;          // Map kid -> { alg, key }
  let fetchedAt = -Infinity; // time of the last good fetch
  let lastAttempt = -Infinity;
  let inflight = null;

  async function load() {
    lastAttempt = now();
    const res = await fetchFn(jwksUri, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`jwks: HTTP ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.keys)) throw new Error('jwks: no keys');
    const next = new Map();
    for (const jwk of body.keys) {
      if (typeof jwk?.kid !== 'string' || !ALGS.includes(jwk.alg)) continue;   // HS*, none and alg-less keys are ignored
      if (jwk.use && jwk.use !== 'sig') continue;
      next.set(jwk.kid, { alg: jwk.alg, key: await importJWK(jwk, jwk.alg) });
    }
    keys = next; fetchedAt = now();
  }
  const refresh = () => (inflight ??= load().catch(() => {}).finally(() => { inflight = null; }));

  async function keyFor(header) {
    if (!ALGS.includes(header.alg) || typeof header.kid !== 'string') throw new AuthError('alg');
    if (inflight) await inflight;   // a fetch already running (cold start or refetch) serves every waiting request
    if (now() - fetchedAt > ttlMs && now() - lastAttempt >= 1000) await refresh();
    if (!keys?.has(header.kid) && now() - lastAttempt >= cooldownMs) await refresh();
    if (!keys || now() - fetchedAt > staleMs) throw new AuthError('jwks unavailable');
    const k = keys.get(header.kid);
    if (!k || k.alg !== header.alg) throw new AuthError('kid');
    return k.key;
  }

  /** Returns the verified claims or throws AuthError. */
  return async function verify(token) {
    if (typeof token !== 'string' || token.length > 8192) throw new AuthError('token');
    try {
      decodeProtectedHeader(token);
      const { payload } = await jwtVerify(token, keyFor, {
        issuer, audience: 'authenticated', algorithms: ALGS, requiredClaims: ['exp', 'sub'],
        currentDate: new Date(now()),
      });
      if (!UUID.test(payload.sub)) throw new AuthError('sub');
      return payload;
    } catch (e) {
      throw e instanceof AuthError ? e : new AuthError('invalid');
    }
  };
}

/** Second factor (design 0002 §3): aal2 with a TOTP entry in amr. */
export const isAal2 = (c) => c?.aal === 'aal2' && Array.isArray(c.amr) && c.amr.some((e) => e?.method === 'totp');

/** The most recent TOTP entry is numeric, at most maxSec old and at most 60 s in the future. Mirrors core.recent_totp. */
export function recentTotp(c, maxSec = 15 * 60, nowSec = Date.now() / 1000) {
  if (!Array.isArray(c?.amr)) return false;
  const ts = c.amr.filter((e) => e?.method === 'totp' && typeof e.timestamp === 'number').map((e) => e.timestamp);
  if (!ts.length) return false;
  const t = Math.max(...ts);
  return t >= nowSec - maxSec && t <= nowSec + 60;
}
