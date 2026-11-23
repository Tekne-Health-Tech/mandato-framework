// E0.5 / design 0002 §9 (tests 1, 4b, 5, 7): token verification, request gating and the sign-up hook, without a
// database or network. A fake pool proves which requests never reach the database. Synthetic keys and people only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { Webhook } from 'standardwebhooks';
import * as c from '../packages/crypto/src/envelope.js';
import { createVerifier, isAal2, recentTotp } from '../packages/core-api/src/jwt.js';
import { createApi } from '../packages/core-api/src/api.js';
import { createSignupHook } from '../packages/core-api/src/hook.js';
import { uuid7 } from '../packages/core-api/src/keys.js';

const ISS = 'https://exemplo.supabase.test/auth/v1';
const JWKS = 'https://exemplo.supabase.test/auth/v1/.well-known/jwks.json';
const SUB = '00000000-0000-4000-8000-0000000000a1';
let kp, kp2, jwk, jwk2;

before(async () => {
  await c.ready();
  kp = await generateKeyPair('ES256'); kp2 = await generateKeyPair('ES256');
  jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  jwk2 = { ...(await exportJWK(kp2.publicKey)), kid: 'k2', alg: 'ES256', use: 'sig' };
});

function jwksServer(sets) {
  const s = { calls: 0, down: false, keys: sets };
  s.fetch = async (url, opts) => {
    assert.equal(url, JWKS); assert.equal(opts.redirect, 'error');
    s.calls++;
    if (s.down) throw new Error('down');
    return new Response(JSON.stringify({ keys: s.keys }), { status: 200 });
  };
  return s;
}
const nowS = () => Math.floor(Date.now() / 1000);
const totp = (age = 0) => [{ method: 'totp', timestamp: nowS() - age }, { method: 'password', timestamp: nowS() - 3600 }];
async function token({ key = kp.privateKey, kid = 'k1', alg = 'ES256', aud = 'authenticated', iss = ISS, exp = '10m', claims = {} } = {}) {
  return new SignJWT({ aal: 'aal2', amr: totp(), email: 'pessoa@example.org', ...claims })
    .setProtectedHeader({ alg, kid }).setSubject(claims.sub ?? SUB).setIssuer(iss).setAudience(aud)
    .setIssuedAt().setExpirationTime(exp).sign(key);
}

// ---------------------------------------------------------------- JWT
test('a valid ES256 token verifies; wrong aud, wrong iss and expired tokens are refused', async () => {
  const s = jwksServer([jwk]);
  const v = createVerifier({ issuer: ISS, jwksUri: JWKS, fetchFn: s.fetch });
  assert.equal((await v(await token())).sub, SUB);
  await assert.rejects(v(await token({ aud: 'anon' })));
  await assert.rejects(v(await token({ iss: 'https://outro.test/auth/v1' })));
  await assert.rejects(v(await token({ exp: Math.floor(Date.now() / 1000) - 10 })));
});

test('HS256 and alg none are refused even with a matching kid', async () => {
  const s = jwksServer([jwk, { kty: 'oct', k: Buffer.from('segredo-sintetico-de-teste-32-bytes!').toString('base64url'), kid: 'h1', alg: 'HS256' }]);
  const v = createVerifier({ issuer: ISS, jwksUri: JWKS, fetchFn: s.fetch });
  const hs = await new SignJWT({ aal: 'aal2' }).setProtectedHeader({ alg: 'HS256', kid: 'h1' }).setSubject(SUB)
    .setIssuer(ISS).setAudience('authenticated').setExpirationTime('5m').sign(Buffer.from('segredo-sintetico-de-teste-32-bytes!'));
  await assert.rejects(v(hs));
  const none = [Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: SUB, iss: ISS, aud: 'authenticated', exp: nowS() + 60 })).toString('base64url'), ''].join('.');
  await assert.rejects(v(none));
});

