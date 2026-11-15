# Stage 6 implementation tests: where each one lives

The stopping rule (design 0001 §11) turned the leftover items of the last cross-provider review into executable tests. This table maps each of the nine to the test that runs it, or to the lane that must add it when the code under test exists. E0.0 freezes contracts; it does not implement key management or the deployment network, so tests 4, 5, the concurrency half of 6, and 9 cannot run yet.

| # | Test (stage 6) | Status | Where |
| --- | --- | --- | --- |
| 1 | Audit actor derived for every runtime login; `db_role` is the `session_user`, never a definer | runs | `packages/db/test/run.sh` sections "audit", "worker leases", "audit actor for every runtime login" (`api_rt`, `worker_c1`, `worker_c2`, `worker_c3`, `migrator`) |
| 2 | A lease bound and committed is not inherited by the next transaction on the same backend | runs | `run.sh` "lease is not inherited by the next transaction" |
| 3 | Generated grant matrix, diffed in CI; cross-pool reads for C1, C2, C3 | runs | `packages/db/test/grants.sh` vs `packages/db/grants.md` (CI diff); `run.sh` "worker_c1 cannot read any C2/C3 column", "worker_c2 cannot read any C3 column", "worker_c1 cannot read pii_email" |
| 4 | KEK rotation fault injection, recoverable offline copy | deferred | key-management lane (E1 crypto). No KEK code exists in E0.0; the test is a done criterion of that lane |
| 5 | DEK retirement waits for two zero-reference scans after the last old-key writer expires | deferred | same lane as 4 |
| 6 | Normalization vectors in TS and Python; dual write and uniqueness under concurrency | half runs | vectors: `tests/normalize.test.js`, `workers/core/tests/test_normalize.py` on `packages/crypto/vectors/normalize-v1.json`. Concurrency: lane that implements blind-index lookup |
| 7 | RFC 8785 / Ed25519 vectors; reject altered bytes, unknown or revoked keys, expiry, build floor | runs (publisher side) | `tests/manifest.test.js`; the end-to-end demo in `tests/demo-published.test.js`. The mobile lane must run `packages/core-publish/vectors/manifest-v1.json` in the app |
| 8 | Unsupported client applies authenticated takedowns before stopping | runs (reference algorithm) | `tests/manifest.test.js` "unsupported app still applies takedowns, then stops"; the mobile lane repeats it in the app |
| 9 | Worker pools cannot reach the internet or sidecars above their class; sidecars reach only their hosts | deferred | deployment lane (network policy). Needs the running topology |

A deferred test is part of that lane's definition of done, and the backbone checks it there.
