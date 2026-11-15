// The committed demo publication (tenants/demo/published) verifies end to end, as a citizen app would see it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { evaluateManifest } from '../packages/core-publish/src/manifest.js';
import { projectionSql } from '../packages/core-publish/src/publish.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const json = (p) => JSON.parse(read(p));
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const manifest = json('tenants/demo/published/manifest.json');
const keyring = parseYaml(read('tenants/demo/tenant.yaml')).publish_keys.map(({ key_id, public_key }) => ({ key_id, public_key }));
const now = new Date('2026-11-16T12:00:00Z');
const bundle = (name) => JSON.parse(read(`tenants/demo/published/${manifest.bundles.find((b) => b.name === name).url}`));

test('manifest matches the schema and verifies with the tenant keyring', () => {
  const v = ajv.compile(json('packages/core-publish/schema/bundle.schema.json'));
  assert.ok(v(manifest), JSON.stringify(v.errors));
  const r = evaluateManifest(manifest, keyring, { generation: 0, minGenerationAtBuild: 0, appVersion: '1.0.0' }, now);
  assert.equal(r.accept, true, r.reason);
});

test('a tampered manifest is rejected', () => {
  const bad = structuredClone(manifest); bad.takedowns = [];
  assert.equal(evaluateManifest(bad, keyring, { generation: 0, appVersion: '1.0.0' }, now).reason, 'bad-signature');
});

test('every bundle matches its hash, size, count and projection schema', () => {
  for (const b of manifest.bundles) {
    const body = read(`tenants/demo/published/${b.url}`);
    assert.equal(createHash('sha256').update(body, 'utf8').digest('hex'), b.sha256, b.name);
    assert.equal(Buffer.byteLength(body, 'utf8'), b.bytes, b.name);
    const parsed = JSON.parse(body);
    assert.equal(parsed.records.length, b.count, b.name);
    const v = ajv.compile(json(`packages/core-publish/projections/${parsed.projection}.schema.json`));
    for (const r of parsed.records) assert.ok(v(r), `${b.name} ${r.id}: ${JSON.stringify(v.errors)}`);
  }
});

test('two month partitions, one takedown, one tombstone, nothing internal', () => {
  assert.deepEqual(manifest.bundles.map((b) => b.name), ['agenda-2026-11', 'causes', 'content-2026-11', 'municipalities']);
  assert.deepEqual(manifest.takedowns.map((t) => t.id), ['00000000-0000-7000-8000-00000000c005']);   // withdrawn
  const content = bundle('content-2026-11').records.map((r) => r.id);
  assert.deepEqual(content, ['00000000-0000-7000-8000-00000000c004']);                                // only "published"
  const agenda = bundle('agenda-2026-11').records.map((r) => r.id);
  assert.ok(!agenda.includes('00000000-0000-7000-8000-00000000e003'), 'internal event leaked');
  assert.ok(!agenda.includes('00000000-0000-7000-8000-00000000e004'), 'tombstoned event still published');
});

test('a projection with a non-C0 field cannot produce SQL', () => {
  assert.throws(() => projectionSql({ projection: 'x', source: 'core.app_user', where: 'true', fields: { id: { expr: 'pii_email', class: 'C2' } } }), /not C0/);
});

test('negative fixture: a projection that reads a pii_ column is refused even when labelled C0', () => {
  assert.throws(() => projectionSql(json('tests/fixtures/negative/projection-pii.json')), /C2\+ column/);
});
