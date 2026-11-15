// E0.2: tenant.yaml loader and `mandato validate`, end to end on copies of the demo tenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
