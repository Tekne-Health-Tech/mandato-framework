// E0.5 / design 0002 §9: the API against a real Postgres, end to end, through the operator CLI:
// keys init → bootstrap-chief → sign-up hook → activation → invitations → roles → status → audit, and no PII anywhere.
// Run by packages/db/test/run.sh (PG* env, superuser). Synthetic people and keys only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { Webhook } from 'standardwebhooks';
import { createApi } from '../src/api.js';
import { createVerifier } from '../src/jwt.js';
import * as c from '../../crypto/src/envelope.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DB = `${process.env.TEST_DB ?? 'mandato_test'}_api`;
const TENANT = `${ROOT}/tenants/demo`;
const ISS = 'https://exemplo.supabase.test/auth/v1';
const KEK_ID = '00000000-0000-7000-8000-0000000000ff';
const KEK_ENV = `MANDATO_KEK_${KEK_ID.replace(/-/g, '_')}`;
const SECRET = `v1,whsec_${randomBytes(32).toString('base64')}`;
const PEOPLE = { chief: ['Chefe Sintética', 'chefe.sintetica@example.org'], inv: ['Pessoa Convidada Sintética', 'convidada.sintetica@example.org'],
  other: ['Outra Pessoa Sintética', 'outra.sintetica@example.org'] };
const CHIEF = randomUUID(); const INV = randomUUID();
const env = { [KEK_ENV]: Buffer.from(randomBytes(32)).toString('base64') };
const seen = [];   // every response body, CLI output and log line, checked for PII at the end
const named = [];  // bodies of GET /me and GET /staff, the only answers that may carry a name (never an e-mail)
let su, pool, api, kp, hook;