test('a non-uuid sub is refused', async () => {
  const v = createVerifier({ issuer: ISS, jwksUri: JWKS, fetchFn: jwksServer([jwk]).fetch });
  await assert.rejects(v(await token({ claims: { sub: 'admin' } })));
});

test('an unknown kid refetches at most once per 5 minutes', async () => {
  let t = 1_000_000;
  const s = jwksServer([jwk]);
  const v = createVerifier({ issuer: ISS, jwksUri: JWKS, fetchFn: s.fetch, now: () => t });
  await v(await token());
  assert.equal(s.calls, 1);
  const unknown = await token({ key: kp2.privateKey, kid: 'k2' });
  t += 6 * 60_000; await assert.rejects(v(unknown)); assert.equal(s.calls, 2);   // one refetch
  t += 60_000;     await assert.rejects(v(unknown)); assert.equal(s.calls, 2);   // cooldown honoured
  s.keys = [jwk, jwk2];
  t += 4 * 60_000; assert.equal((await v(unknown)).sub, SUB); assert.equal(s.calls, 3);   // after the cooldown
});

test('a key dropped from the set is evicted on the next fetch', async () => {
  let t = 1_000_000;
  const s = jwksServer([jwk, jwk2]);
  const v = createVerifier({ issuer: ISS, jwksUri: JWKS, fetchFn: s.fetch, now: () => t });
  const tk = await token({ key: kp2.privateKey, kid: 'k2', exp: '2h' });
  await v(tk);
  s.keys = [jwk]; t += 11 * 60_000;
  await assert.rejects(v(tk));
});

test('JWKS down: the last good set serves for up to 1 hour, then requests fail closed', async () => {
  let t = 1_000_000;
  const s = jwksServer([jwk]);
  const v = createVerifier({ issuer: ISS, jwksUri: JWKS, fetchFn: s.fetch, now: () => t });
  const tk = await token({ exp: '3h' });
  await v(tk);
  s.down = true;
  t += 50 * 60_000; await v(tk);
  t += 11 * 60_000; await assert.rejects(v(tk));
});

test('aal2 needs a TOTP amr entry; recent TOTP refuses stale and future entries and reads the most recent one', () => {
  assert.equal(isAal2({ aal: 'aal2' }), false);
  assert.equal(isAal2({ aal: 'aal2', amr: [{ method: 'sms', timestamp: nowS() }] }), false);
  assert.equal(isAal2({ aal: 'aal1', amr: totp() }), false);
  assert.equal(isAal2({ aal: 'aal2', amr: totp() }), true);
  const n = nowS();
  assert.equal(recentTotp({ amr: totp(0) }, 900, n), true);
  assert.equal(recentTotp({ amr: totp(1200) }, 900, n), false);
  assert.equal(recentTotp({ amr: [{ method: 'totp', timestamp: n + 600 }] }, 900, n), false);
  assert.equal(recentTotp({ amr: [{ method: 'totp', timestamp: String(n) }] }, 900, n), false);
  assert.equal(recentTotp({ amr: [{ method: 'totp', timestamp: n - 5000 }, { method: 'totp', timestamp: n - 10 }] }, 900, n), true);
});

// ---------------------------------------------------------------- handlers that must refuse before the database
const noDb = { connect: async () => { throw new Error('the database must not be reached'); } };
function api(claims, pool = noDb) {
  return createApi({ pool, verify: async (t) => { if (t !== 'ok') throw new (await import('../packages/core-api/src/jwt.js')).AuthError('x'); return claims; } });
}
const req = (method, path, { body, auth = 'ok', type = 'application/json' } = {}) => new Request(`http://api.test/api/v1${path}`,
  { method, body, headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...(body !== undefined ? { 'content-type': type } : {}) } });
const typeOf = async (res) => (await res.json()).type;
const ID = '00000000-0000-7000-8000-0000000000c1';

