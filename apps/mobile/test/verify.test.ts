import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

import { verifyManifest } from '../src/sync/verify.ts';
import { privateKeyFromSeed, signManifest } from '../../../packages/core-publish/src/manifest.js';

const root = new URL('../../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('tenants/demo/published/manifest.json', root).pathname, 'utf8'));
const tenant = parse(await readFile(new URL('tenants/demo/tenant.yaml', root).pathname, 'utf8'));
const now = new Date('2026-11-16T12:00:00Z');

test('accepts the signed demo manifest', () => {
  assert.equal(verifyManifest(manifest, tenant.publish_keys, now), true);
});

test('rejects a manifest changed after signing', () => {
  const changed = structuredClone(manifest);
  changed.takedowns = [];
  assert.equal(verifyManifest(changed, tenant.publish_keys, now), false);
});

test('rejects an expired manifest', () => {
  const { sig: _sig, ...body } = manifest;
  const key = privateKeyFromSeed(createHash('sha256').update('mandato-demo-publish-key-TEST-ONLY').digest());
  const expired = signManifest({ ...body, expires_at: '2026-11-16T11:59:59Z' }, 'demo-test', key);
  assert.equal(verifyManifest(expired, tenant.publish_keys, now), false);
});

test('rejects an unknown key_id', () => {
  const unknown = structuredClone(manifest);
  unknown.sig.key_id = 'unknown';
  assert.equal(verifyManifest(unknown, tenant.publish_keys, now), false);
});

test('rejects an algorithm other than Ed25519', () => {
  const wrongAlgorithm = structuredClone(manifest);
  wrongAlgorithm.sig.alg = 'RS256';
  assert.equal(verifyManifest(wrongAlgorithm, tenant.publish_keys, now), false);
});
