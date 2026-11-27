<!-- Codex (codex exec, read-only sandbox) final check of design 0004 v3, saved as relayed. -->

5. **CLOSED** — Uses lowercase `jobs`/`connectors`; schedule class derives from registered job.

6. **CLOSED** — Null `last` and wildcard-safe prefix comparison defined.

7. **CLOSED** — Built-in queues bypass `JobResult`; no `FINISHED` sentinel needed.

10. **OPEN** — `env` cannot be established coherently. Preflight reads it before `0005_core.sql`; existing instances lack column. Fresh sequence also says `bootstrap` precedes migration adding column.

11. **CLOSED** — Coherent position: owner approval required; no image published beforehand.

N1. **CLOSED** — `fetch_c1` performs no audited writes; worker records through existing `worker_c1` lease.

N2. **CLOSED** — Idle loop refreshes liveness file; `check` uses container health.

**NEW blocker:** v3 requires `JobResult.detail` to match `^[a-z][a-z0-9_]{0,40}$`, silently tightening frozen contract. Demo returns `"olá"`; compliant existing job becomes `bad_result`.

Skipped implementation/runtime validation; design and named sources only.

**VERDICT: REQUEST CHANGES — 2 blockers.**
