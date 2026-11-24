import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parse } from 'yaml';

import { toNative } from '../../../packages/core-theme/src/native.js';

type Environment = Record<string, string | undefined>;

interface TenantFile {
  instance: { slug: string; display_name: string };
  causes: Array<{ slug: string; name: string; icon: string }>;
  modules: Array<{ id: string }>;
  publish_keys: Array<{ key_id: string; public_key: string; role: 'current' | 'next' }>;
  theme: string;
}

export function loadTenantBuildConfig(repoRoot: string, tenantPath: string, env: Environment) {
  const variant = env.APP_VARIANT ?? 'citizen';
  if (variant === 'gabinete') throw new Error('not in E2.1');
  if (variant !== 'citizen') throw new Error(`APP_VARIANT must be citizen or gabinete, got ${variant}`);

  const tenantDirectory = isAbsolute(tenantPath) ? tenantPath : resolve(repoRoot, tenantPath);
  const tenant = parse(readFileSync(join(tenantDirectory, 'tenant.yaml'), 'utf8')) as TenantFile;
  const tokens = JSON.parse(readFileSync(join(tenantDirectory, tenant.theme), 'utf8'));

  return {
    variant,
    name: tenant.instance.display_name,
    slug: tenant.instance.slug,
    causes: tenant.causes,
    enabledModules: tenant.modules.map(({ id }) => id),
    publishKeys: tenant.publish_keys,
    publishBaseUrl: env.MANDATO_PUBLISH_BASE_URL ?? 'http://127.0.0.1:4173',
    theme: toNative(tokens),
  };
}
