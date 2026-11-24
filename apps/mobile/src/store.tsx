import { createContext, type PropsWithChildren, useContext, useEffect, useState } from 'react';

import { openStore, syncStore } from './sync/sqlite';
import type { LocalSnapshot } from './sync';
import { recordsFor, tenant } from './tenant';

const empty: LocalSnapshot = { generation: 0, bundles: {} };
const StoreContext = createContext(empty);

export function StoreProvider({ children }: PropsWithChildren) {
  const [snapshot, setSnapshot] = useState(empty);
  useEffect(() => {
    let active = true;
    void openStore().then(async (store) => {
      if (active) setSnapshot(await store.read());
      await syncStore(tenant.publishBaseUrl, store);
      if (active) setSnapshot(await store.read());
    });
    return () => { active = false; };
  }, []);
  return <StoreContext.Provider value={snapshot}>{children}</StoreContext.Provider>;
}

export const useRecords = (projection: string) => recordsFor(useContext(StoreContext), projection);
