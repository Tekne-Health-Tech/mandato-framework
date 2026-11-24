// E0.6 · `mandato demo reset` against a real Postgres: guards, rebuild, synthetic staff readable with the dev KEK, rerun.
// Run by packages/db/test/run.sh (PG* env, superuser). Works on a copy of tenants/demo so the dev KEK file stays out of the repo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as c from '../../crypto/src/envelope.js';
import { demoReset, DEMO_STAFF, DEMO_KEK_ID } from '../src/demo.js';
import { loadTenant } from '../../core-config/src/load.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DB = `${process.env.TEST_DB ?? 'mandato_test'}_demo`;
const KEK_VAR = `MANDATO_KEK_${DEMO_KEK_ID.replace(/-/g, '_')}`;
let work, tenant, noSeed;

before(async () => {
  await c.ready();
  work = mkdtempSync(join(tmpdir(), 'mandato-demo-'));
  tenant = join(work, 'demo');
  cpSync(join(ROOT, 'tenants/demo'), tenant, { recursive: true });
  rmSync(join(tenant, '.mandato-demo.env'), { force: true });
  noSeed = join(work, 'noseed');
  cpSync(join(ROOT, 'tenants/demo'), noSeed, { recursive: true });
  rmSync(join(noSeed, 'seed.sql'));
});
after(async () => {
  const admin = new pg.Client({ database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.end();
  rmSync(work, { recursive: true, force: true });
});

async function staff(env) {
  const slug = loadTenant(tenant).config.instance.slug;
  const su = new pg.Client({ database: DB });
  await su.connect();
  try {
    const keys = (await su.query("select key_id, purpose, version, enc_wrapped_key from core.data_key where state = 'active'")).rows;
    const dek = (p) => { const k = keys.find((r) => r.purpose === p); return { ...k, dek: c.unwrapDek(c.loadKek(c.keyIdOf(k.enc_wrapped_key), env), k.enc_wrapped_key, slug, p, k.key_id) }; };
    const [kn, ke, bi] = ['core.app_user.pii_name', 'core.app_user.pii_email', 'bi:email:v1'].map(dek);
    const { rows } = await su.query('select id, pii_name, pii_email, bi_email from core.app_user order by id');
    return rows.map((r) => ({ id: r.id,
      name: c.open(kn.dek, r.pii_name, c.dataAad(slug, 'core.app_user.pii_name', r.id)).toString('utf8'),
      email: c.open(ke.dek, r.pii_email, c.dataAad(slug, 'core.app_user.pii_email', r.id)).toString('utf8'),
      biOk: Buffer.compare(r.bi_email, c.emailIndex(bi.dek, bi.version, c.open(ke.dek, r.pii_email, c.dataAad(slug, 'core.app_user.pii_email', r.id)).toString('utf8'))) === 0 }));
  } finally { await su.end(); }
}

test('refuses a database whose name does not end in _demo or _dev', async () => {
  for (const name of ['mandato', 'mandato_prod', 'x_demo; drop database postgres', 'Mandato_demo', 'demo']) {
    await assert.rejects(demoReset(tenant, name, { env: {} }), /must end in _demo or _dev/, name);
  }
});

test('refuses a tenant without seed.sql', async () => {
  await assert.rejects(demoReset(noSeed, DB, { env: {} }), /no seed\.sql/);
});

test('rebuilds the fictitious mandate with readable synthetic staff and a 0600 dev KEK file', async () => {
  const r = await demoReset(tenant, DB, { env: {} });
  assert.equal(r.staff, 4);
  assert.equal(r.kekFile, join(tenant, '.mandato-demo.env'));
  assert.equal(statSync(r.kekFile).mode & 0o777, 0o600);
  const value = new RegExp(`^${KEK_VAR}=(\\S+)$`, 'm').exec(readFileSync(r.kekFile, 'utf8'))[1];
  const got = await staff({ [KEK_VAR]: value });
  assert.deepEqual(got.map(({ id, name, email }) => ({ id, name, email })), DEMO_STAFF);
  assert.ok(got.every((s) => s.biOk), 'blind indexes match the synthetic e-mails');
  assert.ok(DEMO_STAFF.every((s) => s.email.endsWith('@example.org')));
});

test('a second reset through the CLI reuses the dev KEK and rebuilds the same state', async () => {
  const before = readFileSync(join(tenant, '.mandato-demo.env'), 'utf8');
  const su = new pg.Client({ database: DB });
  await su.connect();
  await su.query('begin'); await su.query('set local session_replication_role = replica');
  await su.query("insert into core.app_user (id, pii_name, pii_email, bi_email, status) values (core.uuid7(), '\\x00', '\\x00', '\\xee', 'active')");
  await su.query('commit'); await su.end();
  const out = spawnSync('node', [join(ROOT, 'packages/core-config/bin/mandato.js'), 'demo', 'reset', tenant, DB], { encoding: 'utf8', env: { ...process.env, [KEK_VAR]: '' } });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /rebuilt with 4 synthetic staff$/m);
  assert.equal(readFileSync(join(tenant, '.mandato-demo.env'), 'utf8'), before, 'the dev KEK file is not rewritten');
  const value = /=(\S+)$/m.exec(before)[1];
  assert.deepEqual((await staff({ [KEK_VAR]: value })).map((s) => s.id), DEMO_STAFF.map((s) => s.id), 'the extra row is gone');
});

test('the CLI refuses a production-looking database name with a non-zero exit', () => {
  const out = spawnSync('node', [join(ROOT, 'packages/core-config/bin/mandato.js'), 'demo', 'reset', tenant, 'mandato_prod'], { encoding: 'utf8' });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /must end in _demo or _dev/);
});
