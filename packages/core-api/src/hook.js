// Supabase "Before User Created" HTTP hook (design 0002 §5): only an e-mail with an open invitation may sign up.
//   - the raw body is verified with standardwebhooks (5-minute tolerance) before it is parsed;
//   - a webhook-id seen in the last 5 minutes is answered from memory, without the database;
//   - at most 4 hook requests in flight per process; statement timeout 2 s, overall budget 4 s; any failure refuses.
import { Webhook } from 'standardwebhooks';
import { withRequest } from './db.js';
import { emailIndexer } from './keys.js';

const ALLOW = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const REFUSE = () => new Response(JSON.stringify({ error: { http_code: 403, message: 'Cadastro apenas por convite.' } }),
  { status: 403, headers: { 'content-type': 'application/json' } });
const MAX_BODY = 64 * 1024;
const WINDOW_MS = 5 * 60_000;

export function createSignupHook({ pool, secret, env = process.env, now = () => Date.now(), maxInFlight = 4,
  maxSeen = 10_000, budgetMs = 4000, log = () => {} }) {
  if (typeof secret !== 'string' || !secret) throw new Error('hook: secret required');
  const wh = new Webhook(secret.replace(/^v1,/, ''));
  const seen = new Map();   // webhook-id -> { at, allowed }
  let inFlight = 0;

  const prune = () => { const t = now(); for (const [k, v] of seen) { if (t - v.at > WINDOW_MS) seen.delete(k); else break; } };

  async function decide(email) {
    if (typeof email !== 'string' || !email.includes('@') || email.length > 254) return false;
    let timer;
    const budget = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('hook: budget')), budgetMs); });
    try {
      return await Promise.race([budget, withRequest(pool, {}, async (tx) => {
        const index = await emailIndexer(tx, env);
        const { rows } = await tx.query('select core.invitation_open($1) as open', [index(email)]);
        return rows[0]?.open === true;
      }, { statementTimeout: 2000 })]);
    } finally { clearTimeout(timer); }
  }

  return async function handle(request) {
    if (request.method !== 'POST') return REFUSE();
    const len = Number(request.headers.get('content-length') ?? 0);
    if (len > MAX_BODY) return REFUSE();
    const id = request.headers.get('webhook-id');
    if (inFlight >= maxInFlight) { log('hook: refused, too many in flight'); return REFUSE(); }
    inFlight++;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return REFUSE();
      let payload;
      try {
        payload = wh.verify(raw, {
          'webhook-id': id, 'webhook-timestamp': request.headers.get('webhook-timestamp'),
          'webhook-signature': request.headers.get('webhook-signature'),
        });
      } catch { log('hook: refused, bad signature'); return REFUSE(); }
      prune();
      const prior = seen.get(id);
      if (prior) return prior.allowed ? ALLOW() : REFUSE();
      if (seen.size >= maxSeen) { log('hook: refused, replay set full'); return REFUSE(); }
      let allowed;
      try { allowed = await decide(payload?.user?.email); } catch { log('hook: refused, lookup failed'); return REFUSE(); }
      seen.set(id, { at: now(), allowed });   // only decisions are remembered, so a retry after a failure is looked up again
      return allowed ? ALLOW() : REFUSE();
    } finally { inFlight--; }
  };
}
