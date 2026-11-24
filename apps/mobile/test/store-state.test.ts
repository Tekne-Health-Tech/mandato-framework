import assert from 'node:assert/strict';
import { test } from 'node:test';

import { initializeStore } from '../src/store-state.ts';
import { strings } from '../src/strings.pt-BR.ts';

test('openStore failure becomes a typed error state', async () => {
  const result = await initializeStore(
    async () => { throw new Error('sqlite unavailable'); },
    async () => ({ status: 'updated' }),
  );
  assert.deepEqual(result, {
    snapshot: { generation: 0, bundles: {} },
    sync: { status: 'failed', reason: 'store-open' },
  });
});

test('update-required state reaches the UI with a pt-BR message', async () => {
  const snapshot = { generation: 1, bundles: {} };
  const state = await initializeStore(
    async () => ({ read: async () => snapshot, replace: async () => undefined }),
    async () => ({ status: 'update-required' }),
  );
  assert.equal(state.sync.status, 'update-required');
  assert.equal(strings.updateRequired, 'Atualize o aplicativo para continuar recebendo conteúdo.');
});
