# Wave 2 — response to the Codex code review of E3.1 and E0.7 (2026-11-24)

Reviews: `docs/designs/egm/0003/stage4-codex-code.md` (E3.1: 5 blockers, 4 should-fix) and
`docs/designs/egm/0004/stage4-codex-code.md` (E0.7: 10 blockers, 4 should-fix), both at 372917a.
Every finding was checked against the code first; all were real. Each fix has a test that fails without it (mutation
checked where noted).

## E3.1 (connector kit)

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Snapshot table shared with an incremental connector; runner never checks the registry | `check_registry` refuses any table a snapshot connector shares with any other connector; the runner calls it before every run | `test_connector_contract`: snapshot+incremental refused both orders; two incrementals allowed |
| 2 | Takedown claims the oldest `core.takedown` job, maybe another source's | Each invocation enqueues into a queue of its own (`core.td_<128-bit random>`) and verifies the claimed job id is its own | `test_runner_pg.test_takedown_claims_only_its_own_job` (pending jobs in `core.takedown` and another `core.td_*` stay queued; audit actor is the command's own job); mutation-checked |
| 3 | Robots checked on the path without query, truncated to 300 | Robots matches `path_qs`, untruncated (`url_path` storage keeps its own 300 cap) | `test_fetch_policy`: `Disallow: /busca?privado=1` refused via URL and via params; long path refused |
| 4 | `MANDATO_DEBUG=1` logs tracebacks | Removed; the runner logs type and code only | (code removed) |
| 5 | Snapshot keep keys compared as JSON text vs typed columns | `delete_missing` casts kept keys to the table's row type (`jsonb_populate_record`) and compares column by column | `test_runner_pg.test_snapshot_keeps_keys_stored_in_other_types` (numeric `1.0`/`2.50` + date composite key); mutation-checked |
| 6 | Connector-supplied issue code/path reach logs | `safe_issue`: code must match the code grammar, path the structural grammar `[A-Za-z0-9_.[\]]{1,120}`; otherwise `invalid_issue` / `?` | `test_connector_contract.test_issues_are_reduced_to_codes_and_structural_paths` |
| 7 | Secret failure while building the client escapes the runner | Client construction is inside the run's `try`; any failure there is `secret_unavailable`, through tx 3 | `test_runner_pg.test_missing_secret_fails_the_run_instead_of_escaping` |
| 8 | Socket timeout is per read, not a total deadline | `deadline()` shuts the socket down at `TIMEOUT_S` total (connect/TLS/request/body), in both the in-process and the sidecar transports | `test_fetch_policy.DeadlineTest` (server dripping one byte every 0.2 s is cut at 1 s) |
| 9 | Lease not rechecked after the rate-limit wait | `alive()` is checked again after `bucket.take()`, before resolve/send | `test_fetch_policy.test_lease_lost_during_the_rate_limit_wait_sends_nothing` |

## E0.7 (instance bootstrap and runtime)

| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | Scheduler watermark is the mutable `run_after` | Watermark is the minute in the newest `sched:` key (fixed-width UTC, immutable) | `test_runtime_pg.test_a_retried_job_does_not_hide_later_minutes`; mutation-checked |
| 2, 3 | Sidecar and scheduler import tenant module code | New data-only `runtime.json` (`registry.runtime_doc`), written by the registry probe (worker image, `--network none`, no secrets). `scheduler` and `fetch-c1` take `--runtime`, load it with `runtime/spec.py`, which re-validates every schedule (identity ↔ own queue, data class, cron, payload ≤ 4 KiB, connector schedule ↔ its own run) and every fetch manifest (hosts, rate, auth, secret ref grammar, extra fields dropped). Neither container mounts `/srv/tenant` | `test_runtime_unit.RuntimeSpecTest` (round trip, 6 forged schedules, 6 bad manifests, bad zone); `tests/instance.test.js`; network test: no tenant mount, `ls /srv/tenant` fails in `fetch-c1` |
| 4 | Sidecar checks the lease once | Each client's `alive()` re-runs `core.fetch_grant(lease)` and requires the same job before every request (after rate wait too); clients are keyed by the lease, so a re-claimed job starts afresh | `test_sidecar_egress.test_the_lease_is_checked_again_before_every_request` (lease ends mid-redirect: next hop never sent); mutation-checked |
| 5 | Concurrent sidecar requests race budgets | Per-job lock serializes a job's requests; `TokenBucket.take` is locked and re-checks the window after sleeping | `test_requests_of_one_job_run_one_at_a_time_within_its_budget` (mutation-checked); `test_rate_limit_holds_across_threads` |
| 6 | Heartbeat failure leaves the handler running | Heartbeat connects inside its error handling; a refused lease, or 3 failed beats in a row (reconnecting each time), marks it lost and the worker process exits at once (`os._exit(70)`); the open transaction rolls back, the job is reclaimed | `test_runtime_unit.HeartbeatTest` (refused, repeated failures, cannot connect, stopped) |
| 7 | Database mutated before identity is checked | Read-only preflight right after the database service starts and before roles, bootstrap, migrate or demo reset: an existing `core.instance` must have this slug and env | `tests/instance.test.js` (`preflightIdentity`) |
| 8 | Staging path and staging network shape absent | **Open, owner-dependent.** Blocked on Tekne's infrastructure accounts (L3, decided 24/11). Consequence stated in design 0004 §13: no connector is enabled outside local until the staging shape passes | — |
| 9 | Worker/tools images run by mutable tag | `up` resolves each image to its content id and the compose runs `image: sha256:…` | `tests/instance.test.js`; network test: worker-c1 runs the built image id |
| 10 | CI gates absent | Already added at bcf86fd (after the reviewed commit): jobs `images` and `network`, actions pinned by SHA (gate refuses unpinned actions and undigested workflow images). Now also job `supply-chain`: SBOM (syft, SPDX, uploaded) and grype `--only-fixed --fail-on high`, exceptions in `infra/images/vuln-exceptions.json` with ≤ 90-day expiry checked by `check_images.py` | `check_images.py` mutation: unpinned action and expired exception both fail |
| 11 | `core.instance.env` nullable | **Kept nullable, by design.** The demo seed and pre-0005 rows exist before `register`; making it NOT NULL breaks them. Enforced instead: RLS policies refuse a migrator insert/update without env, the trigger fixes env once set, preflight refuses a null-env database for staging, `check` fails unless env matches | `run.sh` (existing), `tests/instance.test.js` |
| 12 | `check` counts migrations only | `check` compares every recorded `module:id=sha256` with `expectedMigrations(tenant)`: none missing, none changed, none unknown | `instance up` demo: `ok migrations recorded and unchanged` |
| 13 | Postgres and tools not hardened | Both read-only with tmpfs, `cap_drop: [ALL]`, `no-new-privileges`; tools never root (image uid 10005 when the operator is root; pgpass chowned to it), mounts only `pgpass` instead of the state dir | `tests/instance.test.js` (every service); network test: every container read-only with `CapDrop [ALL]` (43/43) |
| 14 | Platform digests not validated | Each lock entry must list exactly linux/amd64 and linux/arm64, each a distinct sha256; `added` not in the future. Release dates stay reviewer-checked data (no registry access in CI by design) | `check_images.py` |

## Verification at the fix commit

`packages/db/test/run.sh` 208/208 · JS 108/108 · Python unit OK · network test 43/43 · `instance up --env local`
on the demo twice (second run: no demo reset, check green) · `check_ai_boundary` and `check_images` OK.
