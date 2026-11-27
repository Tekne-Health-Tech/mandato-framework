// E0.7: generated compose and preflight (design 0004 §3, §8), without Docker.
// Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeFor, preflightIdentity, toolsUser } from '../infra/bootstrap/instance.mjs';

const ID = (c) => `sha256:${c.repeat(64)}`;
const doc = composeFor({ env: 'local', project: 'mandato-demo-local', database: 'mandato_demo_dev', pools: ['c1', 'c2'],
  secretRefs: [], tenantDir: '/srv/t', stateDir: '/srv/s', images: { worker: ID('a'), tools: ID('b') } });
const mounts = (svc) => (doc.services[svc].volumes ?? []).map((v) => (typeof v === 'string' ? v.split(':')[1] : v.target));

test('the scheduler and the fetch sidecar get data only, never tenant code', () => {
  for (const svc of ['scheduler', 'fetch-c1']) {
    assert.ok(!mounts(svc).includes('/srv/tenant'), svc);
    assert.ok(mounts(svc).includes('/srv/state/runtime.json'), svc);
    assert.ok(doc.services[svc].command.includes('--runtime'), svc);
    assert.ok(!doc.services[svc].command.includes('--tenant-root'), svc);
  }
  assert.ok(mounts('worker-c1').includes('/srv/tenant'), 'module code runs in workers only');
});

test('every service is read-only, drops all capabilities, never runs as root', () => {
  for (const [name, s] of Object.entries(doc.services)) {
    assert.equal(s.read_only, true, name);
    assert.deepEqual(s.cap_drop, ['ALL'], name);
    assert.ok(s.security_opt.includes('no-new-privileges:true'), name);
    assert.ok(s.user && !/^(0|root)(:|$)/.test(s.user), `${name} user ${s.user}`);
  }
  assert.ok(!/^0:/.test(toolsUser()));
});

test('mandato images run by content id, the base image by locked digest', () => {
  for (const [name, s] of Object.entries(doc.services)) {
    assert.match(s.image, /^sha256:[0-9a-f]{64}$|@sha256:[0-9a-f]{64}$/, name);
  }
});

test("secrets: tools mounts only pgpass, and no service sees another role's password", () => {
  assert.deepEqual(mounts('tools').filter((m) => m.startsWith('/run/secrets')), ['/run/secrets/pgpass']);
  for (const [name, s] of Object.entries(doc.services)) {
    const pg = (s.volumes ?? []).filter((v) => typeof v !== 'string' && v.target.startsWith('/run/secrets/pg_'));
    assert.ok(pg.length <= 1, name);
  }
});

test('preflight refuses a database of another instance or env before any write', () => {
  preflightIdentity('none', 'demo', 'local', 'd');
  preflightIdentity('empty', 'demo', 'local', 'd');
  preflightIdentity('demo|local', 'demo', 'local', 'd');
  preflightIdentity('demo|', 'demo', 'local', 'd');
  assert.throws(() => preflightIdentity('outro|local', 'demo', 'local', 'd'), /belongs to instance 'outro'/);
  assert.throws(() => preflightIdentity('demo|staging', 'demo', 'local', 'd'), /is a 'staging' instance/);
  assert.throws(() => preflightIdentity('demo|', 'demo', 'staging', 'd'), /predates the env column/);
});
