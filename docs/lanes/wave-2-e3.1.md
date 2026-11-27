# Wave 2 · E3.1 — connector kit (executor: Claude, reviewer: Codex)

Design: `docs/designs/0003-connector-kit.md` (accepted v4 after three Codex rounds, `docs/designs/egm/0003/`).

## What was built

- `packages/db/migrations/0004_core.sql`: `core.raw_object`, `core.suppression` (forced RLS, C1, audited), `data_source_run.job_id`, `core.finish_job`, `core.heartbeat_job`, `core.reclaim_jobs`, takedown audit actions, source provisioning grant to `migrator`.
- `mandato migrate` provisions `core.data_source` from `tenant.yaml`; `mandato bootstrap` lets module tables carry the audit trigger.
- `workers/core/contracts/connector.py`: connector contract 0.2.0.
- `workers/core/fetch/`: fetch policy (per-source hosts, public addresses only with a pinned TLS connection, header allow-list, redirects re-checked, credential on the first hop only, RFC 9309 robots fail-closed, rate limit, body and run budgets) and the in-process client.
- `workers/core/connectors/`: loader checks, raw layer (`FsRawStore`, recorder, prune, orphan sweep, per-sha256 lock), upsert/delete helpers, runner (`core.connector_run`), takedown command.
- `workers/core/testing/connector_contract.py`: the contract suite connectors reuse; reference connector and table in the demo module (`mod_hello.exemplo_item`).
- CI: hashed worker dependencies, transitive license check, Python database tests mandatory in the database job.

## Versions chosen (rule: release at least 14 days old)

| Package | Version | Released | License |
| --- | --- | --- | --- |
| pg8000 | 1.31.6 | 2026-10-26 | BSD-3-Clause |
| scramp | 1.5.0 | 2026-10-25 | MIT-0 |
| asn1crypto | 1.5.1 | 2022-03-15 | MIT |
| python-dateutil | 4.0.0 | 2026-11-01 | BSD-3-Clause / Apache-2.0 |
| tzdata | 2026.6 | 2026-10-28 | Apache-2.0 |

## Tests

- `packages/db/test/run.sh`: 184/184 (job completion and recovery, raw and provisioning grants, connector runner suite, contract suite DB part).
- `workers/core/tests/test_runner_pg.py`: 15 tests (ok/incremental/snapshot, audit actor, refusals, rejected, failed, forged raw ref, size limits, busy source and cursor CAS, heartbeat, lost lease, orphaned run, raw dedup/prune/sweep, writer/deleter race, takedown and suppression, incremental removal).
- `workers/core/tests/test_fetch_policy.py`: 16 tests. `test_connector_contract.py`: 11 (suite fails on 7 broken connectors). `test_connector_boundary.py`: 2.
- `pnpm test` 97/97, `npx tsc -p .`, `scripts/check-boundaries.sh`, `scripts/check_ai_boundary.py`, `scripts/check_python_licenses.py`, grants matrix up to date.
- Mutation checks (guard removed → a test fails, then restored): cursor CAS, suppression filter, raw re-put under lock, public-address check, credential on first hop only, snapshot delete.

## Release gate (carried)

No instance enables connectors in production until the fetch sidecar is packaged and network test 9 passes (deployment lane).