const STAFF = [['GET', '/staff'], ['POST', '/staff/invitations', '{"name":"Pessoa Teste","email":"pessoa@example.org"}'],
  ['DELETE', `/staff/invitations/${ID}`], ['POST', `/staff/${ID}/roles`, '{"role":"comunicacao"}'],
  ['DELETE', `/staff/roles/${ID}`], ['POST', `/staff/${ID}/status`, '{"status":"suspended"}'], ['GET', '/audit/events']];

test('every staff endpoint refuses a missing or invalid token and aal1, without reaching the database', async () => {
  for (const [m, p, body] of STAFF) {
    let r = await api({})(req(m, p, { body, auth: null })); assert.equal(r.status, 401, `${m} ${p}`);
    r = await api({})(req(m, p, { body, auth: 'bad' })); assert.equal(r.status, 401, `${m} ${p}`);
    r = await api({ sub: SUB, aal: 'aal1', amr: [] })(req(m, p, { body })); assert.equal(r.status, 403);
    assert.equal(await typeOf(r), 'urn:mandato:error:aal2_required');
    r = await api({ sub: SUB, aal: 'aal2' })(req(m, p, { body })); assert.equal(r.status, 403, 'aal2 without totp');
  }
});

test('recent-auth endpoints refuse a stale or future TOTP with reauth_required', async () => {
  for (const [m, p, body] of STAFF.filter(([m]) => m !== 'GET')) {
    for (const amr of [totp(1200), [{ method: 'totp', timestamp: nowS() + 600 }]]) {
      const r = await api({ sub: SUB, aal: 'aal2', amr })(req(m, p, { body }));
      assert.equal(r.status, 403, `${m} ${p}`);
      assert.equal(await typeOf(r), 'urn:mandato:error:reauth_required');
    }
  }
});

test('activation with any body is a 400; malformed bodies, fields and ids are refused before the database', async () => {
  const a = api({ sub: SUB, aal: 'aal2', amr: totp(), email: 'pessoa@example.org' });
  assert.equal((await a(req('POST', '/me/activate', { body: '{}' }))).status, 400);
  assert.equal((await a(req('POST', '/me/activate', { body: '{"name":"Outra"}' }))).status, 400);
  assert.equal((await a(req('POST', '/staff/invitations', { body: '{"name":"P","email":"pessoa@example.org","role":"x"}' }))).status, 400);
  assert.equal((await a(req('POST', '/staff/invitations', { body: '{"name":"P","email":"sem-arroba"}' }))).status, 400);
  assert.equal((await a(req('POST', '/staff/invitations', { body: 'nao-json' }))).status, 400);
  assert.equal((await a(req('POST', '/staff/invitations', { body: '{"name":"P","email":"p@e.org"}', type: 'text/plain' }))).status, 400);
  assert.equal((await a(req('POST', `/staff/${ID}/status`, { body: '{"status":"deus"}' }))).status, 400);
  assert.equal((await a(req('GET', '/staff?limit=1000'))).status, 400);
  assert.equal((await a(req('GET', '/audit/events?cursor=abc'))).status, 400);
  assert.equal((await a(req('DELETE', '/staff/invitations/00000000-0000-7000-8000-00000000zzzz'))).status, 404);
  assert.equal((await a(req('PUT', '/staff'))).status, 405);
});

test('error bodies never echo the request', async () => {
  const a = api({ sub: SUB, aal: 'aal2', amr: totp() });
  const r = await a(req('POST', '/staff/invitations', { body: '{"name":"Pessoa Sintetica","email":"sintetica@example.org","x":1}' }));
  const text = await r.text();
  assert.equal(r.headers.get('content-type'), 'application/problem+json');
  assert.ok(!/sintetica|Pessoa/i.test(text));
});

