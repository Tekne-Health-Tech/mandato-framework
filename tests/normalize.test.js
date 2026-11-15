import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as normalize from '../packages/crypto/src/normalize.js';

const vectors = JSON.parse(readFileSync(new URL('../packages/crypto/vectors/normalize-v1.json', import.meta.url), 'utf8'));

for (const kind of ['email', 'phone']) {
  test(`normalize-v1 ${kind} vectors`, () => {
    for (const v of vectors[kind]) {
      if (v.error) assert.throws(() => normalize[kind](v.in), { message: v.error }, v.in);
      else assert.equal(normalize[kind](v.in), v.out, v.in);
    }
  });
}
