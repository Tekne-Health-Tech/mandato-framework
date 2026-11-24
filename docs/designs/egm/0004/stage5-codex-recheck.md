# Wave 2 re-check (Codex, EGM stage 5): fixes for E3.1 and E0.7 — 2026-11-24

Reviewed at 0411466, `codex exec --sandbox read-only`, on VPS-Líbano. Verbatim except local links shortened to paths.

## E3.1

1. CLOSED
2. CLOSED
3. CLOSED
4. CLOSED
5. CLOSED
6. CLOSED
7. CLOSED
8. OPEN — Deadline resets between connection, TLS handshake, and HTTP exchange. DNS remains outside any deadline. Slow phases can consume 30 seconds each, or DNS can hang indefinitely, violating total request budget. `workers/core/fetch/client.py:74`
9. CLOSED

## E0.7

1. CLOSED
2. CLOSED
3. CLOSED
4. CLOSED
5. OPEN — Idle eviction removes client while its lock still has active or queued requests. After one hour, same valid lease receives new client, lock, and budget; requests then run concurrently and reset per-job limits. Reproduced: same lease produced distinct client, lock, and budget. `workers/core/fetch/sidecar.py:104`
6. OPEN — `hard_exit()` logs and calls `logging.shutdown()` before `os._exit()`. Backpressured or locked logging handler can block heartbeat thread indefinitely; handler continues running until job reclaim creates concurrent execution. `workers/core/runtime/worker.py:40`
7. CLOSED
8. OPEN — Owner-dependent staging work remains absent. Stated consequence is coherent: `up()` rejects every non-local environment, and design explicitly forbids connectors outside local until staging-equivalent test passes. `infra/bootstrap/instance.mjs:187`
9. CLOSED
10. CLOSED
11. CLOSED — Nullable storage does not leave identified enforcement defect: migrator RLS requires non-null `env`, trigger makes set value immutable, staging preflight rejects legacy null, and `check` requires exact environment.
12. CLOSED
13. CLOSED
14. OPEN — Gate validates digest syntax only. Arbitrary distinct amd64/arm64 digests unrelated to index digest pass; neither build nor checker verifies platform association. Pins remain decorative. `scripts/check_images.py:31`

## New blockers introduced by fix diff

1. `infra/bootstrap/instance.mjs:240` — Preflight SQL references `core.instance` and `env` inside `CASE`. PostgreSQL resolves relation and column before evaluating `to_regclass()`. Existing empty database fails with `relation "core.instance" does not exist`; pre-0005 database fails with missing `env`. Both abort before bootstrap and cannot be adopted.

Targeted pure tests: 14 passed; image and boundary checks passed. PostgreSQL/Docker integration not rerun; environment lacked dependencies, writable temp storage, and sockets.

VERDICT: REQUEST CHANGES — 5 open, 1 new blocker.
