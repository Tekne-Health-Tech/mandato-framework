# Design 0003 — Connector kit, runner and raw/normalized layers (E3.1)

Status: **Draft (v2)** · 2026-11-24 · Builds on design 0001 (contract 0.1.1) and 0002. Owner: architecture backbone. v2 answers the Codex review `egm/0003/stage1-codex.md`; §12 maps each finding.

## 1. Problem

Design 0001 §7.3 froze the `Connector` protocol and the `data_source` / `data_source_run` tables, but nothing runs a connector yet. E3.1 delivers the kit every public-data connector uses: a runner, a framework-owned HTTP client with an egress policy, a raw layer (every accepted response, content-addressed), a helper for the normalized layer, job completion and recovery, and a reusable contract test suite. The first real connectors (federal sources, the legislative radar) come in E3.2 and plug in without touching the kit.

## 2. Constraints

- **Workers have no internet egress** (0001 §7.5). §3 defines how a connector reaches a public API anyway.
- A connector's `data_class` is C0 or C1. The loader refuses anything above C1 in P1. Connector jobs run in the `c1` pool as `worker_c1`.
- Public sources can still contain personal data (a name in the DOU, a record published by mistake). Nothing in this design assumes "public means free of LGPD duties": raw data has a retention limit and a takedown path (§4).
- The runner owns the transactions, the cursor and `data_source_run`, and refuses records when validation fails (0001 §7.3).
- `data_source_run.error`, `job.last_error` and worker logs carry codes, never record contents (0001 Appendix A).
- Trust model as in 0001 §7.5: connector code is reviewed Tekne/framework code; the framework defends against mistakes in process and puts the hard boundary in the network (the fetch sidecar, §3.4).
- Dependencies: permissive licenses only, transitive ones included. `psycopg` is LGPL-3.0, so the worker driver is **`pg8000`** (BSD-3-Clause). Python dependencies are installed from `workers/requirements.txt` with exact versions and `--require-hashes` (§10).

## 3. Contract 0.2.0 (connector side) and the fetch boundary

### 3.1 Contract changes (all in `workers/core/contracts/connector.py`, recorded in 0001's change log as 0.2.0)

Nothing implements `Connector` yet (`demo.hello` lists none), so the change is made in one step:

```python
class ConnectorManifest(TypedDict):
    source_id: str; name: str; terms_url: str; robots: str
    auth: Literal["none", "api_key"]           # "oauth" removed: not supported in P1
    auth_secret_ref: str | None                # required iff auth == "api_key"
    auth_header: str | None                    # header name the key goes in, e.g. "X-Api-Key"
    hosts: list[str]                           # NEW: exact HTTPS host names this source may reach
    rate_limit_per_min: int; data_class: DataClass; natural_key: list[str]
    target_table: str                          # NEW: "<schema>.<table>" the records go to

class Response(TypedDict):                     # NEW
    status: int; headers: dict[str, str]; body: bytes; raw_ref: str  # raw_ref = sha256 hex of body

class Http(Protocol):                          # NEW
    def get(self, url: str, params: dict[str, str] | None = None,
            headers: dict[str, str] | None = None) -> Response: ...

class ConnectorContext(Protocol):              # NEW: what a connector receives, instead of JobContext
    source_id: str
    params: dict[str, Any]                     # tenant.yaml connectors[].params, already validated
    def http(self) -> Http: ...                # no secret(), no ai(), no tx(), no load_part()

class RawBatch(TypedDict):
    resource: Resource; fetched_at: datetime; items: list[Any]; cursor: dict[str, Any] | None
    raw_refs: list[str]                        # NEW: raw_ref of every Response used to build the batch

class Connector(Protocol):
    manifest: ConnectorManifest
    params_schema: dict[str, Any]              # NEW: JSON Schema, additionalProperties: false at every object level
    def discover(self, ctx: ConnectorContext) -> list[Resource]: ...
    def fetch(self, resource: Resource, cursor: dict[str, Any] | None, ctx: ConnectorContext) -> RawBatch: ...
    def normalize(self, raw: RawBatch) -> list[Record]: ...
    def validate(self, records: list[Record]) -> ValidationReport: ...
    # upsert removed from the protocol: the runner writes target_table with upsert_rows (§7)
```

`ValidationReport.errors` and `warnings` become `list[Issue]`, `Issue = {code: str, path: str}` (`code` matches `^[a-z][a-z0-9_]{0,40}$`; `path` is a field path such as `records[12].codigo_ibge`, never a value). `tenant.yaml` `connectors[]` gains `raw_retention_days` (integer 1–3650, default 180).

