import type { LocalSnapshot, SyncResult, SyncStore } from './sync';

export type SyncState = SyncResult | { status: 'idle' };
export interface StoreState { snapshot: LocalSnapshot; sync: SyncState }

export const emptySnapshot: LocalSnapshot = { generation: 0, bundles: {} };

export async function initializeStore(
  open: () => Promise<SyncStore>,
  sync: (store: SyncStore) => Promise<SyncResult>,
): Promise<StoreState> {
  let store: SyncStore;
  try {
    store = await open();
  } catch {
    return { snapshot: emptySnapshot, sync: { status: 'failed', reason: 'store-open' } };
  }

  let snapshot: LocalSnapshot;
  try {
    snapshot = await store.read();
  } catch {
    return { snapshot: emptySnapshot, sync: { status: 'failed', reason: 'store-read' } };
  }

  try {
    const result = await sync(store);
    return { snapshot: await store.read(), sync: result };
  } catch {
    return { snapshot, sync: { status: 'failed', reason: 'unexpected' } };
  }
}
