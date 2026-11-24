// E0.5 / design 0002 §8: envelope, wrapped keys and blind index. Synthetic keys only.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import * as c from '../packages/crypto/src/envelope.js';

before(() => c.ready());
const key = () => new Uint8Array(randomBytes(32));
const K = '00000000-0000-7000-8000-0000000000b2';
const ROW = '00000000-0000-7000-8000-000000000001';
const aad = c.dataAad('demo', 'core.app_user.pii_email', ROW);

test('round trip, and the envelope names its key', () => {
  const k = key();
  const env = c.seal(k, K, Buffer.from('pessoa@example.org'), aad);
  assert.equal(env[0], 1);
  assert.equal(c.keyIdOf(env), K);
  assert.equal(c.open(k, env, aad).toString(), 'pessoa@example.org');
});
test('two encryptions of the same value differ (random nonce)', () => {
  const k = key();
  assert.notDeepEqual(c.seal(k, K, Buffer.from('x'), aad), c.seal(k, K, Buffer.from('x'), aad));
});
test('AAD binds row, column and instance', () => {
  const k = key(); const env = c.seal(k, K, Buffer.from('x'), aad);
  for (const other of [
    c.dataAad('demo', 'core.app_user.pii_email', '00000000-0000-7000-8000-000000000002'),
    c.dataAad('demo', 'core.app_user.pii_name', ROW),
    c.dataAad('outro', 'core.app_user.pii_email', ROW),
  ]) assert.throws(() => c.open(k, env, other), /cannot decrypt/);
});
test('altered bytes, wrong key and unknown version are refused', () => {
  const k = key(); const env = c.seal(k, K, Buffer.from('x'), aad);
  const flipped = Buffer.from(env); flipped[flipped.length - 1] ^= 1;
  assert.throws(() => c.open(k, flipped, aad), /cannot decrypt/);
  assert.throws(() => c.open(key(), env, aad), /cannot decrypt/);
  const v2 = Buffer.from(env); v2[0] = 2;
  assert.throws(() => c.open(k, v2, aad), /unknown envelope/);
});
test('a wrapped DEK presented under another purpose or id does not unwrap', () => {
  const kek = key(); const dek = key(); const KEK = '00000000-0000-7000-8000-0000000000ff';
  const w = c.wrapDek(kek, KEK, dek, 'demo', 'core.app_user.pii_email', K);
  assert.deepEqual(new Uint8Array(c.unwrapDek(kek, w, 'demo', 'core.app_user.pii_email', K)), dek);
  assert.throws(() => c.unwrapDek(kek, w, 'demo', 'core.app_user.pii_name', K), /cannot decrypt/);
  assert.throws(() => c.unwrapDek(kek, w, 'demo', 'core.app_user.pii_email', '00000000-0000-7000-8000-0000000000b3'), /cannot decrypt/);
});
test('blind index: version byte, normalization, key-dependent', () => {
  const k = key();
  const a = c.emailIndex(k, 1, ' Pessoa@Example.org ');
  assert.equal(a.length, 33); assert.equal(a[0], 1);
  assert.deepEqual(a, c.emailIndex(k, 1, 'pessoa@example.org'));
  assert.notDeepEqual(a, c.emailIndex(key(), 1, 'pessoa@example.org'));
});
test('KEK loading refuses a missing or short key', () => {
  const id = '00000000-0000-7000-8000-0000000000ff';
  assert.throws(() => c.loadKek(id, {}), /not loaded/);
  assert.throws(() => c.loadKek(id, { MANDATO_KEK_00000000_0000_7000_8000_0000000000ff: Buffer.alloc(16).toString('base64') }), /32 bytes/);
  assert.equal(c.loadKek(id, { MANDATO_KEK_00000000_0000_7000_8000_0000000000ff: Buffer.alloc(32, 7).toString('base64') }).length, 32);
});
