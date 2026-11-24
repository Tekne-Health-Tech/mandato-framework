// `mandato instance up|check|down|render` (design 0004 §8).
// Builds one instance from tenant.yaml: renders instance.json, asks the worker image which pools, hosts and secrets
// the instance needs, generates a compose file with the network layout of §3, then runs the existing commands
// (bootstrap, migrate, register, keys) in a one-shot tools container on the database network and starts the services.
// It never creates a hosted project, account, bucket or DNS record.
// Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { loadTenant } from '../../packages/core-config/src/load.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const LOCK = JSON.parse(readFileSync(join(ROOT, 'infra/images/lock.json'), 'utf8'));
const pinned = (name) => { const i = LOCK.images.find((x) => x.name === name); return `${i.name}:${i.tag}@${i.digest}`; };
export const LOGIN_ROLES = ['migrator', 'worker_c1', 'worker_c2', 'worker_c3', 'scheduler', 'fetch_c1'];
const DEMO_KEK_ID = '00000000-0000-7000-8000-00000000deef';
const UID = { worker: '10001:10010', scheduler: '10002:10002', fetch: '10003:10010', egress: '10004:10004' };
const NAME = /^[a-z][a-z0-9_]{1,62}$/;

// ---------------------------------------------------------------- render (§5.1): the tenant as the runtime reads it
export function renderInstance(tenantDir, env, { tenantRoot = '/srv/tenant' } = {}) {
  const { config, errors } = loadTenant(tenantDir, { strict: env !== 'local' });
  if (errors.length) throw new Error(`tenant invalid:\n${errors.join('\n')}`);
  const modules = [];
  for (const m of config.modules) {
    if (m.id.startsWith('core.')) continue;
    const name = m.id.split('.')[1];
    const manifest = JSON.parse(readFileSync(join(tenantDir, 'modules', name, 'mandato.module.json'), 'utf8'));
    modules.push({ id: m.id, short: manifest.short, worker: manifest.worker ? `modules/${name}/${manifest.worker}` : null,
      schedules: manifest.schedules ?? [] });
  }
  return { version: 1, slug: config.instance.slug, env, timezone: config.timezone, tenant_root: tenantRoot,
    connectors: (config.connectors ?? []).map((c) => ({ source_id: c.source_id, schedule: c.schedule, params: c.params ?? {},
      raw_retention_days: c.raw_retention_days ?? 180, enabled: c.enabled ?? true })),
    modules, schedule_overrides: config.schedules ?? {} };
}

// ---------------------------------------------------------------- compose (§3)
/**
 * @param {object} o
 * @param {'local'|'staging'} o.env
 * @param {string} o.project   compose project name
 * @param {string} o.database
 * @param {string[]} o.pools   from the registry probe
 * @param {string[]} o.secretRefs connector API key refs (files in <state>/secrets/connectors)
 * @param {string} o.tenantDir @param {string} o.stateDir
 * @param {{host: string, port: number}} [o.dbEndpoint] staging: the managed database
 * @param {object} [o.images]  { worker, tools } local image names
 * @param {object} [o.extra]   test overlays (network test): services/networks merged in
 */
