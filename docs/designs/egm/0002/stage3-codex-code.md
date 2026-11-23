<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

## Verdict

1 blocker, 3 should-fix, 0 nits.

## Findings

1. **blocker — `packages/db/migrations/0003_core.sql:216`** — `self_read` checks only aal2 and identity, so suspended or removed users can still read and decrypt their own profile and role assignments through `GET /me`. Scenario: chief suspends user while old aal2 token remains valid; user calls `GET /api/v1/me` and receives `200` with name, status, and roles. Test at `packages/core-api/test/api-pg.test.js:137` claims every staff endpoint is denied but never exercises `/me`.

2. **should-fix — `packages/core-api/src/hook.js:45`** — 4-second budget starts only during database lookup, leaving body reading and signature verification unbounded. Scenario: unauthenticated clients open four chunked POST bodies and never finish them; all four slots remain occupied, and legitimate Supabase sign-up hooks receive immediate `403`.

3. **should-fix — `packages/core-api/src/jwt.js:36`** — concurrent verification during initial JWKS fetch does not await existing `inflight` request after `lastAttempt` changes. Scenario: two valid tokens arrive after cold start; first starts JWKS fetch, second sees `keys === null` but skips both refresh conditions and receives `401`.

4. **should-fix — `packages/core-api/src/hook.js:55`** — replay entry is recorded only after database decision, so concurrent requests sharing one signed `webhook-id` all miss cache. Scenario: four simultaneous deliveries of same valid webhook each query database, contradicting replay test’s “never reaches database” claim at `tests/core-api.test.js:234`.

## Checked and fine

- Definer functions re-check chief, active status through `has_role`, recent TOTP, and self-grant restrictions.
- Bootstrap advisory lock and row locks serialize chief creation and invitation activation.
- JWT algorithm allow-list, `kid`/algorithm matching, issuer, audience, expiry, stale-key deadline, and key eviction are sound outside concurrency finding.
- Hook verifies signed body before parsing and refuses bad signatures, stale timestamps, lookup failures, and capacity overflow.
- Envelope format, XChaCha20-Poly1305, AAD binding, key-id selection, active/decrypt-only handling, and KEK isolation are sound.
- Errors, logs, responses, and audit details avoid e-mail/name leakage outside permitted name fields.
- `git diff --check` passed. Runtime suite could not complete because workspace lacks installed `jose` and `libsodium-wrappers`; no files were edited.