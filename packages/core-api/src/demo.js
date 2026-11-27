// E0.6 · `mandato demo reset`: rebuilds a fictitious mandate from scratch, for development, demos and training.
// Synthetic data only. It refuses any database whose name does not end in _demo or _dev, and any tenant without a
// seed.sql (only demo tenants ship one), so it cannot be pointed at a real instance by mistake.
//   1. drop and create the database (superuser, PG* env); the Supabase shim stands in for auth.* locally;
//   2. bootstrap (core migrations) and migrate (modules), exactly as an instance would;
//   3. the tenant's seed.sql;
//   4. keys init with a development KEK (from MANDATO_KEK_<id>, or a new one written to <tenantDir>/.mandato-demo.env,
//      mode 0600, git-ignored);
//   5. the seed's staff get real ciphertext and blind indexes for synthetic names and e-mails (example.org).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import * as c from '../../crypto/src/envelope.js';
import { bootstrap, migrate } from '../../db/src/migrate.js';
import { loadTenant } from '../../core-config/src/load.js';
import { keysInit } from './operator.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEMO_KEK_ID = '00000000-0000-7000-8000-00000000deef';
const DB_NAME = /^[a-z][a-z0-9_]{0,50}_(demo|dev)$/;

// Synthetic staff, one per framework role, matching the ids in tenants/demo/seed.sql.
export const DEMO_STAFF = [
  { id: '00000000-0000-7000-8000-00000000d001', name: 'Dep. Exemplo da Silva', email: 'parlamentar@example.org' },
  { id: '00000000-0000-7000-8000-00000000d002', name: 'Chefe Exemplo Souza', email: 'chefe@example.org' },
  { id: '00000000-0000-7000-8000-00000000d003', name: 'Comunicação Exemplo Lima', email: 'comunicacao@example.org' },
  { id: '00000000-0000-7000-8000-00000000d004', name: 'Operador Exemplo Rocha', email: 'operador@example.org' },
];

function psqlFile(db, file) {
  const r = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${file}: ${(r.stderr || r.stdout).trim()}`);
}

function demoKek(tenantDir, env) {
  const name = `MANDATO_KEK_${DEMO_KEK_ID.replace(/-/g, '_')}`;
  if (env[name]) return { env, created: false };
  const file = join(tenantDir, '.mandato-demo.env');
  if (existsSync(file)) {
    const m = new RegExp(`^${name}=(\\S+)$`, 'm').exec(readFileSync(file, 'utf8'));
    if (m) return { env: { ...env, [name]: m[1] }, created: false };
  }
  const value = randomBytes(32).toString('base64');
  writeFileSync(file, `# Development KEK of the demo instance. Synthetic data only; never use for a real mandate.\n${name}=${value}\n`, { mode: 0o600 });
  return { env: { ...env, [name]: value }, created: true, file };
}

export async function demoReset(tenantDir, database, { env = process.env } = {}) {
  if (!DB_NAME.test(database)) throw new Error('demo reset: the database name must end in _demo or _dev');
  const dir = resolve(tenantDir);
  const seed = join(dir, 'seed.sql');
  if (!existsSync(seed)) throw new Error('demo reset: this tenant has no seed.sql; only demo tenants can be reset');
  const { config, errors } = loadTenant(dir);
  if (errors.length) throw new Error(`demo reset: tenant invalid: ${errors[0]}`);
  await c.ready();

  const admin = new pg.Client({ database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.query(`create database ${database}`);
  } finally { await admin.end(); }
  psqlFile(database, join(ROOT, 'packages/db/test/supabase-shim.sql'));
  bootstrap(database, dir);
  migrate(database, dir);
  psqlFile(database, seed);

  const kek = demoKek(dir, env);
  await keysInit(dir, database, { kekId: DEMO_KEK_ID, env: kek.env });

  const su = new pg.Client({ database });
  await su.connect();
  try {
    const { rows } = await su.query("select key_id, purpose, version, enc_wrapped_key from core.data_key where state = 'active'");
    const slug = config.instance.slug;
    const key = (purpose) => {
      const k = rows.find((r) => r.purpose === purpose);
      return { ...k, dek: c.unwrapDek(c.loadKek(c.keyIdOf(k.enc_wrapped_key), kek.env), k.enc_wrapped_key, slug, purpose, k.key_id) };
    };
    const [kn, ke, bi] = ['core.app_user.pii_name', 'core.app_user.pii_email', 'bi:email:v1'].map(key);
    const seal = (k, col, id, text) => c.seal(k.dek, k.key_id, Buffer.from(text, 'utf8'), c.dataAad(slug, col, id));
    await su.query('begin');
    await su.query('set local session_replication_role = replica');   // seed data, like seed.sql: no audit rows
    for (const s of DEMO_STAFF) {
      const r = await su.query('update core.app_user set pii_name = $2, pii_email = $3, bi_email = $4 where id = $1', [s.id,
        seal(kn, 'core.app_user.pii_name', s.id, s.name), seal(ke, 'core.app_user.pii_email', s.id, s.email),
        c.emailIndex(bi.dek, bi.version, s.email)]);
      if (r.rowCount !== 1) throw new Error(`demo reset: seed has no staff row ${s.id}`);
    }
    await su.query('commit');
  } finally { await su.end(); }
  return { database, kekFile: kek.created ? kek.file : null, staff: DEMO_STAFF.length };
}
