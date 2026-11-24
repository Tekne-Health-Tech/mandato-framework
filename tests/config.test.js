// E0.2: tenant.yaml loader and `mandato validate`, end to end on copies of the demo tenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { loadTenant } from '../packages/core-config/src/load.js';

const demo = new URL('../tenants/demo', import.meta.url).pathname;
const copy = (mutate) => {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-'));
  cpSync(demo, dir, { recursive: true });
  const t = parse(readFileSync(join(dir, 'tenant.yaml'), 'utf8'));
  mutate?.(t, dir);
  writeFileSync(join(dir, 'tenant.yaml'), stringify(t));
  return dir;
};
const cli = (...args) => spawnSync('node', [new URL('../packages/core-config/bin/mandato.js', import.meta.url).pathname, ...args], { encoding: 'utf8' });

test('demo tenant loads; unfinished framework parts are reported as pending, not errors', () => {
  const r = loadTenant(demo);
  assert.deepEqual(r.errors, []);
  assert.ok(r.pending.some((p) => p.includes('core.content')));
  assert.equal(r.config.instance.slug, 'demo');
});
test('--strict turns pending references into errors', () => assert.ok(loadTenant(demo, { strict: true }).errors.length > 0));
test('an unknown key is an error', () => assert.ok(loadTenant(copy((t) => { t.flags = { beta: true }; })).errors.length > 0));
test('a low-contrast theme is an error', () => {
  const dir = copy((t, d) => cpSync(new URL('./fixtures/negative/tokens-low-contrast.json', import.meta.url).pathname, join(d, 'theme/tokens.json')));
  assert.ok(loadTenant(dir).errors.some((e) => e.includes('contrast')));
});
test('module settings must match the module settings_schema', () => {
  const dir = copy((t) => { t.modules.find((m) => m.id === 'demo.hello').settings = { greeting: 1 }; });
  assert.ok(loadTenant(dir).errors.some((e) => e.includes('demo.hello settings')));
});
test('a module that is not on disk is an error', () => {
  const dir = copy((t) => { t.modules.push({ id: 'demo.missing' }); });
  assert.ok(loadTenant(dir).errors.some((e) => e.includes('demo.missing')));
});
test('an ambiguous keyring is an error', () => {
  const dir = copy((t) => { t.publish_keys.push({ ...t.publish_keys[0] }); });
  assert.ok(loadTenant(dir).errors.some((e) => e.includes('publish')));
});
test('mandato validate exits 0, 1 and 2', () => {
  assert.equal(cli('validate', demo).status, 0);
  assert.equal(cli('validate', copy((t) => { t.flags = {}; })).status, 1);
  assert.equal(cli('validate').status, 2);
});

