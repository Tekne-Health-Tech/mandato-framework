import type { ConfigContext, ExpoConfig } from 'expo/config';
import { resolve } from 'node:path';

import { loadTenantBuildConfig } from './src/build-config.ts';

const repoRoot = resolve(__dirname, '../..');

export default ({ config }: ConfigContext): ExpoConfig => {
  const tenant = loadTenantBuildConfig(repoRoot, process.env.MANDATO_TENANT ?? 'tenants/demo', process.env);
  return {
    ...config,
    name: tenant.name,
    slug: tenant.slug,
    version: '1.0.0',
    scheme: `mandato-${tenant.slug}`,
    orientation: 'portrait',
    userInterfaceStyle: 'automatic',
    plugins: ['expo-router', 'expo-sqlite'],
    web: { bundler: 'metro', output: 'static' },
    extra: { tenant },
  };
};
