import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toCss } from '../packages/core-theme/src/css.js';
import { toNative } from '../packages/core-theme/src/native.js';
import { run } from '../packages/core-theme/src/build.js';

const root = new URL('../', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const tokens = json('tenants/demo/theme/tokens.json');

test('CSS contains every color in light and dark modes', () => {
  const css = toCss(tokens);
  const light = css.slice(css.indexOf(':root {'), css.indexOf('@media'));
  const dark = css.slice(css.indexOf('@media'));
  for (const name of Object.keys(tokens.color.light)) {
    assert.match(light, new RegExp(`--color-${name}: ${tokens.color.light[name]}`));
    assert.equal(dark.match(new RegExp(`--color-${name}: ${tokens.color.dark[name]}`, 'g')).length, 2);
  }
});

test('native colors are complete and camelCase', () => {
  const native = toNative(tokens);
  for (const mode of ['light', 'dark']) {
    assert.deepEqual(Object.keys(native[mode].colors).sort(), Object.keys(tokens.color[mode]).map((name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())).sort());
    assert.equal(native[mode].colors.brandOn, tokens.color[mode]['brand-on']);
    assert.equal(native[mode].colors.ctaOn, tokens.color[mode]['cta-on']);
  }
});

test('CLI refuses tokens that fail contrast', () => {
  const out = mkdtempSync(join(tmpdir(), 'mandato-theme-invalid-'));
  const errors = [];
  assert.equal(run(['tests/fixtures/negative/tokens-low-contrast.json', out], (message) => errors.push(message)), 1);
  assert.match(errors.join('\n'), /light: muted\/bg/);
});

test('CLI output is byte-identical across runs', () => {
  const outputs = [mkdtempSync(join(tmpdir(), 'mandato-theme-a-')), mkdtempSync(join(tmpdir(), 'mandato-theme-b-'))];
  for (const out of outputs) assert.equal(run(['tenants/demo/theme/tokens.json', out]), 0);
  for (const file of ['theme.css', 'theme.native.json']) {
    assert.deepEqual(readFileSync(join(outputs[0], file)), readFileSync(join(outputs[1], file)));
  }
});

test('CLI refuses font values that could break out of CSS', () => {
  const out = mkdtempSync(join(tmpdir(), 'mandato-theme-inject-'));
  const cases = [
    ['body', { family: 'x; } body { display: none } :root {' }],
    ['display', { family: 'system-ui', file: '../../etc/passwd.woff2' }],
    ['display', { family: 'system-ui', file: '/abs/font.woff2' }],
  ];
  for (const [role, value] of cases) {
    const bad = structuredClone(tokens);
    bad.typography[role] = value;
    const path = join(out, `${role}.json`);
    writeFileSync(path, JSON.stringify(bad));
    const errors = [];
    assert.equal(run([path, join(out, 'build')], (message) => errors.push(message)), 1, JSON.stringify(value));
    assert.match(errors.join('\n'), /schema validation failed/);
  }
  const ok = structuredClone(tokens);
  ok.typography.display = { family: '"Inter", system-ui, sans-serif', file: 'fonts/inter-var.woff2' };
  const path = join(out, 'ok.json');
  writeFileSync(path, JSON.stringify(ok));
  assert.equal(run([path, join(out, 'build')]), 0);
});
