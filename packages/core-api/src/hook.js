// Supabase "Before User Created" HTTP hook (design 0002 §5): only an e-mail with an open invitation may sign up.
//   - the raw body is verified with standardwebhooks (5-minute tolerance) before it is parsed;
//   - a webhook-id seen in the last 5 minutes is answered from memory, without the database;
//   - at most 4 hook requests in flight per process; statement timeout 2 s; one 4 s budget covers body, signature
//     and lookup; any failure refuses.
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
  const seen = new Map();   // webhook-id -> { at, decision: Promise<boolean> }
  let inFlight = 0;

  const prune = () => { const t = now(); for (const [k, v] of seen) { if (t - v.at > WINDOW_MS) seen.delete(k); else break; } };

  async function decide(email) {
    if (typeof email !== 'string' || !email.includes('@') || email.length > 254) return false;
    return withRequest(pool, {}, async (tx) => {
      const index = await emailIndexer(tx, env);
      const { rows } = await tx.query('select core.invitation_open($1) as open', [index(email)]);
      return rows[0]?.open === true;
    }, { statementTimeout: 2000 });
  }

  // Reads at most MAX_BODY bytes. The reader is cancelled when the budget expires or the limit is passed, so an
  // abandoned or oversized body is never left pending (stage 4 re-check, finding 2).
  async function readBody(request, signal) {
    if (!request.body) return '';
    const reader = request.body.getReader();
    const cancel = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY) { cancel(); return null; }
        chunks.push(value);
      }
    } finally { signal.removeEventListener('abort', cancel); }
    return Buffer.concat(chunks).toString('utf8');
  }

  // Body, signature and lookup, all inside one budget (stage 3 review, finding 2).
  async function work(request, signal) {
    const id = request.headers.get('webhook-id');
    const raw = await readBody(request, signal);
    if (raw === null) return false;
    let payload;
    try {
      payload = wh.verify(raw, {
        'webhook-id': id, 'webhook-timestamp': request.headers.get('webhook-timestamp'),
        'webhook-signature': request.headers.get('webhook-signature'),
      });
    } catch { log('hook: refused, bad signature'); return false; }
    prune();
    // The pending decision is stored before the lookup, so concurrent deliveries of one id share it (finding 4).
    const prior = seen.get(id);
    if (prior) return prior.decision;
    if (seen.size >= maxSeen) { log('hook: refused, replay set full'); return false; }
    const decision = decide(payload?.user?.email);
    seen.set(id, { at: now(), decision });
    try { return await decision; } catch {
      seen.delete(id);   // only decisions are remembered, so a retry after a failure is looked up again
      log('hook: refused, lookup failed');
      return false;
    }
  }

  return async function handle(request) {
    if (request.method !== 'POST') return REFUSE();
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return REFUSE();
    if (inFlight >= maxInFlight) { log('hook: refused, too many in flight'); return REFUSE(); }
    inFlight++;
    const ctl = new AbortController();
    let timer;
    const budget = new Promise((res) => { timer = setTimeout(() => { log('hook: refused, budget exceeded'); ctl.abort(); res(false); }, budgetMs); });
    try {
      const allowed = await Promise.race([budget, work(request, ctl.signal).catch(() => false)]);
      return allowed === true ? ALLOW() : REFUSE();
    } finally { clearTimeout(timer); ctl.abort(); inFlight--; }
  };
}
