# Design 0003 — Connector kit, runner and raw/normalized layers (E3.1)

Status: **Draft (v1)** · 2026-11-24 · Builds on design 0001 (contract 0.1.1) and 0002. Owner: architecture backbone.

## 1. Problem

Design 0001 §7.3 froze the `Connector` protocol and the `data_source` / `data_source_run` tables, but nothing runs a connector yet. E3.1 delivers the kit every public-data connector uses: a runner, a framework-owned HTTP client, a raw layer (every byte received, content-addressed), a helper for the normalized layer (idempotent upsert on the natural key), job completion, and a reusable contract test suite. The first real connectors (federal sources, the legislative radar) come in E3.2 and plug into this kit without touching it.

## 2. Constraints

- **Workers have no internet egress** (0001 §7.5). A connector still has to reach public APIs. The frozen contract does not say how; §3 closes that gap.
- Connectors handle public data only: a connector's `data_class` is C0 or C1. The loader refuses anything above C1 in P1. Connector jobs run in the `c1` pool as `worker_c1`.
- The runner owns the transaction, stores the cursor in `data_source.cursor`, writes `data_source_run`, and refuses records when `validate` reports errors (0001 §7.3).
- Every connector ships a `params` JSON schema with `additionalProperties: false`; the loader enforces it (residual carried from wave 1).
- `data_source_run.error` and job errors never carry record contents (0001 Appendix A).
- New dependencies: permissive licenses only (AGENTS.md rule 2). This rules out `psycopg` (LGPL-3.0). The worker database driver is **`pg8000`** (BSD-3-Clause), pinned to a release at least two weeks old.
- Cut rule: the kit is generic plumbing that every mandate system needs. Source-specific parsing for public sources is also framework (E3.2). Curation, scoring and prompts stay closed.

## 3. Egress: the fetch boundary

Contract change **0.1.2 (additive)**: `ConnectorManifest` gains `hosts: list[str]`, the exact HTTPS host names the connector may reach (no wildcards).

- Connectors never open sockets. They call `ctx.http().get(url, params=..., headers=...)`. Importing `requests`, `httpx`, `urllib.request`, `http.client` or `socket` in connector code fails the static check (`scripts/check_ai_boundary.py` gains a connector rule).
- The client applies one `FetchPolicy`, framework-owned:
  - `https` only, port 443, method `GET` only;
  - host must be in the **allowlist** = the union of `hosts` of the connectors enabled in `tenant.yaml`; a redirect is followed (max 3) only to an allowed host;
  - `robots.txt` of the host is fetched once per run and obeyed for the framework user agent `mandato-framework/<version>`;
  - per-source rate limit from `rate_limit_per_min` (token bucket, sleeps; never exceeds);
  - timeout 30 s per request, response body capped at 50 MiB (refused, not truncated);
  - `auth: api_key` sources: the client adds the header from `ctx.secret(auth_secret_ref)`; the connector never sees the key.
- **Deployment form (hard boundary):** in production the client is a thin stub that talks over a local socket to a **fetch sidecar** in the `c1` pool. The sidecar is the only process of that pool with internet egress, runs the same `FetchPolicy`, and holds the API keys. This mirrors the AI provider sidecars of §7.5. Packaging the sidecar and the network test (0001 test 9) belong to the deployment lane (E0.7/E7.x). E3.1 ships the policy and the in-process client used by tests and the demo; both forms share the policy code.

## 4. Raw layer

- The HTTP client records every response body it accepts in a **`RawStore`** before returning it: key = SHA-256 of the bytes (content-addressed, so the same file is stored once).
- Framework ships `FsRawStore` (directory on disk; dev, demo, tests). The object-storage implementation (Supabase Storage, private bucket) belongs to the deployment lane and implements the same two methods: `put(sha256, data) -> storage_key`, `get(storage_key) -> bytes`.
- Migration **`0004_core.sql`** adds `core.raw_object` (C1): `id uuid pk`, `run_id → data_source_run.id`, `source_id`, `url_host text`, `sha256 text`, `size int`, `content_type text`, `storage_key text`, `fetched_at timestamptz`, `created_at`, `updated_at`. Only the host is stored, not the full URL (query strings can carry parameters a source considers sensitive). `worker_c1` may insert and select; `api_rt` reads nothing.
- `RawBatch` gains `raw_refs: list[str]` (the SHA-256 values used to build it). Contract 0.1.2, additive. The runner checks that every ref it receives was recorded in this run.
- Retention: raw objects are kept; a prune command is out of scope (public C0 data, no LGPD retention duty).

## 5. Runner

`workers/core/connectors/runner.py` exposes the job `core.connector_run` (queue `core.connector_run`, class C1, concurrency 1, payload `{ "source_id": "<id>" }`, idempotency key `<source_id>:<scheduled minute>`).

