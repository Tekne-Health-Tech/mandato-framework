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
  min_app_version: string;
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
  minGenerationAtBuild: number;
  appVersion: string;
}

export type SyncFailureReason = 'network' | 'manifest-fetch' | 'manifest-invalid'
  | 'manifest-verification' | 'minimum-build-generation' | 'bundle-fetch'
  | 'bundle-hash' | 'bundle-invalid' | 'store-open' | 'store-read' | 'store-write'
  | 'unexpected';
export type SyncResult = { status: 'updated' | 'not-modified' | 'update-required' }
  | { status: 'failed'; reason: SyncFailureReason };

const url = (base: string, path: string) => `${base.replace(/\/$/, '')}/${path}`;

function isManifest(value: unknown): value is Manifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Manifest>;
  return Number.isInteger(candidate.generation)
    && Number.isInteger(candidate.min_generation)
    && typeof candidate.min_app_version === 'string'
    && /^\d+\.\d+\.\d+$/.test(candidate.min_app_version)
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

const versionAbove = (minimum: string, current: string) => {
  const [minimumMajor, minimumMinor, minimumPatch] = minimum.split('.').map(Number);
  const [currentMajor, currentMinor, currentPatch] = current.split('.').map(Number);
  return minimumMajor > currentMajor
    || (minimumMajor === currentMajor && minimumMinor > currentMinor)
    || (minimumMajor === currentMajor && minimumMinor === currentMinor && minimumPatch > currentPatch);
};

const failed = (reason: SyncFailureReason): SyncResult => ({ status: 'failed', reason });

export async function syncPublished({ baseUrl, fetch: fetcher, store, sha256, verify, minGenerationAtBuild, appVersion }: SyncOptions): Promise<SyncResult> {
  let current: LocalSnapshot;
  try {
    current = await store.read();
  } catch {
    return failed('store-read');
  }
  try {
    const headers = current.etag ? { 'If-None-Match': current.etag } : undefined;
    let manifestResponse: Response;
    try {
      manifestResponse = await fetcher(url(baseUrl, 'manifest.json'), { headers });
    } catch {
      return failed('network');
    }
    if (manifestResponse.status === 304) return { status: 'not-modified' };
    if (!manifestResponse.ok) return failed('manifest-fetch');

    let parsed: unknown;
    try {
      parsed = JSON.parse(await manifestResponse.text());
    } catch {
      return failed('manifest-invalid');
    }
    if (!isManifest(parsed)) return failed('manifest-invalid');
    if (!verify(parsed)) return failed('manifest-verification');
    if (parsed.generation < current.generation) return { status: 'not-modified' };
    if (parsed.generation < minGenerationAtBuild) return failed('minimum-build-generation');

    const removed = new Set(parsed.takedowns.map(({ id }) => id));
    const afterTakedowns = structuredClone(current);
    let takedownApplied = false;
    for (const bundle of Object.values(afterTakedowns.bundles)) {
      const records = bundle.records.filter(({ id }) => !removed.has(id));
      takedownApplied ||= records.length !== bundle.records.length;
      bundle.records = records;
    }
    if (takedownApplied) {
      try {
        await store.replace(afterTakedowns);
      } catch {
        return failed('store-write');
      }
    }

    if (versionAbove(parsed.min_app_version, appVersion)) return { status: 'update-required' };

    const source = current.generation < parsed.min_generation ? {} : afterTakedowns.bundles;
    const bundles: Record<string, LocalBundle> = {};

    for (const descriptor of parsed.bundles) {
      const cached = source[descriptor.name];
      if (cached?.sha256 === descriptor.sha256) {
        bundles[descriptor.name] = cached;
        continue;
      }
      let bundleResponse: Response;
      try {
        bundleResponse = await fetcher(url(baseUrl, descriptor.url));
      } catch {
        return failed('network');
      }
      if (!bundleResponse.ok) return failed('bundle-fetch');
      const body = await bundleResponse.text();
      if (await sha256(body) !== descriptor.sha256) return failed('bundle-hash');
      let bundle: unknown;
      try {
        bundle = JSON.parse(body);
      } catch {
        return failed('bundle-invalid');
      }
      if (!isBundle(bundle, descriptor.count)) return failed('bundle-invalid');
      bundles[descriptor.name] = { sha256: descriptor.sha256, projection: bundle.projection, records: bundle.records };
    }

    for (const bundle of Object.values(bundles)) bundle.records = bundle.records.filter(({ id }) => !removed.has(id));
    try {
      await store.replace({
        generation: parsed.generation,
        etag: manifestResponse.headers.get('etag') ?? current.etag,
        bundles,
      });
    } catch {
      return failed('store-write');
    }
    return { status: 'updated' };
  } catch {
    return failed('unexpected');
  }
}
