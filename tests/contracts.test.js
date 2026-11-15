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

test('every projection field is declared C0 and matches its schema (column classes are proven in run.sh)', () => {
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

// Semantic checks (verification stage 7): keyring, module authority, provider locality, module settings.
import { checkModule, checkTenant } from '../packages/core-config/src/check.js';

test('demo tenant passes the semantic checks', () => assert.deepEqual(checkTenant(yaml('tenants/demo/tenant.yaml')), []));
test('rejects an ambiguous keyring', () => {
  const t = yaml('tenants/demo/tenant.yaml');
  t.publish_keys = [t.publish_keys[0], { ...t.publish_keys[0] }];
  assert.ok(checkTenant(t).length > 0);
  t.publish_keys = [t.publish_keys[0], { ...t.publish_keys[0], role: 'next' }];
  assert.ok(checkTenant(t).some((p) => p.startsWith('duplicate publish key id')));
});
test('rejects a module claiming framework roles or permissions', () => {
  const m = json('tests/fixtures/negative/module-authority-collision.json');
  assert.equal(moduleManifest(m), true);   // syntactically fine, which is why the semantic check exists
  assert.equal(checkModule(m).length, 2);
  assert.deepEqual(checkModule(json('tenants/demo/modules/hello/mandato.module.json')), []);
});
test('rejects a local provider with external egress', () => {
  const t = yaml('tenants/demo/tenant.yaml');
  t.ai.providers = [{ id: 'fake', locality: 'local', max_data_class: 'C3', egress: ['api.external.example'] }];
  assert.equal(tenant(t), false);
  t.ai.providers = [{ id: 'ollama', locality: 'local', max_data_class: 'C3', egress: ['ollama.internal:11434'] }];
  assert.equal(tenant(t), true, JSON.stringify(tenant.errors));
});
test('module settings in tenant.yaml match each local module settings_schema', () => {
  const t = yaml('tenants/demo/tenant.yaml');
  for (const m of t.modules.filter((x) => x.id.startsWith('demo.'))) {
    const dir = `tenants/demo/modules/${m.id.split('.')[1]}`;
    const manifest = json(`${dir}/mandato.module.json`);
    assert.equal(manifest.id, m.id);
    const v = ajv.compile(json(`${dir}/${manifest.settings_schema}`));
    assert.ok(v(m.settings ?? {}), `${m.id}: ${JSON.stringify(v.errors)}`);
  }
});
