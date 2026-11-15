// Regenerates manifest signature vectors. TEST-ONLY key derived from a public seed; never used by a real instance.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { canonicalize, privateKeyFromSeed, publicKeyString, signManifest } from '../src/manifest.js';

const seed = createHash('sha256').update('mandato-demo-publish-key-TEST-ONLY').digest();
const key = privateKeyFromSeed(seed);
const unsigned = {
  schema_version: 1, instance: 'demo', generation: 42, min_generation: 30, min_app_version: '1.0.0',
  generated_at: '2026-11-15T09:00:00-03:00', expires_at: '2026-11-22T09:00:00-03:00',
  bundles: [{ name: 'content-2026-11', url: `b/${'3'.repeat(64)}.json`, sha256: '3'.repeat(64), bytes: 1234, count: 2 }],
  takedowns: [{ kind: 'content', id: '00000000-0000-7000-8000-0000000000c9', at: '2026-11-10T09:00:00-03:00' }],
  note_unicode: 'Ação €  😀',
};
const signed = signManifest(unsigned, 'demo-test', key);
writeFileSync(new URL('./manifest-v1.json', import.meta.url), `${JSON.stringify({
  seed_note: "sha256('mandato-demo-publish-key-TEST-ONLY') — test only",
  public_key: publicKeyString(key),
  canonical: canonicalize(unsigned),
  signed,
}, null, 2)}\n`);
