# Stage 6 — Final cross-provider security review of v4 (Codex)

Scope: §§4.1, 4.5, 4.6, 6.3 and 7.5 only, plus closure status for the findings named by the stopping rule. No new blocker found.

## Finding status

| Finding | Status | Reason |
| --- | --- | --- |
| NEW-1 | partly | `session_user`, removal of caller-supplied `kind`, and transaction-scoped token binding close actor forgery and pooled-backend reuse, but `audit.event.db_role default current_user` still records `audit_owner` inside `audit.write`. |
| NEW-2 | closed | The v4 mapping supplies ids, timestamps and per-projection schemas and removes the uncontracted `institutional` projection, addressing the reported shape mismatch without reopening non-security design. |
| NEW-3 | closed | RFC 8785, explicit Ed25519 encoding and `key_id`, overlap keyring rotation, signed key updates, expiry and build-pinned minimum generation close canonicalization, rotation and first-install replay gaps. |
| NEW-4 | closed | Workers have no internet egress, each provider has an isolated sidecar identity and host policy, and per-class pools can reach only sidecars cleared for their class. |
| CP-03 | closed | Opaque framework parts, operator-owned ceilings and locality, class-bound database roles, and sidecar network isolation remove the previously reachable caller/provider bypass. |
| CP-04 | partly | Default revokes, runtime-role attributes, forced RLS and class-bound pools establish the boundary, but the exact role × table × verb matrix remains an E0.0-generated artifact rather than a frozen list here. |
| CP-07 | partly | Actor kind and id now derive fail-closed from immutable login identity plus a transaction lease, but the stored `db_role` default still resolves to the definer rather than the invoker. |
| CP-08 | partly | Authenticated DEK envelopes, key states, bounded cutover and retained wrapped keys close the data-key race, but KEK rotation lacks a crash-safe secret-store/database cutover and refreshed offline recovery after rotation. |
| CP-10 | closed | `audit.migration_log` now has a separate owner outside every role assumable by `migrator`, rejecting mutation triggers and hash-mismatch boot failure. |
| CP-12 | closed | Signed canonical manifests, generation rollback rejection, authenticated takedowns before version gating, expiry and build-pinned bootstrap freshness close replay and unsupported-client gaps. |

## Implementation tests

- Insert audit events through every runtime login and assert `actor_kind`/`actor_id` derive correctly; assert recorded `db_role` is the validated `session_user`, never `audit_owner`.
- Bind a valid job lease, commit, reuse the same pooled backend in another transaction without binding, and assert every C1+ write fails.
- Generate `packages/db/grants.md` from a migrated database and fail on any unexpected schema, table, column or verb grant; exercise cross-pool reads for C1, C2 and C3 columns.
- Fault-inject KEK rotation before and after secret-store update and database commit; every restart must retain a KEK able to unwrap every DEK, and each rotated KEK must have a recoverable offline copy.
- During DEK rotation, keep an old-key writer open for the maximum transaction lifetime and assert retirement cannot occur until two zero-reference scans complete after writer expiry.
- Run blind-index normalization vectors in TypeScript and Python; during dual write/backfill, assert lookup and uniqueness across both versions under concurrent registration.
- Run RFC 8785/Ed25519 vectors across publisher and app; reject altered canonical bytes, unknown/revoked keys, expired manifests and fresh-install generations below `min_generation_at_build`.
- Serve a valid manifest above an unsupported client's version and assert authenticated takedowns apply before sync stops.
- From each worker pool, assert raw internet is unreachable and sidecars above its clearance are unreachable; from each provider sidecar, assert only its configured hostnames are reachable.

Verdict: freeze
