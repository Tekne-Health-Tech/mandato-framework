import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { syncPublished, type LocalSnapshot, type SyncStore } from '../src/sync/index.ts';

const published = new URL('../../../tenants/demo/published/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('manifest.json', published).pathname, 'utf8'));
const sha256 = async (body: string) => createHash('sha256').update(body).digest('hex');

class MemoryStore implements SyncStore {
  writes = 0;
  snapshot: LocalSnapshot;

  constructor(snapshot: LocalSnapshot = { generation: 0, bundles: {} }) {
    this.snapshot = snapshot;
  }

  async read(): Promise<LocalSnapshot> {
    return structuredClone(this.snapshot);
  }

  async replace(snapshot: LocalSnapshot): Promise<void> {
    this.writes += 1;
    this.snapshot = structuredClone(snapshot);
  }
}

const response = (body: string, status = 200, headers?: Record<string, string>) =>
  new Response(status === 304 ? null : body, { status, headers });

const demoFetch: typeof fetch = async (input) => {
  const path = String(input).replace('https://demo.invalid/', '');
  return response(await readFile(new URL(path, published).pathname, 'utf8'), 200, path === 'manifest.json' ? { etag: '"demo-1"' } : undefined);
};

test('accepts the demo manifest and stores its bundles', async () => {
  const store = new MemoryStore();
  assert.deepEqual(await syncPublished({ baseUrl: 'https://demo.invalid', fetch: demoFetch, store, sha256, verify: () => true }), { status: 'updated' });
  assert.equal(store.snapshot.generation, manifest.generation);
  assert.deepEqual(Object.keys(store.snapshot.bundles).sort(), manifest.bundles.map((bundle: { name: string }) => bundle.name).sort());
  assert.equal(store.snapshot.bundles['content-2026-11'].records[0].title, 'Visita à unidade de saúde de Vila Exemplo');
});

test('refuses a bundle with the wrong sha256 and keeps previous data', async () => {
  const old = { generation: 1, etag: '"old"', bundles: { causes: { sha256: 'old', projection: 'causes', records: [{ id: 'old', updated_at: '2026-01-01T00:00:00Z', name: 'Anterior' }] } } } satisfies LocalSnapshot;
  const store = new MemoryStore(old);
  const bad = structuredClone(manifest);
  bad.bundles[0].sha256 = '0'.repeat(64);
  const fetcher: typeof fetch = async (input) => String(input).endsWith('manifest.json') ? response(JSON.stringify(bad)) : demoFetch(input);
  assert.deepEqual(await syncPublished({ baseUrl: 'https://demo.invalid', fetch: fetcher, store, sha256, verify: () => true }), { status: 'failed' });
  assert.deepEqual(store.snapshot, old);
  assert.equal(store.writes, 0);
});

test('a 304 response does nothing', async () => {
  const old = { generation: 1, etag: '"demo-1"', bundles: {} } satisfies LocalSnapshot;
  const store = new MemoryStore(old);
  let requestHeaders: Headers | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    requestHeaders = new Headers(init?.headers);
    return response('', 304);
  };
  assert.deepEqual(await syncPublished({ baseUrl: 'https://demo.invalid', fetch: fetcher, store, sha256, verify: () => true }), { status: 'not-modified' });
  assert.equal(requestHeaders?.get('if-none-match'), '"demo-1"');
  assert.deepEqual(store.snapshot, old);
  assert.equal(store.writes, 0);
});

test('a takedown removes the matching record', async () => {
  const bundle = manifest.bundles.find((entry: { name: string }) => entry.name === 'content-2026-11');
  const withdrawn = manifest.takedowns[0].id;
  const store = new MemoryStore({
    generation: 0,
    bundles: {
      [bundle.name]: {
        sha256: bundle.sha256,
        projection: 'content',
        records: [
          { id: withdrawn, updated_at: '2026-11-01T00:00:00Z', title: 'Retirado' },
          { id: 'kept', updated_at: '2026-11-01T00:00:00Z', title: 'Mantido' },
        ],
      },
    },
  });
  const onlyContent = { ...manifest, bundles: [bundle] };
  const fetcher: typeof fetch = async () => response(JSON.stringify(onlyContent), 200, { etag: '"demo-1"' });
  assert.deepEqual(await syncPublished({ baseUrl: 'https://demo.invalid', fetch: fetcher, store, sha256, verify: () => true }), { status: 'updated' });
  assert.deepEqual(store.snapshot.bundles[bundle.name].records.map((record) => record.id), ['kept']);
});

test('a failed fetch keeps old data', async () => {
  const old = { generation: 1, bundles: { causes: { sha256: 'old', projection: 'causes', records: [{ id: 'old', updated_at: '2026-01-01T00:00:00Z' }] } } } satisfies LocalSnapshot;
  const store = new MemoryStore(old);
  const fetcher: typeof fetch = async () => { throw new Error('offline'); };
  assert.deepEqual(await syncPublished({ baseUrl: 'https://demo.invalid', fetch: fetcher, store, sha256, verify: () => true }), { status: 'failed' });
  assert.deepEqual(store.snapshot, old);
  assert.equal(store.writes, 0);
});

test('a changed full snapshot removes tombstoned records', async () => {
  const records = [{ id: 'kept', updated_at: '2026-11-02T00:00:00Z', title: 'Mantido' }];
  const body = JSON.stringify({ partition: 'content-2026-11', projection: 'content', projection_version: 1, records });
  const hash = await sha256(body);
  const nextManifest = { ...manifest, bundles: [{ name: 'content-2026-11', url: `b/${hash}.json`, sha256: hash, bytes: body.length, count: 1 }], takedowns: [] };
  const store = new MemoryStore({ generation: 0, bundles: { 'content-2026-11': { sha256: 'old', projection: 'content', records: [...records, { id: 'gone', updated_at: '2026-11-01T00:00:00Z' }] } } });
  const fetcher: typeof fetch = async (input) => response(String(input).endsWith('manifest.json') ? JSON.stringify(nextManifest) : body);
  await syncPublished({ baseUrl: 'https://demo.invalid', fetch: fetcher, store, sha256, verify: () => true });
  assert.deepEqual(store.snapshot.bundles['content-2026-11'].records.map((record) => record.id), ['kept']);
});
