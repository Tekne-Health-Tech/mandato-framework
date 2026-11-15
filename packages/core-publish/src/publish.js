// Publisher core (design 0001 §6.2–6.3): projection SQL, partitioning, bundle validation and the unsigned manifest.
import { createHash } from 'node:crypto';
import { canonicalize } from './manifest.js';

const NAME = /^[a-z_]+(\.[a-z_]+)?$/;

/** SQL that returns one JSON array with every record of a fixed projection, ordered by id. */
export function projectionSql(def) {
  if (!NAME.test(def.source)) throw new Error(`bad source ${def.source}`);
  const cols = Object.entries(def.fields).map(([name, f]) => {
    if (f.class !== 'C0') throw new Error(`${def.projection}.${name} is not C0`);
    if (!/^[a-z_]+$/.test(name)) throw new Error(`bad field name ${name}`);
    if (/\b(pii|phi|piim|enc)_/.test(f.expr)) throw new Error(`${def.projection}.${name} reads a C2+ column`);
    return `${f.expr} as "${name}"`;
  });
  const join = def.join ? ` join ${def.join}` : '';
  return `select coalesce(json_agg(r order by r.id), '[]') from (select ${cols.join(', ')} from ${def.source}${join} where ${def.where}) r`;
}

/** Month partitions for content and agenda, single partitions otherwise (§6.3). */
const PARTITION_FIELD = { content: 'published_at', agenda: 'starts_at' };

function monthIn(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(new Date(instant));
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

export function partition(projection, records, timeZone) {
  const field = PARTITION_FIELD[projection];
  const out = new Map();
  for (const r of records) {
    const name = field ? `${projection}-${monthIn(r[field], timeZone)}` : projection;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(r);
  }
  return out;
}

/**
 * Builds content-addressed bundles. `validate(projection, record)` must return true or throw; every record is
 * checked again here (§6.2). Returns [{ name, url, sha256, bytes, count, body }] sorted by name.
 */
export function buildBundles({ projections, records, timeZone, validate }) {
  const bundles = [];
  for (const def of projections) {
    const recs = records[def.projection] ?? [];
    for (const r of recs) validate(def.projection, r);
    for (const [name, part] of partition(def.projection, recs, timeZone)) {
      const body = `${canonicalize({ partition: name, projection: def.projection, projection_version: def.version, records: part })}\n`;
      const bytes = Buffer.byteLength(body, 'utf8');
      const sha256 = createHash('sha256').update(body, 'utf8').digest('hex');
      bundles.push({ name, url: `b/${sha256}.json`, sha256, bytes, count: part.length, body });
    }
  }
  return bundles.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function unsignedManifest({ instance, generation, minGeneration, minAppVersion, generatedAt, expiresAt, bundles, takedowns }) {
  if (new Date(expiresAt) - new Date(generatedAt) > 7 * 86400e3) throw new Error('expires_at more than 7 days after generated_at');
  return {
    schema_version: 1, instance, generation, min_generation: minGeneration, min_app_version: minAppVersion,
    generated_at: generatedAt, expires_at: expiresAt,
    bundles: bundles.map(({ name, url, sha256, bytes, count }) => ({ name, url, sha256, bytes, count })),
    takedowns,
  };
}
