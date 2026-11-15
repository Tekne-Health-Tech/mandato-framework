import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalize, evaluateManifest, privateKeyFromSeed, publicKeyString, signManifest } from '../packages/core-publish/src/manifest.js';

const v = JSON.parse(readFileSync(new URL('../packages/core-publish/vectors/manifest-v1.json', import.meta.url), 'utf8'));
const keyring = [{ key_id: 'demo-test', public_key: v.public_key, role: 'current' }];
const state = { generation: 40, minGenerationAtBuild: 10, appVersion: '1.2.0' };
const now = new Date('2026-11-16T00:00:00-03:00');

test('RFC 8785 canonical form matches the vector', () => {
  const { sig, ...body } = v.signed;
  assert.equal(canonicalize(body), v.canonical);
});
test('valid manifest is accepted; takedowns come back first', () => {
  const r = evaluateManifest(v.signed, keyring, state, now);
  assert.equal(r.accept, true);
  assert.equal(r.takedowns.length, 1);
  assert.equal(r.stopAfterTakedowns, false);
});
test('altered bytes are rejected', () => {
  const m = structuredClone(v.signed); m.generation = 43;
  assert.equal(evaluateManifest(m, keyring, state, now).reason, 'bad-signature');
});
test('an unknown key is rejected', () => {
  assert.equal(evaluateManifest(v.signed, [{ key_id: 'other', public_key: v.public_key, role: 'current' }], state, now).reason, 'unknown-key');
});

// Independent of canonicalize(): expected bytes written by hand from RFC 8785 §3.2.3 (sorting by UTF-16 code
// units) and §3.2.2 (ECMAScript number and string serialization).
test('RFC 8785 independent vector: key order, numbers, escapes', () => {
  const input = { '\u20ac': 'Euro Sign', '\r': 'Carriage Return', '\ufb33': 'Hebrew Letter Dalet With Dagesh', '1': 'One',
    '\ud83d\ude00': 'Emoji: Grinning Face', '\u0080': 'Control', '\u00f6': 'Latin Small Letter O With Diaeresis' };
  assert.equal(canonicalize(input),
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
    '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}');
  assert.equal(canonicalize({ n: [0, -0, 1e21, 1e-7, 4.5, 333333333.3333333], s: 'a\u0000\n"\\/\u2028' }),
    '{"n":[0,0,1e+21,1e-7,4.5,333333333.3333333],"s":"a\\u0000\\n\\"\\\\/\u2028"}');
});

test('the shared manifest vector is valid against the manifest schema', () => {
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const validate = ajv.compile(JSON.parse(readFileSync(new URL('../packages/core-publish/schema/bundle.schema.json', import.meta.url), 'utf8')));
  assert.ok(validate(v.signed), JSON.stringify(validate.errors));
});

// Signed rotation (§6.3): a current key revokes itself and adds a next key; afterwards only the new key works.
const keyB = privateKeyFromSeed(createHash('sha256').update('mandato-demo-publish-key-B-TEST-ONLY').digest());
const keyA = privateKeyFromSeed(createHash('sha256').update('mandato-demo-publish-key-TEST-ONLY').digest());
const base = (() => { const { sig, ...b } = v.signed; return b; })();
test('a signed keyring_update revokes the old key and adds the next key', () => {
  const m1 = signManifest({ ...base, keyring_update: { revoke: ['demo-test'], add_next: { key_id: 'demo-b', public_key: publicKeyString(keyB) } } }, 'demo-test', keyA);
  const r1 = evaluateManifest(m1, keyring, state, now);
  assert.equal(r1.accept, true, r1.reason);
  assert.deepEqual(r1.keyring.map((k) => [k.key_id, k.role, !!k.revoked]), [['demo-test', 'current', true], ['demo-b', 'next', false]]);
  const m2 = signManifest({ ...base, generation: 43 }, 'demo-test', keyA);
  assert.equal(evaluateManifest(m2, r1.keyring, { ...state, generation: 42 }, now).reason, 'unknown-key');
  const m3 = signManifest({ ...base, generation: 43 }, 'demo-b', keyB);
  assert.equal(evaluateManifest(m3, r1.keyring, { ...state, generation: 42 }, now).accept, true);
});
test('a keyring_update signed by a next key is refused', () => {
  const ring = [...keyring, { key_id: 'demo-b', public_key: publicKeyString(keyB), role: 'next' }];
  const m = signManifest({ ...base, keyring_update: { revoke: ['demo-test'] } }, 'demo-b', keyB);
  assert.equal(evaluateManifest(m, ring, state, now).reason, 'keyring-update-not-signed-by-current');
});
test('revocation is final: a later update cannot re-add a revoked key id', () => {
  const ring = [{ ...keyring[0], revoked: true }, { key_id: 'demo-b', public_key: publicKeyString(keyB), role: 'current' }];
  const m = signManifest({ ...base, keyring_update: { add_next: { key_id: 'demo-test', public_key: v.public_key } } }, 'demo-b', keyB);
  const r = evaluateManifest(m, ring, state, now);
  assert.equal(r.keyring.find((k) => k.key_id === 'demo-test').revoked, true);
});
test('expired manifest is rejected', () =>
  assert.equal(evaluateManifest(v.signed, keyring, state, new Date('2026-12-01T00:00:00Z')).reason, 'expired'));
test('lower generation than stored is rejected (rollback)', () =>
  assert.equal(evaluateManifest(v.signed, keyring, { ...state, generation: 50 }, now).reason, 'rollback'));
test('fresh install rejects generations below the build floor', () =>
  assert.equal(evaluateManifest(v.signed, keyring, { generation: 0, minGenerationAtBuild: 45, appVersion: '1.2.0' }, now).reason, 'rollback'));
test('unsupported app still applies takedowns, then stops', () => {
  const r = evaluateManifest(v.signed, keyring, { ...state, appVersion: '0.9.0' }, now);
  assert.equal(r.accept, true); assert.equal(r.stopAfterTakedowns, true); assert.equal(r.takedowns.length, 1);
});
test('device older than min_generation drops all partitions', () =>
  assert.equal(evaluateManifest(v.signed, keyring, { ...state, generation: 20 }, now).dropAll, true));
test('signing is deterministic for the test key', () => {
  const key = privateKeyFromSeed(createHash('sha256').update('mandato-demo-publish-key-TEST-ONLY').digest());
  const { sig, ...body } = v.signed;
  assert.deepEqual(signManifest(body, 'demo-test', key), v.signed);
});