// ---------------------------------------------------------------- sign-up hook with a fake database
const SECRET = `v1,whsec_${randomBytes(32).toString('base64')}`;
const signer = new Webhook(SECRET.slice(3));
function fakeDb({ open = true, hang = false } = {}) {
  const kek = new Uint8Array(randomBytes(32)); const KEK = '00000000-0000-7000-8000-0000000000ff';
  const IDX = '00000000-0000-7000-8000-0000000000b4';
  const dek = new Uint8Array(randomBytes(32));
  const env = { [`MANDATO_KEK_${KEK.replace(/-/g, '_')}`]: Buffer.from(kek).toString('base64') };
  const wrapped = c.wrapDek(kek, KEK, dek, 'demo', 'bi:email:v1', IDX);
  const db = { connects: 0, asked: [], release: null };
  const gate = new Promise((r) => { db.release = r; });
  db.pool = { connect: async () => { db.connects++; return {
    release() {},
    async query(sql, params) {
      if (/^(begin|commit|rollback|set local)/.test(sql) || sql.includes('set_config')) return { rows: [] };
      if (sql.includes('core.instance')) return { rows: [{ slug: 'demo' }] };
      if (sql.includes('index_key')) return { rows: [{ key_id: IDX, version: 1, enc_wrapped_key: wrapped }] };
      if (sql.includes('invitation_open')) {
        if (hang) await gate;
        db.asked.push(params[0]);
        return { rows: [{ open }] };
      }
      throw new Error(`unexpected ${sql}`);
    } }; } };
  db.env = env; db.expected = (email) => c.emailIndex(dek, 1, email);
  return db;
}
function hookReq({ id = `msg_${randomBytes(6).toString('hex')}`, email = 'convidada@example.org', ts = new Date(), mutate } = {}) {
  const body = JSON.stringify({ metadata: { name: 'before-user-created' }, user: { email, app_metadata: { provider: 'email' } } });
  const signature = signer.sign(id, ts, body);
  const sent = mutate ? mutate(body) : body;
  return new Request('http://api.test/api/v1/auth/hooks/before-user-created', { method: 'POST', body: sent,
    headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(Math.floor(ts / 1000)), 'webhook-signature': signature } });
}

test('hook: an open invitation is allowed, with the index computed in the API', async () => {
  const db = fakeDb({ open: true });
  const h = createSignupHook({ pool: db.pool, secret: SECRET, env: db.env });
  const r = await h(hookReq({ email: ' Convidada@Example.org ' }));
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), {});
  assert.deepEqual(db.asked[0], db.expected('convidada@example.org'));
});

test('hook: no open invitation is refused with the documented error shape', async () => {
  const db = fakeDb({ open: false });
  const r = await createSignupHook({ pool: db.pool, secret: SECRET, env: db.env })(hookReq());
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: { http_code: 403, message: 'Cadastro apenas por convite.' } });
});

test('hook: bad signature, stale timestamp and a re-serialized body are refused without the database', async () => {
  const db = fakeDb();
  const h = createSignupHook({ pool: db.pool, secret: SECRET, env: db.env });
  const bad = hookReq(); bad.headers.set('webhook-signature', 'v1,AAAA');
  assert.equal((await h(bad)).status, 403);
  assert.equal((await h(hookReq({ ts: new Date(Date.now() - 6 * 60_000) }))).status, 403);
  assert.equal((await h(hookReq({ mutate: (b) => JSON.stringify(JSON.parse(b), null, 1) }))).status, 403);
  assert.equal(db.connects, 0);
});

test('hook: a repeated webhook-id never reaches the database', async () => {
  const db = fakeDb();
  const h = createSignupHook({ pool: db.pool, secret: SECRET, env: db.env });
  const id = 'msg_repetida';
  assert.equal((await h(hookReq({ id }))).status, 200);
  assert.equal((await h(hookReq({ id }))).status, 200);
  assert.equal(db.connects, 1);
});

