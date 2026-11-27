# E3.1 code review (Codex, EGM stage 4) — 2026-11-24

Reviewed at 372917a (diff 3f79325..790bdc4), `codex exec --sandbox read-only`, on VPS-Líbano. Verbatim.

1. **BLOCKER — `workers/core/connectors/loader.py:119`, `workers/core/connectors/runner.py:103`**
   Shared snapshot target protection is ineffective. `check_registry()` only detects two snapshot connectors, allowing snapshot plus incremental connector to share one table. Runner never calls `check_registry()` anyway. Snapshot run can delete rows owned by another source through `delete_missing()`, violating source lease boundary and design §4.

2. **BLOCKER — `workers/core/connectors/takedown.py:35`**
   Command inserts one job, then claims oldest queued `core.takedown` job without verifying returned job identity or payload. With pending takedown for source A, invocation for source B can mutate B under A’s lease, finish A, and leave B queued. Audit attribution and lease scope become false.

3. **BLOCKER — `workers/core/fetch/client.py:102`**
   Robots check receives `target.path`, excluding query and truncated to 300 characters. Request uses full `target.path_qs`. `Disallow: /search?private=1` therefore allows and fetches `/search?private=1`; long disallowed paths can bypass similarly. Confirmed with client returning HTTP 200. Contradicts RFC 9309 enforcement and design §3.2.

4. **BLOCKER — `workers/core/connectors/runner.py:207`**
   `MANDATO_DEBUG=1` logs full exception and traceback. PostgreSQL conversion errors commonly embed rejected record values; connector exceptions may embed raw records or secrets. This directly contradicts design requirement that logs contain only type, code, and framework frame.

5. **BLOCKER — `workers/core/connectors/upsert.py:78`**
   Snapshot keep keys use `json.dumps(..., default=str)`, while stored keys use `jsonb_build_array`. A `numeric` natural key represented by `Decimal("1.0")` becomes JSON string `"1.0"` but database expression becomes numeric `1.0`. Comparison fails, so snapshot deletes records it just upserted and still commits run as successful.

6. **SHOULD-FIX — `workers/core/connectors/runner.py:189`**
   Connector-supplied `Issue.code` and `Issue.path` reach logs without validation. Contract suite checks only whether errors exist, not code/path grammar. Validator can accidentally place record content, newline characters, or secret material in `path`, leaking it into logs.

7. **SHOULD-FIX — `workers/core/connectors/runner.py:157`**
   `FetchClient` construction and secret resolution happen before protected `try`. Missing secret or secret-provider failure escapes runner entirely: no tx3, no failed run, and no `finish_job`. Job and run remain `running` until stale-lease recovery, contradicting failure lifecycle design.

8. **SHOULD-FIX — `workers/core/fetch/client.py:31`**
   Socket timeout is inactivity timeout, not 30-second total request deadline. Server sending one byte every 29 seconds can hold request indefinitely while heartbeat preserves lease, bypassing required per-request time budget.

9. **SHOULD-FIX — `workers/core/fetch/client.py:70`**
   Lease is checked before token-bucket sleep but not afterward. If lease disappears during rate-limit wait, client still resolves host and sends request—possibly with API credential—before recorder later discovers invalid lease.

PostgreSQL integration suite not run. Read-only environment also blocked two tempfile-based boundary tests; 27 available unit tests passed.

**VERDICT: REQUEST CHANGES — 5 BLOCKER, 4 SHOULD-FIX.**
