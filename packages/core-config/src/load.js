// tenant.yaml loader and validator (backlog E0.2, design 0001 §5). Pure Node, no network.
// Returns { config, errors, pending }. `errors` make an instance invalid. `pending` lists references to framework
// parts that later lanes deliver (core modules, connectors); `--strict` turns them into errors.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { checkContrast } from '../../core-theme/src/contrast.js';
import { checkModule, checkTenant, satisfies } from './check.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const schemas = {
  tenant: ajv.compile(readJson(join(root, 'packages/core-config/schema/tenant.schema.json'))),
  tokens: ajv.compile(readJson(join(root, 'packages/core-theme/schema/tokens.schema.json'))),
  module: ajv.compile(readJson(join(root, 'packages/core-contracts/schema/module.schema.json'))),
};
const fmt = (where, errs) => (errs ?? []).map((e) => `${where}${e.instancePath || '/'} ${e.message}`);

/** Contract version of this framework (design 0001 status line). Modules declare `requires_framework` against it. */
export const FRAMEWORK_VERSION = '0.1.0';
/** Framework modules that exist in this repository. Lanes add to this list as they deliver. */
export const FRAMEWORK_MODULES = [];
/** Installed connectors: source_id -> JSON Schema of its `params`. A connector lane delivers its schema with
 *  `additionalProperties: false`; that schema, not the credential heuristic, is what keeps credentials out of
 *  params in production (`--strict` refuses a connector that is not installed). */
export const INSTALLED_CONNECTORS = {};

/** Resolve a config-relative path and refuse anything that leaves `base`: absolute paths, `..`, and symlinks that
 *  point outside (the check compares real paths once the target exists). */
export function inside(base, rel) {
  if (typeof rel !== 'string' || !rel || isAbsolute(rel)) return null;
  const within = (b, f) => { const r = relative(b, f); return r && !r.startsWith('..') && !isAbsolute(r); };
  const full = resolve(base, rel);
  if (!within(resolve(base), full)) return null;
  if (existsSync(full) && !within(realpathSync(base), realpathSync(full))) return null;
  return full;
}

/** Read a JSON file below `base`; returns [value, error]. Never throws. */
function json(base, rel, what) {
  const p = inside(base, rel);
  if (!p) return [null, `${what} ${rel} is outside ${base}`];
  if (!existsSync(p)) return [null, `${what} ${rel} not found`];
  try { return [readJson(p), null]; } catch (e) { return [null, `${what} ${rel}: invalid JSON (${e.message})`]; }
}

export function loadTenant(dir, { strict = false } = {}) {
  const errors = []; const pending = [];
  const file = join(dir, 'tenant.yaml');
  if (!existsSync(file)) return { config: null, errors: [`${file} not found`], pending };
  let config;
  try { config = parseYaml(readFileSync(file, 'utf8')); } catch (e) { return { config: null, errors: [`tenant.yaml: ${e.message}`], pending }; }
  if (!schemas.tenant(config)) return { config, errors: fmt('tenant.yaml', schemas.tenant.errors), pending };
  errors.push(...checkTenant(config).map((p) => `tenant.yaml: ${p}`));

  const [tokens, themeErr] = json(dir, config.theme, 'theme');
  if (themeErr) errors.push(themeErr);
  else if (!schemas.tokens(tokens)) errors.push(...fmt(config.theme, schemas.tokens.errors));
  else errors.push(...checkContrast(tokens).map((f) => `${config.theme}: contrast ${f}`));

  const enabled = new Set(config.modules.map((m) => m.id));
  const shorts = new Map();
  const scheduleIds = new Set();
  for (const m of config.modules) {
    const [vendor, name] = m.id.split('.');
    if (vendor === 'core') {
      if (!FRAMEWORK_MODULES.includes(m.id)) pending.push(`module ${m.id} is not delivered yet`);
      continue;
    }
    const modDir = join(dir, 'modules', name);
    // the module directory itself must be inside the tenant (a symlinked module directory is the module's root)
    if (existsSync(modDir) && !inside(dir, join('modules', name))) { errors.push(`module ${m.id}: modules/${name} is outside the tenant`); continue; }
    const [manifest, manErr] = json(modDir, 'mandato.module.json', `module ${m.id}:`);
    if (manErr) { errors.push(manErr); continue; }
    if (!schemas.module(manifest)) { errors.push(...fmt(`module ${m.id}`, schemas.module.errors)); continue; }
    if (manifest.id !== m.id) errors.push(`module ${m.id}: manifest declares ${manifest.id}`);
    errors.push(...checkModule(manifest).map((p) => `module ${m.id}: ${p}`));
    for (const sc of manifest.schedules ?? []) scheduleIds.add(`${manifest.short}.${sc.id}`);
    // §7.1: `short` names the owner role and schema (mod_<short>), so it must be unique in the instance.
    if (shorts.has(manifest.short)) errors.push(`module ${m.id}: short ${manifest.short} is already used by ${shorts.get(manifest.short)}`);
    else shorts.set(manifest.short, m.id);
    // §7.2: framework compatibility and enabled dependencies.
    const fit = satisfies(FRAMEWORK_VERSION, manifest.requires_framework);
    if (fit === null) errors.push(`module ${m.id}: requires_framework ${manifest.requires_framework} is not a supported range (x.y.z, ^x.y.z, ~x.y.z, >=x.y.z)`);
    else if (!fit) errors.push(`module ${m.id}: requires framework ${manifest.requires_framework}, this is ${FRAMEWORK_VERSION}`);
    for (const d of manifest.requires_modules) if (!enabled.has(d)) errors.push(`module ${m.id}: requires ${d}, which is not enabled`);
    if (manifest.migrations && !inside(modDir, manifest.migrations)) errors.push(`module ${m.id}: migrations ${manifest.migrations} is outside the module`);
    if (manifest.settings_schema) {
      const [schema, sErr] = json(modDir, manifest.settings_schema, `module ${m.id}: settings_schema`);
      if (sErr) { errors.push(sErr); continue; }
      let v;
      try { v = ajv.compile(schema); } catch (e) { errors.push(`module ${m.id}: settings_schema is not a valid schema (${e.message})`); continue; }
      if (!v(m.settings ?? {})) errors.push(...fmt(`module ${m.id} settings`, v.errors));
    } else if (m.settings && Object.keys(m.settings).length) errors.push(`module ${m.id}: settings given but the module declares no settings_schema`);
  }
  for (const key of Object.keys(config.schedules ?? {})) if (!scheduleIds.has(key)) errors.push(`schedules: ${key} names no schedule of an enabled module`);
  for (const c of config.connectors ?? []) {
    const paramsSchema = INSTALLED_CONNECTORS[c.source_id];
    if (!paramsSchema) { pending.push(`connector ${c.source_id} is not delivered yet`); continue; }
    const v = ajv.compile(paramsSchema);
    if (!v(c.params ?? {})) errors.push(...fmt(`connector ${c.source_id} params`, v.errors));
  }
  if (strict) errors.push(...pending.splice(0));
  return { config, errors, pending };
}
