# E0.7 code review (Codex, EGM stage 4) — 2026-11-24

Reviewed at 372917a (diff 060921e..372917a), `codex exec --sandbox read-only`, on VPS-Líbano. Verbatim.

1. **BLOCKER — Scheduler loses scheduled minutes after retry.**
   `workers/core/runtime/scheduler.py:35` uses mutable `run_after` as schedule watermark. `core.finish_job` moves `run_after` into future for retry. Example: 12:00 job fails and becomes runnable at 12:02; 12:01 tick sees watermark 12:02 and never enqueues 12:01. Use immutable minute encoded in `idempotency_key` or separate scheduled timestamp.

2. **BLOCKER — Fetch sidecar executes tenant module code while holding every connector secret.**
   `workers/core/fetch/sidecar.py:241` calls `load_registry`; `workers/core/runtime/registry.py:95` imports and executes each module’s `__init__.py`. Module code can read `/run/secrets/*`, bypass `read_secret`, open `egress:3128` directly, and exfiltrate one connector’s secret to another connector’s allow-listed host. Design confines module execution to worker trust boundary.

3. **BLOCKER — Scheduler executes tenant module code with scheduler credentials.**
   `workers/core/runtime/scheduler.py:102` uses same importing registry. Import-time module code can read scheduler password file and enqueue arbitrary `sched:` jobs, queues, payloads, and data classes. This exceeds manifest-only scheduler authority defined by design.

4. **BLOCKER — Lease checked only before potentially long, multi-request fetch.**
   `workers/core/fetch/sidecar.py:132` validates lease once; `workers/core/fetch/sidecar.py:138` then performs robots, redirects, rate-limit waits, and origin requests without another grant check. `FetchClient` receives default always-alive callback at `workers/core/fetch/sidecar.py:112`. A compromised worker starts request with valid lease, lets job finish/reclaim, then continues authenticated network activity after capability expiry.

5. **BLOCKER — Threaded sidecar bypasses rate and run budgets.**
   `workers/core/fetch/sidecar.py:174` handles requests concurrently while sharing one client per job at `workers/core/fetch/sidecar.py:115`. `workers/core/fetch/policy.py:110` and `workers/core/fetch/policy.py:128` mutate unsynchronized state. Multiple waiters can wake together and all append without rechecking limit; concurrent requests can exceed rate/request/byte budgets.

6. **BLOCKER — Heartbeat failure permits concurrent execution after reclaim.**
   `workers/core/runtime/worker.py:43` connects outside exception handling; initial failure kills thread without setting `lost`. Later heartbeat failure sets `lost` and permanently exits at `workers/core/runtime/worker.py:49`, but handler continues at `workers/core/runtime/worker.py:176`. After ten minutes another worker reclaims and reruns job while original handler still executes.

7. **BLOCKER — Wrong database is mutated before identity validation.**
   `infra/bootstrap/instance.mjs:167` writes state/secrets, `infra/bootstrap/instance.mjs:208` changes cluster roles, and `infra/bootstrap/instance.mjs:223` may reset demo data before `registerInstance` checks `core.instance` at `infra/bootstrap/instance.mjs:229`. Passing another tenant’s existing database can migrate or reset it before slug mismatch aborts.

8. **BLOCKER — Required staging path and staging-equivalent release test do not exist.**
   `infra/bootstrap/instance.mjs:161` rejects every staging `up`. `infra/compose/test-network.sh:48` runs only local shape despite accepted design requiring both shapes. `dbgw`, TLS hostname path, and staging isolation therefore have no end-to-end gate.

9. **BLOCKER — Runtime worker/tools images are mutable tags.**
   `infra/bootstrap/instance.mjs:57` defaults to `mandato-worker:dev` and `mandato-tools:dev`; neither resolved digest is recorded in generated Compose. Tag replacement can run different code than reviewed Dockerfiles while network test still passes.

10. **BLOCKER — Required supply-chain and network CI gates are absent.**
    `.github/workflows/ci.yml:10` contains no image build, `check_images.py`, network test, SBOM, or vulnerability-scan job. Actions remain mutable tags at `.github/workflows/ci.yml:15`, contrary to accepted design’s SHA pinning. Security-sensitive lane can merge without claimed release gates.

11. **SHOULD-FIX — `core.instance.env` remains nullable.**
    `packages/db/migrations/0005_core.sql:28` adds nullable column, never applies `NOT NULL`. Superuser/bootstrap errors or incomplete registration can leave instance without environment despite v4 invariant.

12. **SHOULD-FIX — `instance check` does not verify migration integrity.**
    `infra/bootstrap/instance.mjs:253` checks only migration count. Changed hashes, missing expected IDs, or extra unreviewed migrations pass despite design requiring migrations “recorded and unchanged.”

13. **SHOULD-FIX — Postgres and tools bypass container hardening.**
    `infra/bootstrap/instance.mjs:74` gives Postgres writable root filesystem, default capabilities, and no `no-new-privileges`. `infra/bootstrap/instance.mjs:111` gives tools same gaps and runs as root whenever invoking host UID is 0. Design’s no-root/container-hardening guarantee does not cover these containers.

14. **SHOULD-FIX — Per-platform image pins are decorative, not enforced.**
    `scripts/check_images.py:21` validates only index digest shape and existence of `platforms`; individual platform digests are neither validated nor matched to Dockerfile/runtime platform. Release-age check trusts editable `added` and `released` strings at `scripts/check_images.py:25`, not commit history.

**VERDICT: REJECT**

Counts: **10 BLOCKER, 4 SHOULD-FIX**.

Checked pure cron suite: 13 passed. `scripts/check_images.py` passed, demonstrating gate weakness above. Socket/temp-dependent sidecar tests could not run under read-only sandbox; no root, Docker, or external network checks performed.
