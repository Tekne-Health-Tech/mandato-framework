<!-- Codex (codex exec, read-only sandbox) review of design 0004 v1, saved as relayed. Only change: absolute local paths rewritten to repo-relative. Note 4 (RTK.md) refers to the reviewer machine's global instructions, not to this repository. -->

## Blockers

1. **§2, §7 — Sidecar egress is not network-enforced.**
   Failure: `fetch-c1` has general internet routing. Compromised sidecar code can bypass `FetchClient` and connect directly to `other.test`, metadata services, or arbitrary hosts. Test only proves policy refusal, not network isolation (0004 §7).
   Required: force sidecar traffic through non-bypassable egress proxy/firewall with destination allow-list. Test raw TCP/DNS bypass attempts, not only `/fetch`.

2. **§2, §7 — Staging database path contradicts "workers have no internet egress."**
   Failure: VPS workers need managed Supabase PostgreSQL, normally through public network. Either database is unreachable or worker receives broader internet route than claimed. Local network test cannot prove staging isolation.
   Required: specify private tunnel or destination-restricted gateway for PostgreSQL, API, and scheduler. Add staging-equivalent network test.

3. **§5 — Sidecar is a cross-source confused deputy.**
   Failure: worker chooses arbitrary `source_id` and self-generated `run_token` (0004 §5). Connector A can request source B's permitted URL, consume B's quota, and cause B's API key to be used. Host policy then validates against B, not caller's job.
   Required: trusted runtime must issue authenticated capability bound to job lease, source, budget, and expiry. Sidecar must verify it. Constrain `auth_secret_ref` to exact configured secret names; reject traversal and symlinks.

4. **§5, §9 — "API key never appears in responses" is unprovable.**
   Failure: allowed upstream can echo credential in response body; worker receives `body_b64`. No generic filter can prove absence under encoding or compression. Current test claim is impossible (0004 §9).
   Required: narrow guarantee to framework-generated environment, mounts, logs, and response metadata. If worker must never receive secret material, sidecar must return validated structured data instead of arbitrary upstream bodies.

5. **§4 — Scheduler input contract does not exist.**
   Failure: module schema has only `worker`; no `jobs`, schedule, payload, or enabled flag (packages/core-contracts/schema/module.schema.json:26). Connector schema also has no disabled state, yet test requires one. `<source_id>:<minute>` is undefined for module jobs.
   Required: freeze schedule declaration schema: stable job identity, queue, class, payload, cron, enabled state, and idempotency key. Update validators and fixtures before implementation.

6. **§4 — Scheduler correctness and privilege remain underspecified.**
   Failure: concurrent plain inserts hit unique violations; one duplicate can roll back newer rows. Cron day-of-month/day-of-week semantics and DST fold/gap behavior are undefined. Testing only `America/Fortaleza` avoids problem. Scheduler runs as broad `worker_c1`, which can claim jobs and access C1 data, despite needing insert only (packages/db/migrations/0001_core.sql:744).
   Required: use `INSERT ... ON CONFLICT (queue, idempotency_key) DO NOTHING`; define scan transaction and cron/DST semantics; validate real IANA zones; test DST fold/gap; create dedicated least-privilege scheduler role.

7. **§4 — Generic jobs have no heartbeat and terminal-state contract conflicts with SQL.**
   Failure: module job running over ten minutes can be reclaimed and executed twice. Connector runner has its own heartbeat, but worker loop specifies none for generic jobs. Design expects `failed/unfinished`; implemented `finish_job(false, ...)` produces `queued` or `dead`, never `failed` (docs/designs/egm/0004/context-0004_core-jobs.sql:1).
   Required: central heartbeat for every claimed job, explicit ownership of finalization, and state assertions matching implemented retry/dead behavior.

8. **§4 — 25-second shutdown bound is not implementable as written.**
   Failure: synchronous handler blocked in Python or native I/O cannot be stopped safely by main loop after 25 seconds. Process may hang beyond orchestrator grace or be killed mid-transaction without defined behavior.
   Required: run handler in cancellable child process, or remove hard bound. Test blocking handler, transaction rollback, heartbeat during grace, forced exit, and later reclaim.

9. **§3, §4 — Compose deploys only `worker-c1`.**
   Failure: C2/C3 jobs can be accepted by contracts and scheduled, but no worker claims them. Pool isolation and cross-pool socket access are therefore not tested (0004 §3).
   Required: deploy one worker per enabled class or reject configurations requiring absent pools. Test every pool against every foreign socket, secret mount, and queue.

10. **§6, §9 — Bootstrap is neither idempotent nor safe against wrong hosted targets.**
    Failure: every local `up` runs `demo reset`, so second run changes data. Staging runs `bootstrap`, migrations, and key writes before `auth check`; mismatched DB URL/project ref can mutate wrong project. `check` also inserts a noop job, so it is not read-only (0004 §6).
    Required: make reset explicit or first-creation-only; perform read-only target identity/auth preflight before writes; bind project ref to DB identity; require explicit staging confirmation; ensure probes are isolated, uniquely keyed, and cleaned up.

11. **§2, §3, §9 — Image supply-chain gate is missing.**
    Failure: image names contain placeholder digests; no recorded selection date, platform digest, SBOM, container-layer license check, or vulnerability policy. Existing CI uses mutable image/action tags and checks only dependency-review scope (.github/workflows/ci.yml:15). "Permissive licenses only" is also questionable for Debian `slim` layers containing GPL utilities.
    Required: record exact per-platform digests, source, release date, and license scope; generate and verify SBOMs; scan OS and language packages; define approved base-image exceptions or choose compliant bases; make digest and age checks executable CI gates.

## Non-blocking notes

- Unix socket plus sidecar-only volume is sound baseline.
- `unique (queue, idempotency_key)` provides final uniqueness once conflict handling is specified (packages/db/migrations/0001_core.sql:233).
- Sixty-minute catch-up intentionally loses older scheduled runs. Document operational consequence and alert requirement.
- `RTK.md` referenced by supplied instructions is absent from repository and parent project tree.
- Review covered design and supplied SQL context only; remaining E3.1 implementation was unavailable.

**VERDICT: REQUEST CHANGES — 11 blockers**
