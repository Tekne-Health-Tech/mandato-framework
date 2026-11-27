<!-- Codex (codex exec, read-only sandbox) re-check of design 0003 v2, saved as relayed. Only change: absolute local paths rewritten to repo-relative. -->

### Stage-1 blockers

1. **CLOSED** — Complete `0.2.0` contract, restricted `ConnectorContext`, `raw_ref`, and atomic version change specified.
2. **CLOSED** — `migrator` provisions `data_source`; `worker_c1` gains no insert.
3. **CLOSED** — Per-source hosts, public-IP validation, pinned connection, redirect checks, production release gate.
4. **CLOSED** — Connector cannot access secrets; sidecar injects credentials; redirects drop them; OAuth rejected.
5. **CLOSED** — Advisory lock plus cursor CAS protects correctness.
6. **CLOSED** — Accepted responses get independent `raw_object` rows; orphan blobs reconciled.
7. **OPEN** — Purge removes raw object only. Normalized personal data remains, and later upsert does not delete records removed upstream. Takedown can therefore leave exposed data indefinitely (docs/designs/0003-connector-kit.md:92).
8. **OPEN** — Heartbeat occurs only between resources. Long `discover`/`fetch` work or rate-limit sleeping beyond ten minutes triggers `reclaim_jobs` while valid runner remains active (docs/designs/0003-connector-kit.md:104).
9. **OPEN** — Purge promises `reason` in audit details, but existing `audit.details_ok` rejects that key. Purge must either fail or lose required reason unless `0004` explicitly changes audit contract (packages/db/migrations/0001_core.sql:478).
10. **CLOSED** — Helper validates non-empty uniform shape, columns, natural keys, nulls, and whole-run duplicates before SQL.
11. **CLOSED** — Mandatory DB CI, hashed pins, and installed-transitive license checks specified. Keeping 14-day rule creates no defect: selection date becomes recorded review evidence, while exact pins and hashes keep builds reproducible.

### New v2 blockers

1. **Non-atomic object deletion.** Prune runs inside DB transaction but deletes external blobs. Later failure or rollback restores DB rows while blob stays deleted. Same flaw affects claimed atomic purge.
2. **Unbounded run memory.** 50 MiB limit applies per response, not total run. Unlimited resources/responses can exhaust worker memory; §5's claim that whole run is bounded is false (docs/designs/0003-connector-kit.md:111).

Skipped implementation and CI execution; design and requested source contracts only.

**VERDICT: REQUEST CHANGES — 5 blockers (3 open + 2 new).**
