// Demo publisher. `sql <projection>` prints the projection query; `build <recordsDir> <outDir>` writes signed output.
// Signs with the TEST-ONLY key derived from a public seed (tenant.yaml `demo-test`). Never use it for a real instance.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parse as parseYaml } from 'yaml';
import { privateKeyFromSeed, signManifest } from '../packages/core-publish/src/manifest.js';
import { buildBundles, projectionSql, unsignedManifest } from '../packages/core-publish/src/publish.js';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const PROJECTIONS = ['content', 'agenda', 'causes', 'municipalities'];
const projection = (p) => JSON.parse(read(`packages/core-publish/projections/${p}.json`));

// Fixed so the committed fixture is reproducible; a real publisher uses the clock and a generation counter.
export const DEMO = {
  generation: 1, minGeneration: 0, minAppVersion: '1.0.0',
  generatedAt: '2026-11-15T12:00:00Z', expiresAt: '2026-11-22T12:00:00Z',
};

export const takedownsSql = `select coalesce(json_agg(json_build_object('kind','content','id',id,'at',updated_at) order by id), '[]')
  from core.content_item where state = 'withdrawn' and updated_at > timestamptz '${DEMO.generatedAt}' - interval '365 days'`;

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'sql') {
  process.stdout.write(a === 'takedowns' ? takedownsSql : projectionSql(projection(a)));
} else if (cmd === 'sql-unchecked') {
  // For the database classification check only: builds SQL from any projection file without the JS lint,
  // so the database itself must refuse a projection that reaches C2+ data.
  const def = JSON.parse(readFileSync(a, 'utf8'));
  const cols = Object.entries(def.fields).map(([n, f]) => `${f.expr} as "${n}"`).join(', ');
  process.stdout.write(`select ${cols} from ${def.source}${def.join ? ` join ${def.join}` : ''} where ${def.where}`);
} else if (cmd === 'build') {
  const tenant = parseYaml(read('tenants/demo/tenant.yaml'));
  const ajv = addFormats(new Ajv2020({ allErrors: true, strict: false }));
  const validators = Object.fromEntries(PROJECTIONS.map((p) => [p, ajv.compile(JSON.parse(read(`packages/core-publish/projections/${p}.schema.json`)))]));
  const validate = (p, r) => { if (!validators[p](r)) throw new Error(`${p} ${r.id}: ${JSON.stringify(validators[p].errors)}`); return true; };
  const records = Object.fromEntries(PROJECTIONS.map((p) => [p, JSON.parse(readFileSync(join(a, `${p}.json`), 'utf8'))]));
  const bundles = buildBundles({ projections: PROJECTIONS.map(projection), records, timeZone: tenant.timezone, validate });
  const takedowns = JSON.parse(readFileSync(join(a, 'takedowns.json'), 'utf8'));
  const seed = createHash('sha256').update('mandato-demo-publish-key-TEST-ONLY').digest();
  const manifest = signManifest(unsignedManifest({ instance: tenant.instance.slug, ...DEMO, bundles, takedowns }), 'demo-test', privateKeyFromSeed(seed));
  rmSync(join(b, 'b'), { recursive: true, force: true });
  mkdirSync(join(b, 'b'), { recursive: true });
  for (const bundle of bundles) writeFileSync(join(b, bundle.url), bundle.body);   // bundles first, manifest last
  writeFileSync(join(b, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${bundles.length} bundles, ${takedowns.length} takedowns -> ${b}`);
} else {
  console.error('usage: publish-demo.js sql <projection|takedowns> | build <recordsDir> <outDir>');
  process.exit(2);
}
