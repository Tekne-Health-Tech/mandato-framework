<!-- Codex (codex exec, read-only sandbox) re-check of design 0004 v2, saved as relayed. -->

## Stage-1 blockers

1. **CLOSED** — Sidecar has no direct external route; `egress` enforces host/port/address policy. Raw TCP/DNS bypass covered.
2. **CLOSED** — Staging DB traffic restricted through single-destination `dbgw`; staging-equivalent test defined.
3. **CLOSED** — Lease-derived source, expiry, per-job budgets, secret allow-list, and `O_NOFOLLOW` remove confused-deputy path.
4. **CLOSED** — Guarantee correctly narrowed to framework-controlled surfaces.
5. **OPEN** — Registry names `JOBS`/`CONNECTORS`, while frozen contract and demo export lowercase `jobs`/`connectors`. Also no rule requires schedule `data_class` to equal registered job's class. Result: empty registry or permanently unclaimable/mis-pooled jobs.
6. **OPEN** — Fresh schedule has no defined `last` value: `max(run_after)` returns `NULL`, so `(last, now]` can enqueue nothing. Prefix lookup also uses unescaped `LIKE`; `_` in schedule IDs matches arbitrary characters.
7. **OPEN** — `FINISHED` sentinel is absent from frozen `JobResult` contract. Connector handler either violates contract or loop calls `finish_job` again after atomic finalization.
8. **CLOSED** — Impossible 25-second guarantee removed; grace, rollback, heartbeat, and reclaim behavior defined.
9. **CLOSED** — Worker generated per required pool; unsupported C2/C3 connectors rejected.
10. **OPEN** — Preflight reads and writes `core.instance (tenant_id, env)`, but frozen table has `slug`, `display_name`, `house_acronym`, `uf`, and version fields—no `tenant_id` or `env`. Every preflight fails or cannot establish claimed identity binding. `auth check` also remains after writes.
11. **OPEN** — §7's Debian/GPL position conflicts with repository rule forbidding third-party GPL/LGPL/AGPL code being copied or linked. "Declared for veto" is not an approved base-image exception; real policy defect remains.

## New blockers introduced by v2

- **N1 — `fetch_c1` cannot perform claimed audited writes.** Existing `audit.pool_classes()` and actor derivation recognize only `worker_c1/c2/c3`; therefore `audit.bind_lease()` rejects `fetch_c1`, and audited `raw_object` inserts cannot succeed.
- **N2 — Healthy idle instance fails `check`.** Check requires a recent worker "claim heartbeat," but runtime emits heartbeats only while running jobs. Empty or fully disabled queues produce no such evidence.

**VERDICT: REQUEST CHANGES — 7 blockers (5 open + 2 new).**

Skipped: implementation and §12 out-of-scope lanes. Risk: design review only; no runtime validation.
