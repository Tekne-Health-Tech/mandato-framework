<!-- Codex (codex exec, read-only sandbox) final check of design 0003 v3, saved as relayed. -->

- Stage-1 #7 — **OPEN**: all `target_table`s are module-owned, but §11 excludes takedown for module-owned normalized tables. Incremental removal also only sets `deleted_column`; personal data remains stored and potentially exposed.
- Stage-1 #8 — **CLOSED**: independent 60-second heartbeat covers long fetches, parsing, and rate-limit waits.
- Stage-1 #9 — **CLOSED**: reason moved into registered audit action; `{"count": n}` satisfies `audit.details_ok`.
- N1 — **OPEN**: post-commit reference check and blob deletion can race with insertion of new `raw_object` using same SHA. New committed row may reference deleted blob.
- N2 — **OPEN**: limits cover response bytes and request count, not `discover()` resources or normalized record memory. Small input can still produce unbounded in-memory collections.

No new blockers. Implementation and CI not checked; design review only.

**VERDICT: REQUEST CHANGES — 3 OPEN, 2 CLOSED.**