// Wave 1 cross-provider review (docs/lanes/wave-1-review-codex.md): each case failed before the fix.
const addModule = (dir, name, manifest) => {
  cpSync(join(dir, 'modules/hello'), join(dir, 'modules', name), { recursive: true });
  const base = parse(readFileSync(join(dir, 'modules/hello/mandato.module.json'), 'utf8'));
  writeFileSync(join(dir, 'modules', name, 'mandato.module.json'), JSON.stringify({ ...base, ...manifest }));
};
const withHello = (patch) => copy((t, d) => {
  const p = join(d, 'modules/hello/mandato.module.json');
  writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), ...patch }));
});
test('review 3: two modules with the same short are an error', () => {
  const dir = copy((t, d) => {
    addModule(d, 'other', { id: 'demo.other', roles: [], permissions: [] });
    t.modules.push({ id: 'demo.other', settings: { greeting: 'Oi' } });
  });
  assert.ok(loadTenant(dir).errors.some((e) => e.includes('short hello is already used')));
});
test('review 4: inline credentials are refused, *_secret_ref is accepted', () => {
  const bad = [
    (t) => { t.connectors[0].params.authorization = 'Bearer SYNTHETIC_NOT_A_SECRET'; },
    (t) => { t.connectors[0].params.endpoint = 'Bearer SYNTHETIC_NOT_A_SECRET'; },
    (t) => { t.connectors[0].params.client_secret_value = 'x'; },
    (t) => { t.modules.find((m) => m.id === 'demo.hello').settings.private_key = 'x'; },
  ];
  for (const mutate of bad) assert.ok(loadTenant(copy(mutate)).errors.some((e) => e.includes('credential')), mutate.toString());
  assert.ok(!loadTenant(copy((t) => { t.connectors[0].params.auth_secret_ref = 'vault:ibge'; })).errors.some((e) => e.includes('credential')));
});
test('review 5: framework range and enabled dependencies are checked', () => {
  assert.ok(loadTenant(withHello({ requires_framework: '^99.0.0' })).errors.some((e) => e.includes('requires framework')));
  assert.ok(loadTenant(withHello({ requires_framework: '*' })).errors.some((e) => e.includes('not a supported range')));
  assert.ok(loadTenant(withHello({ requires_modules: ['core.missing'] })).errors.some((e) => e.includes('core.missing, which is not enabled')));
  assert.deepEqual(loadTenant(withHello({ requires_modules: ['core.content'] })).errors, []);
});
test('review 6: paths may not leave the tenant or the module', () => {
  assert.ok(loadTenant(copy((t) => { t.theme = '../outside/tokens.json'; })).errors.some((e) => e.includes('outside')));
  assert.ok(loadTenant(withHello({ settings_schema: '../../outside.json' })).errors.some((e) => e.includes('outside')));
  assert.ok(loadTenant(withHello({ migrations: '../../outside-migrations' })).errors.some((e) => e.includes('outside the module')));
});
test('review 7: an unknown validate flag is a usage error', () => assert.equal(cli('validate', demo, '--strcit').status, 2));
test('review 8: duplicate cause slugs are an error', () => {
  assert.ok(loadTenant(copy((t) => { t.causes.push({ ...t.causes[0], name: 'Outra' }); })).errors.some((e) => e.includes('duplicate cause slug')));
});
test('review 10: malformed referenced JSON is a validation error, not a crash', () => {
  const theme = copy((t, d) => writeFileSync(join(d, 'theme/tokens.json'), '{'));
  assert.ok(loadTenant(theme).errors.some((e) => e.includes('invalid JSON')));
  const manifest = copy((t, d) => writeFileSync(join(d, 'modules/hello/mandato.module.json'), '{'));
  assert.ok(loadTenant(manifest).errors.some((e) => e.includes('invalid JSON')));
  const settings = copy((t, d) => writeFileSync(join(d, 'modules/hello/settings.schema.json'), '{"type": 5}'));
  assert.ok(loadTenant(settings).errors.some((e) => e.includes('not a valid schema')));
});

test('re-check 4: a credential under a plain `key` name is refused', () => {
  assert.ok(loadTenant(copy((t) => { t.connectors[0].params.key = 'SYNTHETIC_CREDENTIAL'; })).errors.some((e) => e.includes('credential')));
});
test('re-check 6: a symlink that points outside the tenant is refused', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  cpSync(join(demo, 'theme/tokens.json'), join(outside, 'tokens.json'));
  const dir = copy((t, d) => { symlinkSync(outside, join(d, 'theme-link')); t.theme = 'theme-link/tokens.json'; });
  assert.ok(loadTenant(dir).errors.some((e) => e.includes('outside')));
  const inner = copy((t, d) => { symlinkSync(join(d, 'theme'), join(d, 'theme-inner')); t.theme = 'theme-inner/tokens.json'; });
  assert.deepEqual(loadTenant(inner).errors, []);
});
test('final check 6: a module directory symlinked outside the tenant is refused', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-mod-'));
  cpSync(join(demo, 'modules/hello'), outside, { recursive: true });
  const dir = copy((t, d) => { cpSync(join(d, 'modules/hello'), join(d, 'hello-moved'), { recursive: true }); });
  const target = join(dir, 'modules/hello');
  spawnSync('rm', ['-r', target]);
  symlinkSync(outside, target);
  assert.ok(loadTenant(dir).errors.some((e) => e.includes('outside the tenant')));
});
test('design 0003: connectors[].raw_retention_days is an integer from 1 to 3650', () => {
  assert.deepEqual(loadTenant(copy((t) => { t.connectors[0].raw_retention_days = 90; })).errors, []);
  for (const v of [0, 3651, 1.5, '90']) assert.ok(loadTenant(copy((t) => { t.connectors[0].raw_retention_days = v; })).errors.length > 0, String(v));
});
