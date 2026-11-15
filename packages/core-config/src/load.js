// tenant.yaml loader and validator (backlog E0.2, design 0001 §5). Pure Node, no network.
// Returns { config, errors, pending }. `errors` make an instance invalid. `pending` lists references to framework
// parts that later lanes deliver (core modules, connectors); `--strict` turns them into errors.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { checkContrast } from '../../core-theme/src/contrast.js';
import { checkModule, checkTenant } from './check.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const schemas = {
  tenant: ajv.compile(readJson(join(root, 'packages/core-config/schema/tenant.schema.json'))),
  tokens: ajv.compile(readJson(join(root, 'packages/core-theme/schema/tokens.schema.json'))),
  module: ajv.compile(readJson(join(root, 'packages/core-contracts/schema/module.schema.json'))),
};
const fmt = (where, errs) => (errs ?? []).map((e) => `${where}${e.instancePath || '/'} ${e.message}`);

/** Framework modules and connectors that exist in this repository. Lanes add to these lists as they deliver. */
export const FRAMEWORK_MODULES = [];
export const INSTALLED_CONNECTORS = [];

export function loadTenant(dir, { strict = false } = {}) {
  const errors = []; const pending = [];
  const file = join(dir, 'tenant.yaml');
  if (!existsSync(file)) return { config: null, errors: [`${file} not found`], pending };
  let config;
  try { config = parseYaml(readFileSync(file, 'utf8')); } catch (e) { return { config: null, errors: [`tenant.yaml: ${e.message}`], pending }; }
  if (!schemas.tenant(config)) return { config, errors: fmt('tenant.yaml', schemas.tenant.errors), pending };
  errors.push(...checkTenant(config).map((p) => `tenant.yaml: ${p}`));

  const themeFile = join(dir, config.theme);
  if (!existsSync(themeFile)) errors.push(`theme ${config.theme} not found`);
  else {
    const tokens = readJson(themeFile);
    if (!schemas.tokens(tokens)) errors.push(...fmt(config.theme, schemas.tokens.errors));
    else errors.push(...checkContrast(tokens).map((f) => `${config.theme}: contrast ${f}`));
  }

  for (const m of config.modules) {
    const [vendor, name] = m.id.split('.');
    const local = join(dir, 'modules', name, 'mandato.module.json');
    if (vendor === 'core') {
      if (!FRAMEWORK_MODULES.includes(m.id)) pending.push(`module ${m.id} is not delivered yet`);
      continue;
    }
    if (!existsSync(local)) { errors.push(`module ${m.id}: ${local} not found`); continue; }
    const manifest = readJson(local);
    if (!schemas.module(manifest)) { errors.push(...fmt(`module ${m.id}`, schemas.module.errors)); continue; }
    if (manifest.id !== m.id) errors.push(`module ${m.id}: manifest declares ${manifest.id}`);
    errors.push(...checkModule(manifest).map((p) => `module ${m.id}: ${p}`));
    if (manifest.settings_schema) {
      const v = ajv.compile(readJson(join(dirname(local), manifest.settings_schema)));
      if (!v(m.settings ?? {})) errors.push(...fmt(`module ${m.id} settings`, v.errors));
    } else if (m.settings && Object.keys(m.settings).length) errors.push(`module ${m.id}: settings given but the module declares no settings_schema`);
  }
  for (const c of config.connectors ?? []) {
    if (!INSTALLED_CONNECTORS.includes(c.source_id)) pending.push(`connector ${c.source_id} is not delivered yet`);
  }
  if (strict) errors.push(...pending.splice(0));
  return { config, errors, pending };
}
