// E0.0 contract checks: schemas accept the demo fixtures and reject the negative ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { checkContrast } from '../packages/core-theme/src/contrast.js';

const json = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)));
const yaml = (p) => parseYaml(readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
const validator = (p) => ajv.compile(json(p));

const tenant = validator('packages/core-config/schema/tenant.schema.json');
const tokens = validator('packages/core-theme/schema/tokens.schema.json');
const moduleManifest = validator('packages/core-contracts/schema/module.schema.json');
const jobRequest = validator('packages/core-contracts/schema/job.schema.json');
validator('packages/core-publish/schema/bundle.schema.json');

const ok = (v, data) => assert.ok(v(data), JSON.stringify(v.errors, null, 2));

test('demo tenant.yaml is valid', () => ok(tenant, yaml('tenants/demo/tenant.yaml')));
test('demo theme is valid and passes contrast in both modes', () => {
  const t = json('tenants/demo/theme/tokens.json');
  ok(tokens, t);
  assert.deepEqual(checkContrast(t), []);
});
test('demo.hello manifest is valid', () => ok(moduleManifest, json('tenants/demo/modules/hello/mandato.module.json')));
test('a references-only job request is valid', () =>
  ok(jobRequest, { queue: 'hello.greet', data_class: 'C1', payload: { content_id: '0193a000-0000-7000-8000-000000000001' } }));

test('rejects tenant.yaml with an unknown key', () => assert.equal(tenant(yaml('tests/fixtures/negative/tenant-unknown-key.yaml')), false));
test('rejects an external AI provider cleared for C3', () => {
  const t = yaml('tenants/demo/tenant.yaml');
  t.ai.providers = [{ id: 'cloud', locality: 'external', max_data_class: 'C3', egress: ['api.example.com'] }];
  assert.equal(tenant(t), false);
});
test('rejects inline secrets in connector params', () => {
  const t = yaml('tenants/demo/tenant.yaml');
  t.connectors[0].params = { api_key: 'x' };
  assert.equal(tenant(t), false);
});
test('rejects a theme that fails contrast', () => assert.notDeepEqual(checkContrast(json('tests/fixtures/negative/tokens-low-contrast.json')), []));
test('rejects a C2 module without a data-subject hook', () =>
  assert.equal(moduleManifest(json('tests/fixtures/negative/module-c2-without-data-subject.json')), false));
test('rejects personal data in a job payload', () => assert.equal(jobRequest(json('tests/fixtures/negative/job-pii-payload.json')), false));

test('every projection field is C0 and matches its schema', () => {
  const dir = 'packages/core-publish/projections';
  const specs = readdirSync(new URL(`../${dir}`, import.meta.url)).filter((f) => f.endsWith('.json') && !f.endsWith('.schema.json'));
  assert.ok(specs.length >= 4);
  for (const f of specs) {
    const spec = json(`${dir}/${f}`);
    const schema = json(`${dir}/${f.replace('.json', '.schema.json')}`);
    for (const [field, def] of Object.entries(spec.fields)) {
      assert.equal(def.class, 'C0', `${f}: ${field}`);
      assert.doesNotMatch(def.expr, /\b(pii|phi|piim|enc|bi)_|author_id|approver_id/, `${f}: ${field}`);
    }
    assert.deepEqual(Object.keys(spec.fields).sort(), Object.keys(schema.properties).sort(), f);
    assert.ok(schema.required.includes('id') && schema.required.includes('updated_at'), f);
  }
});
