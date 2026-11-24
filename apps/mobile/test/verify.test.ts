import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'yaml';

import { verifyManifest } from '../src/sync/verify.ts';

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
