import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadTenantBuildConfig } from '../src/build-config.ts';

const root = new URL('../../../', import.meta.url).pathname;

test('release build refuses a missing publish base URL', () => {
  assert.throws(
    () => loadTenantBuildConfig(root, 'tenants/demo', { NODE_ENV: 'production' }),
    /MANDATO_PUBLISH_BASE_URL/,
  );
});

test('development build refuses a public HTTP publish base URL', () => {
  assert.throws(
    () => loadTenantBuildConfig(root, 'tenants/demo', {
      NODE_ENV: 'development',
      MANDATO_PUBLISH_BASE_URL: 'http://example.org/published',
    }),
    /https/,
  );
});

test('development build accepts localhost HTTP and release accepts HTTPS', () => {
  assert.equal(
    loadTenantBuildConfig(root, 'tenants/demo', { NODE_ENV: 'development' }).publishBaseUrl,
    'http://127.0.0.1:4173',
  );
  assert.equal(
    loadTenantBuildConfig(root, 'tenants/demo', {
      NODE_ENV: 'production',
      MANDATO_PUBLISH_BASE_URL: 'https://cdn.example.org/published',
    }).publishBaseUrl,
    'https://cdn.example.org/published',
  );
});
