import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { toNative } from '../../../packages/core-theme/src/native.js';
import { loadTenantBuildConfig } from '../src/build-config.ts';

test('generated React Native theme equals core-theme native output', async () => {
  const root = new URL('../../../', import.meta.url);
  const tokens = JSON.parse(await readFile(new URL('tenants/demo/theme/tokens.json', root).pathname, 'utf8'));
  const config = loadTenantBuildConfig(new URL(root).pathname, 'tenants/demo', { NODE_ENV: 'development' });
  assert.deepEqual(config.theme, toNative(tokens));
});
