import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
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