export function composeFor(o) {
  const local = o.env === 'local';
  const pgHost = local ? 'postgres' : o.dbEndpoint.host;
  const images = { worker: 'mandato-worker:dev', tools: 'mandato-tools:dev', ...o.images };
  const secretsDir = join(o.stateDir, 'secrets');
  const pgEnv = (role) => ({ PGHOST: pgHost, PGPORT: String(local ? 5432 : o.dbEndpoint.port), PGPASSWORD_FILE: `/run/secrets/pg_${role}`,
    ...(local ? { PGSSLMODE: 'disable' } : {}) });
  const alive = { test: ['CMD', 'python', '-c', 'import os,sys,time; sys.exit(0 if time.time()-os.path.getmtime("/run/mandato/alive")<180 else 1)'],
    interval: '30s', timeout: '5s', retries: 3, start_period: '30s' };
  const common = { image: images.worker, init: true, read_only: true, cap_drop: ['ALL'], security_opt: ['no-new-privileges:true'],
    restart: 'unless-stopped', stop_grace_period: '15m' };
  // each service runs as its own uid and owns its private tmpfs (liveness file, §4.1)
  const as = (uid) => { const [u, g] = uid.split(':'); return { ...common, user: uid, tmpfs: [`/run/mandato:mode=0700,uid=${u},gid=${g}`, '/tmp'] }; };
  const ro = (src, dst) => ({ type: 'bind', source: src, target: dst, read_only: true });
  const tenant = ro(resolve(o.tenantDir), '/srv/tenant');
  const inst = ro(join(o.stateDir, 'instance.json'), '/srv/state/instance.json');
  const secret = (role) => ro(join(secretsDir, `pg_${role}`), `/run/secrets/pg_${role}`);
  const services = {};
  const networks = { db: { internal: true }, outside: {} };
  if (local) {
    services.postgres = { image: pinned('postgres'), user: '999:999', networks: ['db'], restart: 'unless-stopped',
      environment: { POSTGRES_PASSWORD_FILE: '/run/secrets/pg_postgres' }, volumes: ['pgdata:/var/lib/postgresql/data', secret('postgres')],
      healthcheck: { test: ['CMD', 'pg_isready', '-U', 'postgres'], interval: '5s', timeout: '5s', retries: 20 } };
  } else {
    // §3: the only path to the managed database; its network alias is the database's own host name, so workers
    // connect to that name and verify the server certificate against it (sslmode verify-full).
    services.dbgw = { ...as(UID.egress), stop_grace_period: '30s', healthcheck: undefined,
      command: ['python', '-m', 'workers.core.egress.dbgw', '--listen', `0.0.0.0:${o.dbEndpoint.port}`, '--dest', `${o.dbEndpoint.host}:${o.dbEndpoint.port}`,
        ...(o.allowPrivateDest ? ['--allow-private-dest'] : [])],
      networks: { db: { aliases: [o.dbEndpoint.host] }, outside: {} } };
  }
  const dependsDb = local ? { postgres: { condition: 'service_healthy' } } : { dbgw: { condition: 'service_started' } };
  services.scheduler = { ...as(UID.scheduler), networks: ['db'], environment: pgEnv('scheduler'), healthcheck: alive,
    command: ['python', '-m', 'workers.core.runtime.scheduler', '--instance', '/srv/state/instance.json', '--tenant-root', '/srv/tenant', '--database', o.database],
    volumes: [tenant, inst, secret('scheduler')], depends_on: dependsDb };
  for (const pool of o.pools) {
    const svc = { ...as(UID.worker), networks: ['db'], environment: pgEnv(`worker_${pool}`), healthcheck: alive,
      command: ['python', '-m', 'workers.core.runtime.worker', '--pool', pool, '--instance', '/srv/state/instance.json', '--tenant-root', '/srv/tenant', '--database', o.database],
      volumes: [tenant, inst, secret(`worker_${pool}`)], depends_on: dependsDb };
    if (pool === 'c1') {
      svc.volumes.push('raw:/var/lib/mandato/raw', 'sock_c1:/run/mandato-fetch');
      services['fetch-c1'] = { ...as(UID.fetch), networks: ['db', 'fetch_c1'], environment: pgEnv('fetch_c1'),
        command: ['python', '-m', 'workers.core.fetch.sidecar', '--instance', '/srv/state/instance.json', '--tenant-root', '/srv/tenant',
          '--database', o.database, '--socket', '/run/mandato-fetch/fetch.sock', '--egress', 'egress:3128',
          ...(o.fetchCa ? ['--ca-file', '/run/secrets/fetch_ca.pem'] : [])],
        volumes: [tenant, inst, secret('fetch_c1'), 'sock_c1:/run/mandato-fetch',
          ...o.secretRefs.map((r) => ro(join(secretsDir, 'connectors', r), `/run/secrets/${r}`)),
          ...(o.fetchCa ? [ro(o.fetchCa, '/run/secrets/fetch_ca.pem')] : [])],
        depends_on: { ...dependsDb, egress: { condition: 'service_started' } } };
      services.egress = { ...as(UID.egress), stop_grace_period: '30s', networks: ['fetch_c1', 'outside'],
        command: ['python', '-m', 'workers.core.egress.proxy', '--hosts-file', '/srv/state/egress-hosts.txt', '--listen', '0.0.0.0:3128'],
        volumes: [ro(join(o.stateDir, 'egress-hosts.txt'), '/srv/state/egress-hosts.txt')] };
      networks.fetch_c1 = { internal: true };
    }
    services[`worker-${pool}`] = svc;
  }
  for (const s of Object.values(services)) if (s.healthcheck === undefined) delete s.healthcheck;
  services.tools = { image: images.tools, profiles: ['tools'], networks: ['db'], user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
    environment: { PGHOST: pgHost, PGPORT: String(local ? 5432 : o.dbEndpoint.port), PGUSER: 'postgres', PGPASSFILE: '/srv/state/secrets/pgpass',
      ...(local ? { PGSSLMODE: 'disable' } : { PGSSLMODE: 'verify-full' }) },
    volumes: [tenant, ro(o.stateDir, '/srv/state')], depends_on: dependsDb };
  const doc = { name: o.project, services, networks,
    volumes: { ...(local ? { pgdata: {} } : {}), ...(o.pools.includes('c1') ? { raw: {}, sock_c1: {} } : {}) } };
  if (o.extra) {
    Object.assign(doc.services, o.extra.services ?? {});
    Object.assign(doc.networks, o.extra.networks ?? {});
    for (const [n, net] of Object.entries(o.extra.networkPatch ?? {})) doc.networks[n] = { ...doc.networks[n], ...net };
  }
  return doc;
}

