// `mandato bootstrap` and `mandato migrate` (backlog E0.4, design 0001 §7.2). Shells out to psql; connection comes
// from the standard PG* environment variables, and the database name from the first argument.
//   bootstrap: as a superuser, once per instance, on every framework upgrade and whenever a module is added: applies
//              0001 if absent and every later core migration not yet recorded (each in one transaction that also
//              records it), creates each module's NOLOGIN owner role and schema, lets migrator SET ROLE to it.
//   migrate:   as `migrator`, forward-only: records 0001 (applied before the log existed), refuses a core migration
//              that bootstrap has not applied, then applies module migrations in order, each in one
//              transaction under a migration lease and SET ROLE mod_<short>_owner. A recorded file whose hash
//              changed aborts. Forbidden statements are rejected before anything runs.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inside, loadTenant } from '../../core-config/src/load.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE_DIR = join(root, 'packages/db/migrations');
const coreFiles = () => readdirSync(CORE_DIR).filter((f) => /^\d{4}_core\.sql$/.test(f)).sort();
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

function psql(db, user, sql, { file } = {}) {
  const args = ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-U', user];
  const r = spawnSync('psql', file ? [...args, '-f', file] : [...args, '-f', '-'], { input: file ? undefined : sql, encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout).trim());
  return r.stdout.trim();
}

