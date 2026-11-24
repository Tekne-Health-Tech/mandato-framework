import { createContext, type PropsWithChildren, useContext, useEffect, useState } from 'react';

import { openStore, syncStore } from './sync/sqlite';
import { emptySnapshot, initializeStore, type StoreState } from './store-state';
import { recordsFor, tenant } from './tenant';

const StoreContext = createContext<StoreState>({ snapshot: emptySnapshot, sync: { status: 'idle' } });

export function StoreProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<StoreState>({ snapshot: emptySnapshot, sync: { status: 'idle' } });
  useEffect(() => {
    let active = true;
    void initializeStore(openStore, (store) => syncStore(tenant.publishBaseUrl, store))
      .then((next) => { if (active) setState(next); });
    return () => { active = false; };
  }, []);
  return <StoreContext.Provider value={state}>{children}</StoreContext.Provider>;
}

export const useRecords = (projection: string) => recordsFor(useContext(StoreContext).snapshot, projection);
export const useSyncState = () => useContext(StoreContext).sync;
