import * as Crypto from 'expo-crypto';
import { openDatabaseAsync } from 'expo-sqlite';

import { syncPublished, type LocalSnapshot, type SyncStore } from './index';
import { verifyManifest } from './verify';
import { tenant } from '../tenant';

const empty: LocalSnapshot = { generation: 0, bundles: {} };

export async function openStore(): Promise<SyncStore> {
  const database = await openDatabaseAsync('mandato.db');
  await database.execAsync('CREATE TABLE IF NOT EXISTS sync_state (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)');
  return {
    async read() {
      const row = await database.getFirstAsync<{ value: string }>('SELECT value FROM sync_state WHERE id = 1');
      return row ? JSON.parse(row.value) as LocalSnapshot : structuredClone(empty);
    },
    async replace(snapshot) {
      await database.withTransactionAsync(async () => {
        await database.runAsync(
          'INSERT INTO sync_state (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value',
          JSON.stringify(snapshot),
        );
      });
    },
  };
}

export const syncStore = (baseUrl: string, store: SyncStore) => syncPublished({
  baseUrl,
  fetch,
  store,
  sha256: (body) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, body),
  verify: (manifest) => verifyManifest(manifest, tenant.publishKeys),
  minGenerationAtBuild: tenant.minGenerationAtBuild,
});