test('hook: a fifth concurrent request is refused at once; a database that hangs fails closed', async () => {
  const db = fakeDb({ hang: true });
  const h = createSignupHook({ pool: db.pool, secret: SECRET, env: db.env, budgetMs: 200 });
  const four = [1, 2, 3, 4].map(() => h(hookReq()));
  await new Promise((r) => setTimeout(r, 20));
  const fifth = await h(hookReq());
  assert.equal(fifth.status, 403);
  assert.equal(db.connects, 4);
  for (const r of await Promise.all(four)) assert.equal(r.status, 403);   // budget exceeded: refused
  db.release();
});

test('uuid7 is a version-7 RFC 4122 uuid ordered by time', () => {
  const a = uuid7(1_700_000_000_000), b = uuid7(1_700_000_000_001);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(a < b);
});

// ---------------------------------------------------------------- mandato auth check (design 0002 §8)
import { checkAuthConfig, authCheck } from '../packages/core-api/src/operator.js';
const GOOD = { hook_before_user_created_enabled: true, hook_before_user_created_uri: 'https://api.exemplo.test/api/v1/auth/hooks/before-user-created',
  mailer_autoconfirm: false, mfa_totp_enroll_enabled: true, mfa_totp_verify_enabled: true, mfa_phone_enroll_enabled: false,
  mfa_phone_verify_enabled: false, mfa_web_authn_enroll_enabled: false, mfa_web_authn_verify_enabled: false,
  external_anonymous_users_enabled: false, jwt_exp: 900, sessions_inactivity_timeout: 12, password_min_length: 12 };

test('auth check passes a compliant project and fails each wrong or missing setting', () => {
  assert.ok(checkAuthConfig(GOOD, { apiUrl: 'https://api.exemplo.test/' }).every((r) => r.pass));
  const bad = { hook_before_user_created_enabled: false, hook_before_user_created_uri: 'https://outro.test/api/v1/auth/hooks/before-user-created',
    mailer_autoconfirm: true, mfa_totp_enroll_enabled: false, mfa_totp_verify_enabled: false, mfa_phone_enroll_enabled: true,
    mfa_phone_verify_enabled: true, mfa_web_authn_enroll_enabled: true, mfa_web_authn_verify_enabled: true,
    external_anonymous_users_enabled: true, jwt_exp: 3600, sessions_inactivity_timeout: 0, password_min_length: 8 };
  for (const [k, v] of Object.entries(bad)) {
    const r = checkAuthConfig({ ...GOOD, [k]: v }, { apiUrl: 'https://api.exemplo.test' });
    assert.deepEqual(r.filter((x) => !x.pass).map((x) => x.field), [k]);
    const { [k]: _gone, ...missing } = GOOD;
    assert.deepEqual(checkAuthConfig(missing, { apiUrl: 'https://api.exemplo.test' }).filter((x) => !x.pass).map((x) => x.field), [k]);
  }
});

test('auth check calls only the Management API auth config, with the operator token, and refuses bad arguments', async () => {
  const ref = 'abcdefghijklmnopqrst';
  let seenUrl, seenAuth;
  const fetchFn = async (url, o) => { seenUrl = url; seenAuth = o.headers.authorization; assert.equal(o.redirect, 'error'); return new Response(JSON.stringify(GOOD)); };
  const r = await authCheck({ projectRef: ref, apiUrl: 'https://api.exemplo.test', token: 'tok-sintetico', fetchFn });
  assert.equal(seenUrl, `https://api.supabase.com/v1/projects/${ref}/config/auth`); assert.equal(seenAuth, 'Bearer tok-sintetico');
  assert.ok(r.every((x) => x.pass));
  await assert.rejects(authCheck({ projectRef: '../x', apiUrl: 'https://a.test', token: 't', fetchFn }));
  await assert.rejects(authCheck({ projectRef: ref, apiUrl: 'http://a.test', token: 't', fetchFn }));
  await assert.rejects(authCheck({ projectRef: ref, apiUrl: 'https://a.test', token: '', fetchFn }));
  await assert.rejects(authCheck({ projectRef: ref, apiUrl: 'https://a.test', token: 't', fetchFn: async () => new Response('', { status: 401 }) }));
});