// §7.2: a module migration may not create SECURITY DEFINER functions, event triggers, extensions or roles, and may
// not change roles, grants on other schemas or session authorization. Comments and string bodies are stripped first.
// This screen is an early lint. The boundary is the database: migrator is a member of no core or audit owner role,
// record_migration needs the transaction's own migration lease, and the file runs through EXECUTE, so psql never
// interprets it (no backslash commands such as \i or \!).
const FORBIDDEN = [
  [/\bsecurity\s+definer\b/i, 'SECURITY DEFINER'], [/\bevent\s+trigger\b/i, 'event trigger'],
  [/\bcreate\s+(or\s+replace\s+)?extension\b/i, 'CREATE EXTENSION'], [/\b(create|alter|drop)\s+(role|user|group)\b/i, 'role DDL'],
  [/\bset\s+(session\s+)?role\b/i, 'SET ROLE'], [/\bset\s+session\s+authorization\b/i, 'SET SESSION AUTHORIZATION'],
  [/\bsearch_path\b/i, 'search_path change'], [/\bset_config\b/i, 'set_config'], [/\b(core|audit|api|public|pg_catalog|auth)\s*\./i, 'object outside the module schema'],
  [/\bgrant\b[\s\S]*\bto\s+(public|anon|authenticated)\b/i, 'grant to client roles'], [/\bcopy\b[\s\S]*\b(program|from\s+'\/)/i, 'COPY from server'],
];
export function forbiddenStatements(sql) {
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\breferences\s+core\.\w+\s*\(\s*id\s*\)/gi, 'references ok')   // FK to a core id column is allowed (§7.2)
    .replace(/\bexecute\s+function\s+audit\.row_trigger\s*\(\s*\)/gi, 'execute ok');   // the audit row trigger (design 0003 §6.4)
  return FORBIDDEN.filter(([re]) => re.test(code)).map(([, why]) => why);
}

function localModules(tenantDir) {
  const { config, errors } = loadTenant(tenantDir);
  if (errors.length) throw new Error(`tenant invalid:\n${errors.join('\n')}`);
  return config.modules.filter((m) => !m.id.startsWith('core.')).map((m) => {
    const dir = join(tenantDir, 'modules', m.id.split('.')[1]);
    const manifest = JSON.parse(readFileSync(join(dir, 'mandato.module.json'), 'utf8'));
    return { id: m.id, short: manifest.short, requires: manifest.requires_modules ?? [], migrations: manifest.migrations ? inside(dir, manifest.migrations) : null };
  });
}

/** Dependency order (requires_modules first); a cycle or an unknown dependency is an error. */
function ordered(mods) {
  const byId = new Map(mods.map((m) => [m.id, m])); const out = []; const state = new Map();
  const visit = (m, path) => {
    if (state.get(m.id) === 'done') return;
    if (state.get(m.id) === 'open') throw new Error(`module dependency cycle: ${[...path, m.id].join(' -> ')}`);
    state.set(m.id, 'open');
    for (const d of m.requires) { if (d.startsWith('core.')) continue; if (!byId.has(d)) throw new Error(`${m.id} requires ${d}, which is not enabled`); visit(byId.get(d), [...path, m.id]); }
    state.set(m.id, 'done'); out.push(m);
  };
  for (const m of [...mods].sort((a, b) => (a.id < b.id ? -1 : 1))) visit(m, []);
  return out;
}

export function bootstrap(db, tenantDir, superuser = process.env.PGUSER || 'postgres') {
  const has = psql(db, superuser, "select count(*) from pg_namespace where nspname = 'core'");
  if (has === '0') psql(db, superuser, null, { file: join(CORE_DIR, '0001_core.sql') });
  const recorded = new Map(psql(db, superuser, "select migration_id || '=' || sha256 from audit.migration_log where module_id = 'core'")
    .split('\n').filter(Boolean).map((l) => l.split('=')));
  for (const f of coreFiles().filter((x) => x !== '0001_core.sql')) {
    const text = readFileSync(join(CORE_DIR, f), 'utf8'); const hash = sha(text);
    if (recorded.has(f)) {
      if (recorded.get(f) !== hash) throw new Error(`core migration ${f} changed after it was applied; migrations are forward-only`);
      continue;
    }
    // Applied and recorded atomically: the superuser runs the file, then acts as migrator to record it under a lease.
    psql(db, superuser, `begin;\n${text}\nset local session authorization migrator;
      select audit.bind_migration('core', ${lit(f)}); select audit.record_migration('core', ${lit(f)}, ${lit(hash)});
      commit;`);
  }
  for (const m of localModules(tenantDir)) {
    const role = `mod_${m.short}_owner`;
    psql(db, superuser, `do $$ begin
        if not exists (select 1 from pg_roles where rolname = ${lit(role)}) then execute format('create role %I', ${lit(role)}); end if;
        execute format('alter role %I nologin noinherit nosuperuser nobypassrls nocreaterole nocreatedb noreplication', ${lit(role)});
      end $$;
      create schema if not exists ${'mod_' + m.short} authorization ${role};
      revoke all on schema ${'mod_' + m.short} from public;
      grant ${role} to migrator;
      grant usage on schema audit to ${role};
      grant execute on function audit.row_trigger() to ${role};   -- module tables carry the audit trigger (design 0003 §6.4)
      grant usage on schema ${'mod_' + m.short} to audit_owner;    -- audit.write resolves the entity name; no table rights`);
  }
}

export function migrate(db, tenantDir, migrator = 'migrator') {
  const applied = new Map(psql(db, migrator, "select module_id || ':' || migration_id || '=' || sha256 from audit.migration_log")
    .split('\n').filter(Boolean).map((l) => l.split('=')));
  const steps = coreFiles().map((f) => ({ module: 'core', id: f, file: join(CORE_DIR, f), core: true }));
  for (const m of ordered(localModules(tenantDir))) {
    if (!m.migrations || !existsSync(m.migrations)) continue;
    for (const f of readdirSync(m.migrations).filter((x) => x.endsWith('.sql')).sort()) steps.push({ module: m.id, short: m.short, id: f, file: join(m.migrations, f) });
  }
  // A recorded migration of core or of an enabled module whose file is gone also aborts: history is forward-only.
  const present = new Set(steps.map((s) => `${s.module}:${s.id}`));
  const enabled = new Set(['core', ...localModules(tenantDir).map((m) => m.id)]);
  for (const key of applied.keys()) {
    const module = key.slice(0, key.indexOf(':'));
    if (enabled.has(module) && !present.has(key)) throw new Error(`migration ${key} was applied but its file is missing; migrations are forward-only`);
  }
  const done = [];
  for (const s of steps) {
    const text = readFileSync(s.file, 'utf8'); const hash = sha(text); const key = `${s.module}:${s.id}`;
    if (applied.has(key)) {
      if (applied.get(key) !== hash) throw new Error(`migration ${key} changed after it was applied (recorded ${applied.get(key)}, file ${hash}); migrations are forward-only`);
      continue;
    }
    if (s.core) {   // core migrations run at bootstrap as superuser; migrate only records 0001, which predates the log.
      if (s.id !== '0001_core.sql') throw new Error(`core migration ${s.id} is not applied; run mandato bootstrap as the superuser first`);
      psql(db, migrator, `begin; select audit.bind_migration('core', ${lit(s.id)}); select audit.record_migration('core', ${lit(s.id)}, ${lit(hash)}); commit;`);
      done.push(key); continue;
    }
    const bad = forbiddenStatements(text);
    if (bad.length) throw new Error(`migration ${key} rejected: ${bad.join(', ')}`);
    const tag = `m${randomBytes(12).toString('hex')}`;   // random dollar-quote tag; the file cannot close it
    if (text.includes(tag)) throw new Error(`migration ${key}: quoting tag collision, run again`);
    psql(db, migrator, `begin;
      select audit.bind_migration(${lit(s.module)}, ${lit(s.id)});
      set local role mod_${s.short}_owner;
      set local search_path = mod_${s.short}, pg_temp;
      do $${tag}_do$ begin execute $${tag}$${text}$${tag}$; end $${tag}_do$;
      reset role;
      select audit.record_migration(${lit(s.module)}, ${lit(s.id)}, ${lit(hash)});
      commit;`);
    done.push(key);
  }
  provisionSources(db, tenantDir, migrator);
  return done;
}

// Design 0003 §6.1: one core.data_source row per tenant.yaml connector. name and terms_url are placeholders that the
// connector runner replaces from the manifest on the first run; existing rows are never changed here.
function provisionSources(db, tenantDir, migrator) {
  const { config } = loadTenant(tenantDir);
  const rows = (config.connectors ?? []).map((c) => `(${lit(c.source_id)}, ${lit(c.source_id)}, '', ${lit(c.schedule)})`);
  if (!rows.length) return;
  psql(db, migrator, `begin; select audit.bind_migration('core', 'sources');
    insert into core.data_source (source_id, name, terms_url, cadence) values ${rows.join(', ')} on conflict (source_id) do nothing;
    commit;`);
}