const sql = (q, p) => su.query(q, p);
function cli(args) {
  const r = spawnSync('node', [`${ROOT}/packages/core-config/bin/mandato.js`, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  seen.push(r.stdout, r.stderr);
  return r;
}
const nowS = () => Math.floor(Date.now() / 1000);
const token = (sub, email, { aal = 'aal2', age = 0 } = {}) => new SignJWT({ aal, email,
  amr: aal === 'aal2' ? [{ method: 'totp', timestamp: nowS() - age }, { method: 'password', timestamp: nowS() - 3600 }] : [{ method: 'password', timestamp: nowS() }] })
  .setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject(sub).setIssuer(ISS).setAudience('authenticated')
  .setIssuedAt().setExpirationTime('10m').sign(kp.privateKey);
async function call(method, path, { as, body, opts } = {}) {
  const headers = {};
  if (as) headers.authorization = `Bearer ${await token(as[0], as[1], opts)}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await api(new Request(`https://api.test/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  (method === 'GET' && /^\/(me|staff)(\?|$)/.test(path) ? named : seen).push(text);
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const signer = new Webhook(SECRET.slice(3));
async function signup(email) {
  const id = `msg_${randomBytes(8).toString('hex')}`; const ts = new Date();
  const body = JSON.stringify({ metadata: { name: 'before-user-created' }, user: { email } });
  const res = await api(new Request('https://api.test/api/v1/auth/hooks/before-user-created', { method: 'POST', body,
    headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': String(Math.floor(ts / 1000)), 'webhook-signature': signer.sign(id, ts, body) } }));
  seen.push(await res.clone().text());
  return res.status;
}
const chief = [CHIEF, PEOPLE.chief[1]]; const inv = [INV, PEOPLE.inv[1]];

before(async () => {
  await c.ready();
  const admin = new pg.Client({ database: 'postgres' }); await admin.connect();
  await admin.query(`drop database if exists ${DB}`); await admin.query(`create database ${DB}`); await admin.end();
  const shim = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f', `${ROOT}/packages/db/test/supabase-shim.sql`], { encoding: 'utf8' });
  assert.equal(shim.status, 0, shim.stderr);
  assert.equal(cli(['bootstrap', TENANT, DB]).status, 0);
  su = new pg.Client({ database: DB }); await su.connect();
  await sql(`set session_replication_role = replica;
    insert into core.instance (slug, display_name, house_acronym, uf, config_version, framework_version) values ('demo','Mandato Dep. Exemplo','ALEX','EX','test','0.1.0');
    set session_replication_role = origin;`);
  kp = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const verify = createVerifier({ issuer: ISS, jwksUri: `${ISS}/.well-known/jwks.json`,
    fetchFn: async () => new Response(JSON.stringify({ keys: [jwk] })) });
  pool = new pg.Pool({ database: DB, user: 'api_rt', max: 6 });
  api = createApi({ pool, verify, hookSecret: SECRET, env, log: (l) => seen.push(l) });
});
after(async () => { await pool?.end(); await su?.end(); });

test('keys init registers the five staff keys once, wrapped; a second run changes nothing', async () => {
  let r = cli(['keys', 'init', TENANT, DB, '--kek-id', KEK_ID]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /created .*bi:email:v1/); assert.match(r.stdout, /age -r/);
  r = cli(['keys', 'init', TENANT, DB, '--kek-id', KEK_ID]);
  assert.equal(r.status, 0); assert.match(r.stdout, /already exist/);
  const { rows } = await sql("select count(*)::int n, count(distinct key_id)::int k from core.data_key where data_class = 'C2'");
  assert.deepEqual(rows[0], { n: 5, k: 5 });
  assert.notEqual(cli(['keys', 'init', TENANT, DB, '--kek-id', '00000000-0000-7000-8000-0000000000fe']).status, 0, 'an unloaded KEK is refused');
});

test('bootstrap chief: invitation, sign-up hook, activation; a second bootstrap is refused', async () => {
  const [name, email] = PEOPLE.chief;
  assert.equal(cli(['staff', 'bootstrap-chief', TENANT, DB, '--name', name, '--email', email]).status, 0);
  assert.equal(await signup(email), 200);
  assert.equal(await signup(PEOPLE.other[1]), 403);
  assert.equal((await call('POST', '/me/activate', { as: chief, opts: { aal: 'aal1' } })).status, 403);
  assert.equal((await call('POST', '/me/activate', { as: chief })).status, 201);
  assert.equal(await signup(email), 403, 'the used invitation no longer admits a sign-up');
  const me = await call('GET', '/me', { as: chief });
  assert.equal(me.status, 200); assert.equal(me.body.name, name);
  assert.deepEqual(me.body.roles.map((r) => r.role), ['chefe_gabinete']);
  assert.notEqual(cli(['staff', 'bootstrap-chief', TENANT, DB, '--name', 'X Y', '--email', 'x@example.org']).status, 0);
});

test('invite, sign up, activate; a member without a role sees only themself', async () => {
  const [name, email] = PEOPLE.inv;
  assert.equal((await call('POST', '/staff/invitations', { as: chief, body: { name, email }, opts: { age: 1200 } })).status, 403, 'stale TOTP');
  const created = await call('POST', '/staff/invitations', { as: chief, body: { name, email } });
  assert.equal(created.status, 201);
  assert.equal(await signup(` ${email.toUpperCase()} `), 200, 'the index normalizes the e-mail');
  assert.equal((await call('POST', '/me/activate', { as: [INV, PEOPLE.other[1]] })).status, 403, 'a JWT for another e-mail finds no invitation');
  assert.equal((await call('POST', '/me/activate', { as: inv })).status, 201);
  assert.equal((await call('POST', '/me/activate', { as: inv })).status, 403, 'a second activation finds no open invitation');
  const me = await call('GET', '/me', { as: inv });
  assert.equal(me.body.name, name); assert.deepEqual(me.body.roles, []);
  for (const [m, p] of [['GET', '/staff'], ['GET', '/audit/events']]) assert.equal((await call(m, p, { as: inv })).status, 403);
  assert.equal((await call('POST', '/staff/invitations', { as: inv, body: { name: 'A B', email: 'a@example.org' } })).status, 403);
});

test('the chief lists staff with names decrypted in the API, pages with a cursor, grants and revokes roles', async () => {
  const all = await call('GET', '/staff', { as: chief });
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.data.map((u) => u.name).sort(), [PEOPLE.chief[0], PEOPLE.inv[0]].sort());
  const p1 = await call('GET', '/staff?limit=1', { as: chief });
  assert.equal(p1.body.data.length, 1); assert.ok(p1.body.next_cursor);
  const p2 = await call('GET', `/staff?limit=1&cursor=${p1.body.next_cursor}`, { as: chief });
  assert.equal(p2.body.data.length, 1); assert.equal(p2.body.next_cursor, null);
  const g = await call('POST', `/staff/${INV}/roles`, { as: chief, body: { role: 'comunicacao' } });
  assert.equal(g.status, 201);
  assert.equal((await call('POST', `/staff/${CHIEF}/roles`, { as: chief, body: { role: 'comunicacao' } })).status, 409, 'not on oneself');
  assert.equal((await call('DELETE', `/staff/roles/${g.body.assignment_id}`, { as: chief })).status, 204);
  assert.equal((await call('DELETE', `/staff/roles/${g.body.assignment_id}`, { as: chief })).status, 409);
});

test('a suspended chief loses every staff endpoint at once, whatever the token says', async () => {
  const g = await call('POST', `/staff/${INV}/roles`, { as: chief, body: { role: 'chefe_gabinete' } });
  assert.equal(g.status, 201);
  assert.equal((await call('GET', '/staff', { as: inv })).status, 200);
  assert.equal((await call('POST', `/staff/${INV}/status`, { as: chief, body: { status: 'suspended' } })).status, 204);
  assert.equal((await call('GET', '/me', { as: inv })).status, 404, 'a suspended member does not read their own profile');
  for (const [m, p, body] of [['GET', '/staff'], ['GET', '/audit/events'], ['POST', `/staff/${CHIEF}/status`, { status: 'suspended' }],
    ['POST', '/staff/invitations', { name: 'A B', email: 'a@example.org' }]]) {
    assert.equal((await call(m, p, { as: inv, body })).status, 403, `${m} ${p}`);
  }
  assert.equal((await call('POST', `/staff/${CHIEF}/status`, { as: chief, body: { status: 'suspended' } })).status, 409, 'not oneself');
  assert.equal((await call('POST', `/staff/${INV}/status`, { as: chief, body: { status: 'active' } })).status, 204);
  assert.equal((await call('GET', '/staff', { as: inv })).status, 200);
});

test('a cancelled invitation no longer admits a sign-up', async () => {
  const [name, email] = PEOPLE.other;
  const created = await call('POST', '/staff/invitations', { as: chief, body: { name, email } });
  assert.equal(await signup(email), 200);
  assert.equal((await call('DELETE', `/staff/invitations/${created.body.id}`, { as: chief })).status, 204);
  assert.equal(await signup(email), 403);
  assert.equal((await call('DELETE', `/staff/invitations/${created.body.id}`, { as: chief })).status, 409);
});

test('the audit trail shows the staff actions to the chief, newest first, with ids only', async () => {
  const ev = await call('GET', '/audit/events?limit=100', { as: chief });
  assert.equal(ev.status, 200);
  const actions = new Set(ev.body.data.map((e) => e.action));
  for (const a of ['bootstrap_chief', 'activate', 'set_status']) assert.ok(actions.has(a), a);
  const ids = ev.body.data.map((e) => e.id);
  assert.deepEqual([...ids].sort().reverse(), ids);
  assert.ok(ev.body.data.some((e) => e.actor_kind === 'migration' && e.actor_id.startsWith('core:bootstrap-chief:')));
});

test('no synthetic e-mail or name appears in responses, logs, audit rows or ciphertext columns', async () => {
  const needles = Object.values(PEOPLE).flat().flatMap((s) => [s, s.toLowerCase(), s.split('@')[0]]);
  const audit = (await sql('select details::text || coalesce(entity_id, \'\') || actor_id t from audit.event')).rows.map((r) => r.t);
  const cipher = (await sql(`select encode(pii_name, 'escape') || encode(pii_email, 'escape') t from core.app_user
                             union all select encode(pii_name, 'escape') || encode(pii_email, 'escape') from core.staff_invitation`)).rows.map((r) => r.t);
  const haystack = [...seen, ...audit, ...cipher].join('\n');
  for (const n of needles) assert.ok(!haystack.includes(n), `found ${n.slice(0, 3)}…`);
  const emails = Object.values(PEOPLE).map(([, e]) => e);
  for (const e of emails) assert.ok(!named.join('\n').includes(e), 'GET /me and /staff never return an e-mail');
  assert.ok(named.join('\n').includes(PEOPLE.inv[0]), 'the check is not vacuous: names do reach the chief');
});