### 3.2 Fetch policy (framework-owned, shared by both deployment forms)

For each request the client applies, in order:

1. URL: scheme `https`, port 443 or none, no userinfo; method GET only.
2. Host: must be in **this source's** `manifest.hosts`. No union across sources.
3. Address: resolve the host; every resolved address must be public unicast. Refused: loopback, private (RFC 1918, RFC 4193), link-local, CGNAT `100.64/10`, multicast, unspecified, reserved, documentation ranges, IPv4-mapped IPv6 of any of these. The connection is made to the validated address with TLS SNI and `Host` set to the host name and normal certificate verification, so a DNS answer cannot change between check and connect.
4. Headers: the connector may set only `Accept`, `Accept-Language`, `If-None-Match`, `If-Modified-Since`. Any other header is refused. The client adds `User-Agent: mandato-framework/<version>` and, for `api_key` sources, `<auth_header>: <key>`.
5. Redirects: at most 3; each hop goes through steps 1–3 again. The credential header is sent only on the first request and never on a redirect.
6. `robots.txt` per host, fetched once per run through the same policy, counted against the rate limit, interpreted per RFC 9309: 2xx → obey; 4xx → allow all; 5xx, timeout or network error → refuse every path of that host for this run (fail closed). A robots redirect follows step 5.
7. Rate limit: token bucket at `rate_limit_per_min` per source; the client sleeps, never exceeds.
8. Limits: 30 s timeout per request; body over 50 MiB refused (not truncated).
9. Raw: an accepted response is recorded in the raw layer (§4) before `get` returns; its `raw_ref` is the SHA-256 of the body.

### 3.3 Secrets

The connector never receives a secret. `ConnectorContext` has no `secret()`. The client (in process) or the sidecar (deployment) resolves `auth_secret_ref` and injects the header per §3.2 step 4–5. The loader refuses a manifest with `auth: api_key` and no `auth_secret_ref`/`auth_header`, and any manifest with another `auth` value.

### 3.4 Deployment forms

- **In-process client** (`workers/core/connectors/http.py`): tests and the demo. It is the same policy code; it is not a security boundary against connector code, which shares the process.
- **Fetch sidecar** (production): a separate process in the `c1` pool, the only one with internet egress, holding the API keys, running the same policy; the worker's client is a stub that sends `(source_id, url, params, headers)` over a local socket. The worker containers have no route to the internet, so the in-process client cannot work there, by construction.
- **Release gate:** packaging the sidecar and network test 9 (a worker container cannot reach any internet host; the sidecar reaches only allowed hosts) belong to the deployment lane. No instance goes to production with connectors enabled until that test passes. E3.1 records this gate in `docs/lanes/` and in the production checklist.

## 4. Raw layer

- `RawStore` protocol: `put(sha256, data) -> storage_key`, `get(storage_key) -> bytes`, `delete(storage_key)`. Framework ships `FsRawStore` (dev, demo, tests). The object-storage store (private Supabase Storage bucket) belongs to the deployment lane.
- **Recording is immediate and independent of the run's outcome.** For each accepted response the client (1) writes the blob, then (2) inserts one `core.raw_object` row in its own short lease-bound transaction. A `rejected`, `failed` or killed run keeps every row it recorded.
- Crash between (1) and (2) leaves a blob with no row; never a row with no blob. Reconciliation: the prune step (below) deletes blobs older than 24 h that no row references.
- **Retention and takedown.**
  - After a successful run, the runner deletes this source's `raw_object` rows older than `raw_retention_days`, and their blobs when no other row references the same `sha256`. Deletes are audited by the row trigger.
  - `python -m workers.core.connectors.raw purge --sha256 <hex> --reason <code>` removes one object (rows and blob) at once, for a takedown or a record published by mistake. Audited, with the reason code in the audit details.
- Normalized records that came from a removed object stay until the next run of that source rewrites them; a takedown that must reach normalized data is handled by the module that owns the table (out of scope here).

## 5. Runner

`workers/core/connectors/runner.py` exposes the job `core.connector_run` (queue `core.connector_run`, class C1, payload `{ "source_id": "<id>" }`, idempotency key `<source_id>:<scheduled minute>`).