1. **Load.** Find the connector by `source_id` in the `connectors` lists of the enabled modules' workers. Refuse an unknown id, a manifest whose `source_id` differs, `data_class > C1`, a missing or non-strict `params_schema`, or `params` that fail it.
2. **Open the run** (tx 1, lease-bound): ensure the `data_source` row (`source_id`, `name`, `terms_url` from the manifest, `cadence` from `tenant.yaml`), insert `data_source_run` `running`, read the cursor. Commit.
3. **Collect** (no transaction open): `discover`, then per resource `fetch(resource, cursor[resource.id])`, `normalize`, `validate`. The stored cursor is a map `resource_id → cursor`.
4. **Reject or apply.**
   - Any validation error → tx 2 marks the run `rejected` with `stats = {records, errors: <count>}` and `error = 'validation'`. No upsert, cursor unchanged. Error messages go to the worker log only (public data), never to the database.
   - Otherwise tx 2 (lease-bound, one transaction): `upsert(records, tx)`, insert the `raw_object` rows, write the new cursor map and `last_success_at`, mark the run `ok` with `stats = {records, inserted, updated, unchanged, raw_objects}`.
5. **Failure.** Any exception rolls back tx 2. A separate transaction marks the run `failed` with `error = <exception class name>` only. The cursor and normalized data stay as they were.
6. **Finish the job** through `core.finish_job(token, ok, error_code)` (§6).

The whole run is held in memory. That fits the P1 sources (largest expected: a daily DOU section, well under the 50 MiB cap); streaming is a later change if a source needs it.

## 6. Job completion

`0004_core.sql` adds `core.finish_job(p_token text, p_ok boolean, p_error text) returns text` (definer, `worker_c1/c2/c3`):

- finds the job by `lease_hash = sha256(token)` and `state = 'running'`, and requires the caller's pool to match the job class (`audit.pool_classes`);
- `ok` → `done`; not ok → `queued` with `run_after = now() + 2^attempts minutes` (max 6 h), or `dead` when `attempts >= max_attempts`;
- `p_error` must match `^[A-Za-z][A-Za-z0-9_.]{0,80}$` (a code, never free text); clears `lease_hash`, `locked_by`, `locked_at`; returns the new state.

Scheduling (turning each connector's cron `schedule` into queued jobs) is **out of scope** here and belongs to E0.7, which runs the worker process; E3.1 tests enqueue jobs directly.

## 7. Normalized layer helper

`workers/core/connectors/upsert.py`: `upsert_rows(tx, table, records, natural_key) -> UpsertStats`.

- `table` is `schema.name`; schema, table and column names must match `^[a-z_][a-z0-9_]{0,62}$` and are quoted; values are bound parameters.
- One statement per batch of 500: `insert … on conflict (natural_key) do update set <cols> = excluded.<cols> where (<cols>) is distinct from (excluded.<cols>) returning (xmax = 0)`. Inserted = rows returning true, updated = rows returning false, unchanged = records − returned.
- The target table must have a unique constraint on exactly `natural_key`; the contract suite checks this.
- Module tables that connectors write are created by the module's migrations, owned by the module owner role, with `insert, update, select` granted to `worker_c1`.

## 8. Contract test suite

`workers/core/testing/connector_contract.py`: `ConnectorContract`, a `unittest.TestCase` mixin each connector's tests subclass with `connector`, `params` and `fixtures` (recorded responses keyed by URL, served by `FakeHttp`). It checks:

1. manifest: required fields, `source_id` pattern, `hosts` non-empty HTTPS host names, `1 ≤ rate_limit_per_min ≤ 600`, `data_class ≤ C1`, non-empty `natural_key`, `params_schema` strict and accepting `params`;
2. fetch reaches only `hosts` (`FakeHttp` refuses any other host) and every `RawBatch.raw_refs` entry was recorded;
3. `normalize` is deterministic (same raw → same records) and every record has all `natural_key` fields, non-null and unique within the batch;
4. `validate` reports no error on the fixtures and reports one for a record with a natural-key field removed;
5. with `TEST_DB` set: the target table has a unique constraint on `natural_key`, and upserting twice gives `unchanged == records` the second time.

## 9. Tests (definition of done; each written to fail first)

- Policy: refuses `http`, a non-allowlisted host, a redirect to one, `POST`, a body over the cap, a path disallowed by `robots.txt`; rate limit never exceeded (fake clock).
- Raw: identical bodies stored once; `raw_object` rows match bytes; a forged `raw_ref` makes the run fail.
- Runner against Postgres (run.sh): ok run writes stats, cursor and `last_success_at`; validation error → `rejected`, cursor and data unchanged; exception in `upsert` → `failed`, nothing partially written; a second run with the stored cursor is incremental; unknown source and `data_class C2` refused.
- `finish_job`: wrong pool refused; error text with spaces refused; backoff and `dead` after `max_attempts`; token unusable after finish.
- Contract suite run against a reference test connector (in `workers/core/tests/fixtures/`), and a negative connector that breaks each rule above.
- Static check: a connector importing `requests` or `socket` fails CI.

## 10. Out of scope

Fetch sidecar packaging and network test 9 (deployment lane); scheduler and worker main loop (E0.7); the object-storage `RawStore`; raw pruning; real connectors (E3.2). **Backbone note for E3.2:** the federal legislative radar needs Câmara dos Deputados and Senado open-data connectors (proposições, tramitação, votações), which are not in E3.2's current list (IBGE, Transferegov, DOU). Proposed addition, to be recorded in the mandato-pro backlog.
