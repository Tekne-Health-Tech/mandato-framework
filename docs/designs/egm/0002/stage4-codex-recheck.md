<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

## Verdict

3 closed, 1 open, 0 new.

1. **Closed** — `packages/db/migrations/0003_core.sql:217-221` requires active status for both profile and role-assignment reads. Tests at `packages/db/test/run.sh:237-238` and `packages/core-api/test/api-pg.test.js:142` exercise suspended-user access. Reverting predicates changes expected row counts from `0` to `1` and `/me` from `404` to `200`. PostgreSQL execution unavailable: local peer authentication rejected current user.

2. **Open** — `packages/core-api/src/hook.js:37,68-70` races `request.text()` against timer but never cancels body read. Handler returns and decrements `inFlight` while body remains locked and pending, allowing unlimited abandoned reads. Test at `tests/core-api.test.js:309-317` passes and fails against reverted code by hanging, but checks only response and slot release—not cancellation/bounded underlying work. Probe after timeout: `cancelled=0`, `locked=true`.

3. **Closed** — `packages/core-api/src/jwt.js:36` awaits existing JWKS fetch before cache decisions. Test at `tests/core-api.test.js:296-306` starts two verifications behind gated first fetch and requires both successes plus one fetch. Reverted-fix mutation fails with `jwks unavailable`.

4. **Closed** — `packages/core-api/src/hook.js:47-53` stores pending decision before lookup and shares it by `webhook-id`. Test at `tests/core-api.test.js:320-327` overlaps three deliveries and requires one DB connection. Reverted-fix mutation fails with `3 !== 1`.

## New (diff-introduced only)

None. Finding 2 remains original defect, incompletely fixed.