1. **Load** (before any write). Find the connector by `source_id` in the `connectors` lists of the enabled modules' workers. Refuse: unknown id; manifest `source_id` different; `data_class > C1`; `auth` invalid (§3.3); `hosts` empty or not host names; `target_table` not matching `^mod_[a-z][a-z0-9]{1,15}\.[a-z_][a-z0-9_]{0,62}$` or not in the connector's own module schema; `params_schema` not strict at every object level; `params` that fail it. Refusal → run not opened, job finished `dead` with the code.
2. **Lock.** On a dedicated connection the runner takes `pg_try_advisory_lock(hashtext('core.connector_run'), hashtext(source_id))` for the whole run. Not acquired → job finished `done` with code `source_busy` (the next scheduled run picks it up). This avoids wasted work; correctness does not depend on it (step 5).
3. **Open the run** (tx 1, lease-bound): the `data_source` row must exist (§6.1), else `dead` with `source_not_provisioned`. Update `name`/`terms_url` from the manifest when they differ. Insert `data_source_run` `running`. Read the cursor map (`resource_id → cursor`) and remember it as `cursor_before`. Commit.
4. **Collect** (no long transaction): `discover`, then per resource `fetch`, `normalize`, `validate`. Between resources the runner calls `core.heartbeat_job(token)`. After collection the runner checks: every `raw_ref` in every batch was recorded in this run; the whole record set (all resources) has a uniform key set that includes `natural_key`, no null natural-key field, no duplicate natural key; every column exists in `target_table` (read from `information_schema` once). A failure here is a validation failure with code `shape`, `natural_key_null`, `natural_key_duplicate` or `unknown_column`.
5. **Reject or apply** (tx 2, lease-bound, one transaction):
   - Validation failed → run `rejected` with `stats = {records, errors: <count>, codes: {<code>: <count>}}`, `error = 'validation'`; cursor and data unchanged; `core.finish_job(token, false, 'validation')` in the same transaction. Logs carry at most 20 `Issue`s (code and path), never values.
   - Otherwise: `upsert_rows(tx, target_table, records, natural_key)`; `update core.data_source set cursor = $new, last_success_at = now() where source_id = $1 and cursor is not distinct from $cursor_before` — 0 rows updated → raise `CursorConflict` (another run advanced it); prune (§4); run `ok` with `stats = {records, inserted, updated, unchanged, raw_objects}`; `core.finish_job(token, true, null)` in the same transaction.
6. **Failure.** Any exception rolls back tx 2. Tx 3 marks the run `failed` with `error = <code>` (`cursor_conflict`, `fetch_refused`, `fetch_failed`, `robots_disallowed`, or `internal` for anything else) and calls `finish_job(token, false, <code>)`. The full exception goes to the worker log with record values stripped (only type, code and the framework frame).
7. **Release** the advisory lock and close the dedicated connection.

The whole run is held in memory, bounded by the 50 MiB per response cap; streaming is a later change if a source needs it.

## 6. Database changes (`0004_core.sql`, applied by bootstrap)

### 6.1 Provisioning `data_source`

`mandato migrate` (as `migrator`) inserts a `core.data_source` row for each `connectors[]` entry of `tenant.yaml` that has none: `source_id`, `cadence = schedule`, `name = source_id`, `terms_url = ''`. The runner fills `name` and `terms_url` from the manifest on the first run (column update, already granted to `worker_c1`). `0004` grants `insert (source_id, name, terms_url, cadence)` on `core.data_source` to `migrator`, with a policy for that insert. `worker_c1` gets no new grant on `data_source`. Removing a connector from `tenant.yaml` leaves the row and its runs (history); nothing schedules it.

### 6.2 `core.raw_object` (C1)

| Column | Type | Null | Class | Notes |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | N | C1 | PK, `core.uuid7()` |
| `run_id` | `uuid` | N | C1 | FK `data_source_run.id` |
| `source_id` | `text` | N | C1 | FK `data_source.source_id` |
| `url_host` | `text` | N | C1 | |
| `url_path` | `text` | N | C1 | path only, no query or fragment, max 300 chars |
| `sha256` | `text` | N | C1 | `^[0-9a-f]{64}$`, indexed |
| `size` | `int` | N | C1 | `0 ≤ size ≤ 52428800` |
| `content_type` | `text` | Y | C1 | max 200 chars |
| `storage_key` | `text` | N | C1 | |
| `fetched_at` | `timestamptz` | N | C1 | |
| `created_at`, `updated_at` | `timestamptz` | N | C1 | `touch` trigger |

Owner `core_owner`; `enable` and `force row level security`; policies: `worker_c1` select, insert and delete (`using (true)`); no policy for any other runtime role, `api_rt` included. Grants: `worker_c1` select, insert, delete. Audit row trigger, column class comments and table class comment as for every core table (0001 §4.3–§4.5). `packages/db/grants.md` regenerated.

