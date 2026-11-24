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

function publishBaseUrl(env: Environment): string {
  const value = env.MANDATO_PUBLISH_BASE_URL
    ?? (env.NODE_ENV === 'development' ? 'http://127.0.0.1:4173' : undefined);
  if (!value) throw new Error('MANDATO_PUBLISH_BASE_URL is required outside development');

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('MANDATO_PUBLISH_BASE_URL must be a valid https URL');
  }
  const localDevelopment = env.NODE_ENV === 'development'
    && parsed.protocol === 'http:'
    && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
  if (parsed.protocol !== 'https:' && !localDevelopment) {
    throw new Error('MANDATO_PUBLISH_BASE_URL must use https; development may use http only for localhost or 127.0.0.1');
  }
  return value;
}

export function loadTenantBuildConfig(repoRoot: string, tenantPath: string, env: Environment) {
  const variant = env.APP_VARIANT ?? 'citizen';
  if (variant === 'gabinete') throw new Error('not in E2.1');
  if (variant !== 'citizen') throw new Error(`APP_VARIANT must be citizen or gabinete, got ${variant}`);

  const tenantDirectory = isAbsolute(tenantPath) ? tenantPath : resolve(repoRoot, tenantPath);
  const tenant = parse(readFileSync(join(tenantDirectory, 'tenant.yaml'), 'utf8')) as TenantFile;
  const tokens = JSON.parse(readFileSync(join(tenantDirectory, tenant.theme), 'utf8'));
  const manifest: unknown = JSON.parse(readFileSync(join(tenantDirectory, 'published/manifest.json'), 'utf8'));
  const minGenerationAtBuild = (manifest as { generation?: unknown }).generation;
  if (!Number.isInteger(minGenerationAtBuild) || (minGenerationAtBuild as number) < 0) {
    throw new Error('published manifest generation must be a non-negative integer');
  }

  return {
    variant,
    name: tenant.instance.display_name,
    slug: tenant.instance.slug,
    causes: tenant.causes,
    enabledModules: tenant.modules.map(({ id }) => id),
    publishKeys: tenant.publish_keys,
    publishBaseUrl: publishBaseUrl(env),
    minGenerationAtBuild: minGenerationAtBuild as number,
    theme: toNative(tokens),
  };
}
