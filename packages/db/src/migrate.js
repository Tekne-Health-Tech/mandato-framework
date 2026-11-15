// `mandato bootstrap` and `mandato migrate` (backlog E0.4, design 0001 §7.2). Shells out to psql; connection comes
// from the standard PG* environment variables, and the database name from the first argument.
//   bootstrap: as a superuser, once per instance and whenever a module is added: applies 0001 if absent, creates
//              each module's NOLOGIN owner role and schema, lets migrator SET ROLE to it.
//   migrate:   as `migrator`, forward-only: records 0001, then applies module migrations in order, each in one
//              transaction under a migration lease and SET ROLE mod_<short>_owner. A recorded file whose hash
//              changed aborts. Forbidden statements are rejected before anything runs.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadTenant } from '../../core-config/src/load.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CORE = join(root, 'packages/db/migrations/0001_core.sql');
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
const FORBIDDEN = [
  [/\bsecurity\s+definer\b/i, 'SECURITY DEFINER'], [/\bevent\s+trigger\b/i, 'event trigger'],
  [/\bcreate\s+(or\s+replace\s+)?extension\b/i, 'CREATE EXTENSION'], [/\b(create|alter|drop)\s+(role|user|group)\b/i, 'role DDL'],
  [/\bset\s+(session\s+)?role\b/i, 'SET ROLE'], [/\bset\s+session\s+authorization\b/i, 'SET SESSION AUTHORIZATION'],
  [/\bsearch_path\b/i, 'search_path change'], [/\b(core|audit|api|public|pg_catalog|auth)\s*\./i, 'object outside the module schema'],
  [/\bgrant\b[\s\S]*\bto\s+(public|anon|authenticated)\b/i, 'grant to client roles'], [/\bcopy\b[\s\S]*\b(program|from\s+'\/)/i, 'COPY from server'],
];
export function forbiddenStatements(sql) {
  const code = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\breferences\s+core\.\w+\s*\(\s*id\s*\)/gi, 'references ok');   // FK to a core id column is allowed (§7.2)
  return FORBIDDEN.filter(([re]) => re.test(code)).map(([, why]) => why);
}

function localModules(tenantDir) {
  const { config, errors } = loadTenant(tenantDir);
  if (errors.length) throw new Error(`tenant invalid:\n${errors.join('\n')}`);
  return config.modules.filter((m) => !m.id.startsWith('core.')).map((m) => {
    const dir = join(tenantDir, 'modules', m.id.split('.')[1]);
    const manifest = JSON.parse(readFileSync(join(dir, 'mandato.module.json'), 'utf8'));
    return { id: m.id, short: manifest.short, requires: manifest.requires_modules ?? [], migrations: manifest.migrations ? join(dir, manifest.migrations) : null };
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
  if (has === '0') psql(db, superuser, null, { file: CORE });
  for (const m of localModules(tenantDir)) {
    const role = `mod_${m.short}_owner`;
    psql(db, superuser, `do $$ begin
        if not exists (select 1 from pg_roles where rolname = ${lit(role)}) then execute format('create role %I', ${lit(role)}); end if;
        execute format('alter role %I nologin noinherit nosuperuser nobypassrls nocreaterole nocreatedb noreplication', ${lit(role)});
      end $$;
      create schema if not exists ${'mod_' + m.short} authorization ${role};
      revoke all on schema ${'mod_' + m.short} from public;
      grant ${role} to migrator;`);
  }
}

export function migrate(db, tenantDir, migrator = 'migrator') {
  const applied = new Map(psql(db, migrator, "select module_id || ':' || migration_id || '=' || sha256 from audit.migration_log")
    .split('\n').filter(Boolean).map((l) => l.split('=')));
  const steps = [{ module: 'core', id: '0001_core.sql', file: CORE, core: true }];
  for (const m of ordered(localModules(tenantDir))) {
    if (!m.migrations || !existsSync(m.migrations)) continue;
    for (const f of readdirSync(m.migrations).filter((x) => x.endsWith('.sql')).sort()) steps.push({ module: m.id, short: m.short, id: f, file: join(m.migrations, f) });
  }
  const done = [];
  for (const s of steps) {
    const text = readFileSync(s.file, 'utf8'); const hash = sha(text); const key = `${s.module}:${s.id}`;
    if (applied.has(key)) {
      if (applied.get(key) !== hash) throw new Error(`migration ${key} changed after it was applied (recorded ${applied.get(key)}, file ${hash}); migrations are forward-only`);
      continue;
    }
    if (s.core) {   // 0001 runs at bootstrap as superuser; migrate only records it, once.
      psql(db, migrator, `begin; select audit.bind_migration('core', ${lit(s.id)}); select audit.record_migration('core', ${lit(s.id)}, ${lit(hash)}); commit;`);
      done.push(key); continue;
    }
    const bad = forbiddenStatements(text);
    if (bad.length) throw new Error(`migration ${key} rejected: ${bad.join(', ')}`);
    psql(db, migrator, `begin;
      select audit.bind_migration(${lit(s.module)}, ${lit(s.id)});
      set local role mod_${s.short}_owner;
      set local search_path = mod_${s.short}, pg_temp;
      ${text}
      reset role;
      select audit.record_migration(${lit(s.module)}, ${lit(s.id)}, ${lit(hash)});
      commit;`);
    done.push(key);
  }
  return done;
}
