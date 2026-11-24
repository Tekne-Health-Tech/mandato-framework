import Constants from 'expo-constants';

import type { LocalSnapshot } from './sync';

interface TenantRuntime {
  name: string;
  slug: string;
  variant: 'citizen';
  publishBaseUrl: string;
  enabledModules: string[];
  publishKeys: Array<{ key_id: string; public_key: string; role: 'current' | 'next' }>;
  causes: Array<{ slug: string; name: string; icon: string }>;
  theme: {
    light: { colors: Record<string, string> };
    dark: { colors: Record<string, string> };
    typography: { body: { family: string }; scale: number[] };
    radius: number[];
    spacing: number[];
  };
}

export const tenant = Constants.expoConfig?.extra?.tenant as TenantRuntime;

export const recordsFor = (snapshot: LocalSnapshot, projection: string) => Object.values(snapshot.bundles)
  .filter((bundle) => bundle.projection === projection)
  .flatMap((bundle) => bundle.records);