### 6.3 Job lifecycle

- `core.finish_job(p_token text, p_ok boolean, p_error text) returns text` (definer, granted to `worker_c1/c2/c3`): job by `lease_hash = sha256(token)` and `state = 'running'`; caller's pool must cover the job class (`audit.pool_classes(session_user)`); `p_error` null or matching `^[a-z][a-z0-9_]{0,40}$`. `ok` → `done`; not ok → `queued` with `run_after = now() + least(2^attempts minutes, 6 h)`, or `dead` when `attempts >= max_attempts`, or `dead` at once for the load-time codes of §5.1. Clears `lease_hash`, `locked_by`, `locked_at`; returns the new state.
- `core.heartbeat_job(p_token text) returns void` (same grants and checks): sets `locked_at = now()`.
- `core.reclaim_jobs(p_stale interval default '10 minutes') returns int` (definer, granted to `worker_c1/c2/c3`): every `running` job of the caller's pool classes with `locked_at < now() - p_stale` is requeued (or `dead` if out of attempts) with `last_error = 'lease_expired'` and its lease cleared; every `running` `data_source_run` whose job was reclaimed is marked `failed` / `lease_expired`. To link them, `data_source_run` gains `job_id uuid null references core.job(id)` in `0004`. Who calls `reclaim_jobs` periodically is the worker loop (E0.7); E3.1 ships and tests the function.

### 6.4 Module tables written by connectors

A module table named in `target_table` must: live in the module schema, be owned by the module owner role, have `enable` and `force row level security`, a policy and grants giving `worker_c1` exactly `select, insert, update`, the audit row trigger, column class comments, and a unique constraint on exactly `natural_key`. The DB part of the contract suite (§8) checks all of these; a module migration that misses one fails CI.

## 7. Normalized layer helper

`workers/core/connectors/upsert.py`: `upsert_rows(tx, table, records, natural_key) -> UpsertStats`.

- Preconditions, checked before the first statement (the runner already checked them in §5.4; the helper re-checks so it is safe on its own): non-empty list; identical key set across records; key set ⊇ `natural_key`; every identifier matches `^[a-z_][a-z0-9_]{0,62}$` and exists in `table`; natural key non-null and unique across the whole list.
- Statement per batch of 500: `insert … on conflict (<natural_key>) do update set <non-key cols> = excluded.<…> where (<non-key cols>) is distinct from (excluded.<…>) returning (xmax = 0)`. Inserted = rows returning true, updated = rows returning false, unchanged = records − rows returned. `xmax = 0` for "inserted" is an implementation detail of PostgreSQL; the framework supports PostgreSQL 15–17 (Supabase) and a test covers it with the audit trigger present.

## 8. Contract test suite

`workers/core/testing/connector_contract.py`: `ConnectorContract`, a `unittest.TestCase` mixin. A connector's test subclasses it with `connector`, `params` and `fixtures` (recorded responses keyed by URL, served by `FakeHttp`, which applies the same policy except DNS).

1. Manifest and `params_schema` per §5.1 (the same loader function, so the suite and the runner cannot drift).
2. Fetch reaches only `manifest.hosts`; no header outside §3.2 step 4; every `RawBatch.raw_refs` entry came from a recorded response.
3. `normalize` is deterministic; records satisfy §7's preconditions.
4. `validate` returns no `Issue` on the fixtures and one on a record with a natural-key field removed.
5. **Database part, mandatory in CI** (the `database` job runs it with `TEST_DB` set; it is not skippable there: a missing `TEST_DB` in that job fails): `target_table` meets every rule of §6.4; upserting the fixtures twice gives `unchanged == records` the second time.

## 9. Tests (definition of done; each written to fail first)