// ---------------------------------------------------------------- helpers
function sh(cmd, args, { input, quiet = false, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 4).join(' ')}…: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-5).join(' | ')}`);
  if (!quiet && r.stdout.trim()) process.stdout.write(r.stdout);
  return r.stdout.trim();
}

function secretFile(path, gen = () => randomBytes(24).toString('base64url')) {
  if (existsSync(path)) return { value: readFileSync(path, 'utf8').trim(), created: false };
  const value = gen();
  writeFileSync(path, `${value}\n`, { mode: 0o644 });   // readable inside the one container that mounts it; dir is 0700
  return { value, created: true };
}

export function stateDirFor(tenantDir, env) {
  const { config } = loadTenant(tenantDir);
  return join(ROOT, 'infra/.state', `${config.instance.slug}-${env}`);
}

export function defaultDatabase(tenantDir) {
  const { config } = loadTenant(tenantDir);
  return `mandato_${config.instance.slug.replace(/-/g, '_')}_dev`;
}

const step = (name, fn) => {
  process.stdout.write(`instance: ${name}\n`);
  try { return fn(); } catch (e) { throw new Error(`step '${name}' failed: ${e.message}`); }
};

// ---------------------------------------------------------------- up (§8)
/**
 * @param {string} tenantDir
 * @param {object} o  { env: 'local', database?, resetDemo?, images?, extra?, fetchCa?, kekId? }
 */
export function up(tenantDir, o) {
  if (o.env !== 'local') throw new Error('instance up: only --env local is implemented in this lane; staging waits on L3 (design 0004 §8)');
  tenantDir = resolve(tenantDir);
  const database = o.database ?? defaultDatabase(tenantDir);
  if (!NAME.test(database)) throw new Error(`instance up: invalid database name ${database}`);
  const stateDir = o.stateDir ?? stateDirFor(tenantDir, o.env);
  const secretsDir = join(stateDir, 'secrets');
  mkdirSync(join(secretsDir, 'connectors'), { recursive: true });
  chmodSync(stateDir, 0o700);
  chmodSync(secretsDir, 0o700);

  const rendered = step('render', () => renderInstance(tenantDir, o.env));
  writeFileSync(join(stateDir, 'instance.json'), `${JSON.stringify(rendered, null, 2)}\n`);
  const images = { worker: 'mandato-worker:dev', tools: 'mandato-tools:dev', ...o.images };
  const probe = step('registry', () => JSON.parse(sh('docker', ['run', '--rm', '--network', 'none', '-v', `${tenantDir}:/srv/tenant:ro`,
    '-v', `${join(stateDir, 'instance.json')}:/srv/state/instance.json:ro`, images.worker,
    'python', '-m', 'workers.core.runtime.registry', '/srv/state/instance.json', '--tenant-root', '/srv/tenant'], { quiet: true })));
  writeFileSync(join(stateDir, 'egress-hosts.txt'), probe.egress_hosts.map((h) => `${h}\n`).join(''));
  for (const ref of probe.secret_refs) {
    if (!existsSync(join(secretsDir, 'connectors', ref))) throw new Error(`instance up: connector secret ${ref} is missing in ${join(secretsDir, 'connectors')}`);
  }
  const pw = {};
  const fresh = new Set();
  for (const role of ['postgres', ...LOGIN_ROLES]) {
    const s = secretFile(join(secretsDir, `pg_${role}`));
    pw[role] = s.value;
    if (s.created) fresh.add(role);
  }
  const pgpass = ['postgres', ...LOGIN_ROLES].map((r) => `*:*:*:${r}:${pw[r]}`).join('\n');
  writeFileSync(join(secretsDir, 'pgpass'), `${pgpass}\n`, { mode: 0o600 });
  const kek = secretFile(join(secretsDir, 'demo_kek'), () => randomBytes(32).toString('base64'));

  const project = `mandato-${rendered.slug}-${o.env}`;
  const doc = composeFor({ env: o.env, project, database, pools: probe.pools, secretRefs: probe.secret_refs, tenantDir, stateDir,
    images, extra: o.extra, fetchCa: o.fetchCa });
  const file = join(stateDir, 'compose.yaml');
  writeFileSync(file, `# generated by mandato instance up (design 0004 §3); do not edit\n${stringify(doc)}`);
  const dc = (...args) => sh('docker', ['compose', '-f', file, ...args], { quiet: true });

  step('database service', () => dc('up', '-d', '--wait', ...(o.env === 'local' ? ['postgres'] : ['dbgw'])));
  // secrets reach the tools container by name only (`-e NAME`), never on a command line
  const tools = (args, env = {}) => sh('docker', ['compose', '-f', file, 'run', '--rm', '-T',
    ...Object.keys(env).flatMap((k) => ['-e', k]), 'tools', ...args], { quiet: true, env: { ...process.env, ...env } });
  const psql = (sql, db = 'postgres') => sh('docker', ['compose', '-f', file, 'run', '--rm', '-T', '--entrypoint', 'psql', 'tools',
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', '-'], { input: sql, quiet: true });

  // Login roles exist before bootstrap so migrator can authenticate; 0001 hardens their attributes, the password stays.
  // A password is (re)set only when its secret was just created or the role has none, so a second `up` changes nothing.
  step('role passwords', () => {
    const lit = (v) => `'${v.replace(/'/g, "''")}'`;
    const have = new Set(psql(`select string_agg(rolname || ':' || (rolpassword is not null)::text, ',') from pg_authid
      where rolname in (${LOGIN_ROLES.map(lit).join(',')})`).split(',').filter(Boolean));
    const sql = LOGIN_ROLES.map((r) => {
      if (!have.has(`${r}:true`) && !have.has(`${r}:false`)) return `create role ${r} login password ${lit(pw[r])};`;
      if (fresh.has(r) || have.has(`${r}:false`)) return `alter role ${r} password ${lit(pw[r])};`;
      return '';
    }).join('\n');
    if (sql.trim()) psql(sql);
  });
  const exists = psql(`select count(*) from pg_database where datname = '${database}'`) === '1';
  const demo = existsSync(join(tenantDir, 'seed.sql'));
  const kekEnv = { [`MANDATO_KEK_${DEMO_KEK_ID.replace(/-/g, '_')}`]: kek.value };
  if (demo && (!exists || o.resetDemo)) {
    step('demo reset', () => tools(['demo', 'reset', '/srv/tenant', database], kekEnv));
  } else {
    if (!exists) step('create database', () => { psql(`create database ${database}`); psql(readFileSync(join(ROOT, 'packages/db/test/supabase-shim.sql'), 'utf8'), database); });
    step('bootstrap', () => tools(['bootstrap', '/srv/tenant', database]));
    step('migrate', () => tools(['migrate', '/srv/tenant', database]));
  }
  step('register instance', () => tools(['instance', 'register', '/srv/tenant', database, '--env', o.env]));
  if (!demo) {
    if (!o.kekId) throw new Error('instance up: a non-demo instance needs --kek-id and MANDATO_KEK_<id> in the environment');
    step('keys init', () => tools(['keys', 'init', '/srv/tenant', database, '--kek-id', o.kekId],
      { [`MANDATO_KEK_${o.kekId.replace(/-/g, '_')}`]: process.env[`MANDATO_KEK_${o.kekId.replace(/-/g, '_')}`] ?? '' }));
  }
  step('services', () => dc('up', '-d', '--wait', '--remove-orphans'));
  const result = step('check', () => check(tenantDir, { env: o.env, database, stateDir }));
  return { project, file, database, pools: probe.pools, missingSources: probe.missing_sources, check: result };
}

// ---------------------------------------------------------------- check (§8): read-only
export function check(tenantDir, o) {
  const stateDir = o.stateDir ?? stateDirFor(resolve(tenantDir), o.env);
  const file = join(stateDir, 'compose.yaml');
  const database = o.database ?? defaultDatabase(resolve(tenantDir));
  const out = [];
  const ps = sh('docker', ['compose', '-f', file, 'ps', '--format', 'json'], { quiet: true });
  const rows = ps.startsWith('[') ? JSON.parse(ps) : ps.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) out.push({ what: `service ${r.Service}`, pass: r.State === 'running' && (r.Health === '' || r.Health === 'healthy'), detail: r.Health || r.State });
  const psql = (sql) => sh('docker', ['compose', '-f', file, 'run', '--rm', '-T', '--entrypoint', 'psql', 'tools',
    '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', sql], { quiet: true });
  const { config } = loadTenant(resolve(tenantDir));
  out.push({ what: 'instance registered', pass: psql("select slug || '|' || coalesce(env, '') from core.instance") === `${config.instance.slug}|${o.env}` });
  out.push({ what: 'migrations recorded', pass: Number(psql("select count(*) from audit.migration_log where module_id = 'core'")) >= 5 });
  out.push({ what: 'staff keys present', pass: Number(psql("select count(distinct purpose) from core.data_key where state = 'active'")) >= 3 });
  out.push({ what: 'runtime roles hardened', pass: psql(`select count(*) from pg_roles where rolname in (${LOGIN_ROLES.map((r) => `'${r}'`).join(',')}) and (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb)`) === '0' });
  for (const r of out) process.stdout.write(`${r.pass ? 'ok  ' : 'FAIL'} ${r.what}${r.detail ? ` (${r.detail})` : ''}\n`);
  if (!out.every((r) => r.pass)) throw new Error('instance check failed');
  return out;
}

export function down(tenantDir, o) {
  if (o.env !== 'local') throw new Error('instance down: refuses anything but --env local');
  const file = join(o.stateDir ?? stateDirFor(resolve(tenantDir), o.env), 'compose.yaml');
  sh('docker', ['compose', '-f', file, 'down', ...(o.volumes ? ['--volumes'] : [])], { quiet: true });
}
