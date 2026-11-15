import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalize, evaluateManifest, privateKeyFromSeed, signManifest } from '../packages/core-publish/src/manifest.js';

const v = JSON.parse(readFileSync(new URL('../packages/core-publish/vectors/manifest-v1.json', import.meta.url), 'utf8'));
const keyring = [{ key_id: 'demo-test', public_key: v.public_key }];
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
test('unknown and revoked keys are rejected', () => {
  assert.equal(evaluateManifest(v.signed, [{ key_id: 'other', public_key: v.public_key }], state, now).reason, 'unknown-key');
  assert.equal(evaluateManifest(v.signed, [{ ...keyring[0], revoked: true }], state, now).reason, 'unknown-key');
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