- **Policy:** refuses `http`, port 8443, userinfo, POST; a host of another source; a host resolving to 127.0.0.1, 10.0.0.1, 169.254.169.254, 100.64.0.1, `::1`, `fd00::1`, `::ffff:127.0.0.1`; a redirect to any of these; a forbidden header; a body over the cap. Robots: 404 → allowed; 503 → refused; disallowed path → refused. Credential header absent on a redirect. Rate limit never exceeded (fake clock).
- **Raw:** identical bodies stored once; rows recorded for `ok`, `rejected` and `failed` runs; a forged `raw_ref` fails the run; blob without row older than 24 h pruned; retention prune deletes old rows and unreferenced blobs only; purge removes rows and blob and is audited.
- **Runner (Postgres, run.sh):** ok run writes stats, cursor, `last_success_at`, job `done`, all in one commit; validation failure → `rejected`, cursor and data unchanged, job requeued; exception in the upsert → `failed`, nothing partially written; two concurrent runs of one source → one `source_busy` and, with the advisory lock bypassed, the CAS makes one `cursor_conflict` and the cursor never goes backwards; second run with the stored cursor is incremental; unknown source, `data_class C2`, `oauth`, non-strict `params_schema` refused before any write; unprovisioned source → `source_not_provisioned`.
- **Crash points:** kill after tx 1 → `reclaim_jobs` marks run `failed` / `lease_expired` and requeues the job; kill after tx 2 → nothing to recover (run and job terminal together).
- **Job functions:** `finish_job` and `heartbeat_job` refuse a wrong pool, a used token, an error with spaces; backoff and `dead` after `max_attempts`.
- **Contract suite** passes on a reference test connector (`workers/core/tests/fixtures/`) and fails on a negative connector for each rule of §8.
- **Static check:** a connector importing `requests`, `httpx`, `urllib.request`, `http.client` or `socket` fails `scripts/check_ai_boundary.py`.
- **Provisioning:** `mandato migrate` creates the missing `data_source` rows and leaves existing ones unchanged.

## 10. Dependencies and CI

- `workers/requirements.txt`: `pg8000` and its transitive dependencies (at the time of writing `scramp`, `asn1crypto`, `python-dateutil`, `six`; the exact set is whatever `pip` resolves for the pinned version), each `==<version> --hash=sha256:<…>`. Installed with `pip install --require-hashes -r workers/requirements.txt` in the `contracts` and `database` jobs.
- `scripts/check_python_licenses.py` reads the installed distributions' metadata and fails on any license outside the allow-list of `ci.yml`.
- Version selection follows the standing rule (exact pins, releases at least 14 days old at selection time). The rule applies when a version is chosen and is recorded with its release date in the lane doc; CI does not re-evaluate dates, so builds stay reproducible.

## 11. Out of scope

Fetch sidecar packaging and network test 9 (deployment lane; release gate in §3.4); scheduler and worker main loop (E0.7); the object-storage `RawStore`; takedown in module-owned normalized tables; real connectors (E3.2). **Backbone note for E3.2:** the federal legislative radar needs Câmara dos Deputados and Senado open-data connectors (proposições, tramitação, votações), which are not in E3.2's current list (IBGE, Transferegov, DOU). Proposed addition, to be recorded in the mandato-pro backlog.

## 12. Review findings (Codex, stage 1) and where they are answered

| # | Finding | Answer |
| --- | --- | --- |
| 1 | Contract changes incomplete | §3.1: full 0.2.0 contract (manifest, `Response`, `Http`, `ConnectorContext`, `RawBatch.raw_refs`, `params_schema`, `Issue`, `upsert` removed) |
| 2 | `data_source` cannot be created by `worker_c1` | §6.1: provisioned by `mandato migrate` as `migrator`; no new grant to `worker_c1` |
| 3 | SSRF, cross-source hosts | §3.2: per-source hosts, public-address check with pinned connection, per-hop redirect checks; §3.4 release gate |
| 4 | Secret visible to the connector | §3.1/§3.3: no `secret()` in `ConnectorContext`, injected by client/sidecar, header allow-list, dropped on redirect, `oauth` removed |
| 5 | Cursor not protected | §5.2 advisory lock + §5.5 compare-and-set on `cursor_before`; concurrent-run test |
| 6 | Raw rows lost on non-ok runs | §4: row recorded per response in its own transaction; reconciliation of orphan blobs |
| 7 | Retention premise | §2 and §4: legal premise removed; `raw_retention_days`, audited prune and purge |
| 8 | Run and job not atomic; no recovery | §5.5/§5.6: `finish_job` in the same transaction; §6.3 heartbeat and `reclaim_jobs`; crash tests |
| 9 | New tables lack RLS/audit spec | §6.2 full matrix for `raw_object`; §6.4 rules for module tables, checked by the suite in CI |
| 10 | Batch shape undefined | §5.4 and §7: shape, null and duplicate checks over the whole run before the first statement |
| 11 | DB checks and licenses may never run | §8.5 mandatory DB part in the `database` job; §10 hashed requirements and transitive license check. Not accepted: dropping the 14-day rule; it is a selection-time policy of the user, recorded per version, and does not affect reproducibility |
| notes | `xmax`, robots, logs, `url_path` | §7 PG 15–17 + test; §3.2 step 6 (RFC 9309, fail closed, counted); §5.4–§5.6 codes and paths only; §6.2 `url_path` |
