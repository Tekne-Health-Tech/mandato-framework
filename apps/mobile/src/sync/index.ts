export interface PublishedRecord {
  id: string;
  updated_at: string;
  [key: string]: unknown;
}

export interface LocalBundle {
  sha256: string;
  projection: string;
  records: PublishedRecord[];
}

export interface LocalSnapshot {
  etag?: string;
  generation: number;
  bundles: Record<string, LocalBundle>;
}

export interface SyncStore {
  read(): Promise<LocalSnapshot>;
  replace(snapshot: LocalSnapshot): Promise<void>;
}

interface ManifestBundle {
  name: string;
  url: string;
  sha256: string;
  count: number;
}

interface Manifest {
  generation: number;
  min_generation: number;
  bundles: ManifestBundle[];
  takedowns: Array<{ id: string }>;
  expires_at: string;
  sig: { key_id: string; alg: string; value: string };
}

interface BundleBody {
  projection: string;
  records: PublishedRecord[];
}

interface SyncOptions {
  baseUrl: string;
  fetch: typeof fetch;
  store: SyncStore;
  sha256(body: string): Promise<string>;
  verify(manifest: Manifest): boolean;
}

export type SyncResult = { status: 'updated' | 'not-modified' | 'failed' };

const url = (base: string, path: string) => `${base.replace(/\/$/, '')}/${path}`;

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Manifest>;
  return Number.isInteger(candidate.generation)
    && Number.isInteger(candidate.min_generation)
    && Array.isArray(candidate.bundles)
    && candidate.bundles.every((bundle) => typeof bundle.name === 'string' && typeof bundle.url === 'string' && /^[0-9a-f]{64}$/.test(bundle.sha256))
    && Array.isArray(candidate.takedowns)
    && typeof candidate.expires_at === 'string'
    && typeof candidate.sig?.key_id === 'string';
}

function isBundle(value: unknown, count: number): value is BundleBody {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BundleBody>;
  return typeof candidate.projection === 'string'
    && Array.isArray(candidate.records)
    && candidate.records.length === count
    && candidate.records.every((record) => typeof record?.id === 'string' && typeof record.updated_at === 'string');
}

export async function syncPublished({ baseUrl, fetch: fetcher, store, sha256, verify }: SyncOptions): Promise<SyncResult> {
  const current = await store.read();
  try {
    const headers = current.etag ? { 'If-None-Match': current.etag } : undefined;
    const manifestResponse = await fetcher(url(baseUrl, 'manifest.json'), { headers });
    if (manifestResponse.status === 304) return { status: 'not-modified' };
    if (!manifestResponse.ok) return { status: 'failed' };

    const parsed: unknown = JSON.parse(await manifestResponse.text());
    if (!isManifest(parsed) || !verify(parsed) || parsed.generation < current.generation) return { status: 'failed' };
    const source = current.generation < parsed.min_generation ? {} : current.bundles;
    const bundles: Record<string, LocalBundle> = {};

    for (const descriptor of parsed.bundles) {
      const cached = source[descriptor.name];
      if (cached?.sha256 === descriptor.sha256) {
        bundles[descriptor.name] = cached;
        continue;
      }
      const bundleResponse = await fetcher(url(baseUrl, descriptor.url));
      if (!bundleResponse.ok) return { status: 'failed' };
      const body = await bundleResponse.text();
      if (await sha256(body) !== descriptor.sha256) return { status: 'failed' };
      const bundle: unknown = JSON.parse(body);
      if (!isBundle(bundle, descriptor.count)) return { status: 'failed' };
      bundles[descriptor.name] = { sha256: descriptor.sha256, projection: bundle.projection, records: bundle.records };
    }

    const removed = new Set(parsed.takedowns.map(({ id }) => id));
    for (const bundle of Object.values(bundles)) bundle.records = bundle.records.filter(({ id }) => !removed.has(id));
    await store.replace({
      generation: parsed.generation,
      etag: manifestResponse.headers.get('etag') ?? current.etag,
      bundles,
    });
    return { status: 'updated' };
  } catch {
    return { status: 'failed' };
  }
}
