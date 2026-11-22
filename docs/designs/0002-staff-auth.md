# Design 0002 — Staff authentication, profiles and audit trail (E0.5)

Status: **Draft v1** · 2026-11-22 · Builds on design 0001 (contract 0.1.0, frozen). Owner: architecture backbone.

## 1. Problem

Design 0001 froze the database side of staff access: `core.has_role` (aal2, active user, enabled module), `grant_role`/`revoke_role`, `audit.write` with a derived actor, and `api_rt` running each request with the caller's JWT claims. Nothing yet lets a person become staff, proves their second factor, runs a request under their identity, or shows the audit trail. E0.5 delivers that, and nothing else. Content, agenda and the CMS screens come in later lanes and use what E0.5 exposes.

## 2. Constraints

- Supabase Auth issues identities. Citizens get no account in P1 (0001 §4.1).
- `service_role` and the database superuser are used only by bootstrap and the operator runbook, never by the API or workers (0001 §4.1). So the API cannot call the Supabase admin API.
- `app_user.pii_name` and `pii_email` are C2 ciphertext with a blind index `bi_email` (0001 §4.6). The database never holds keys, so anything that encrypts, decrypts or computes a blind index runs in the API process.
- Every write is audited by the database (`audit.write`, row triggers). The API adds no second audit log.
- "App propõe, pessoa decide": nothing here involves AI.

## 3. Identity lifecycle

| Step | Who | How |
| --- | --- | --- |
| 0. First chief | operator (Tekne), once per instance | `mandato staff bootstrap-chief <tenantDir> <db> --name --email`: creates an invitation flagged `bootstrap` with `initial_role = 'chefe_gabinete'`. Refused if any active `chefe_gabinete` assignment exists. |
| 1. Invitation | `chefe_gabinete`, aal2 | `POST /api/v1/staff/invitations {name, email}`. The API encrypts name and email, computes `bi_email`, inserts `core.staff_invitation` (expires in 7 days). The chief tells the person out of band to sign up; the framework sends no e-mail. |
| 2. Sign-up | the invitee | Supabase sign-up (e-mail + password, e-mail confirmation on). The **Before User Created** HTTP hook calls the API, which accepts only an e-mail with an open, unexpired invitation (blind-index lookup). Every other sign-up is refused. Public sign-up is therefore closed without `service_role`. |
| 3. Second factor | the invitee | Supabase TOTP enrolment, then a verified login: the JWT carries `aal = 'aal2'`. |
| 4. Activation | the invitee, aal2 | `POST /api/v1/me/activate`. `core.activate_invitation(bi_email, pii_name, pii_email)` (definer) checks the invitation is open and that its `bi_email` matches the one computed by the API from the JWT's verified e-mail, creates `app_user` with `id = auth.uid()`, marks the invitation used. For a `bootstrap` invitation it also inserts the `chefe_gabinete` assignment with `granted_by = auth.uid()`, the only self-grant, audited as action `bootstrap_chief`. |
| 5. Roles | `chefe_gabinete`, aal2, recent auth | existing `core.grant_role` / `core.revoke_role` through `POST /api/v1/staff/{id}/roles` and `DELETE /api/v1/staff/roles/{assignment}`. |
| 6. Suspend, reactivate, remove | `chefe_gabinete`, aal2, recent auth | `core.set_user_status(target, status)` (definer): not self, target exists, `removed` is final. A suspended or removed user fails `has_role` at once, whatever their JWT says. |
| 7. Lost second factor | operator runbook | `mandato staff reset-mfa` with `service_role`, at the chief's written request; audited by the operator procedure. The API cannot do it, by design. |

Supabase settings, checked by `mandato bootstrap` (it refuses to finish otherwise): sign-up hook enabled and pointing to the API, e-mail confirmation on, TOTP enabled, JWT expiry ≤ 15 min, session inactivity timeout ≤ 12 h, password minimum 12.

## 4. API layer (`packages/core-api`)

Framework-agnostic handlers on the Fetch API (`(Request) => Promise<Response>`), so Next.js route handlers in `apps/web` mount them without glue, and tests call them directly.

- **JWT verification** (`verifyStaffJwt`): Supabase asymmetric signing keys from the instance JWKS (cached, refreshed on unknown `kid`); checks `iss`, `aud = authenticated`, `exp`, `sub` is a UUID. Library: `jose`. HS256 shared secrets are not accepted.
- **Request runner** (`withRequest(claims, fn)`): one pooled connection as `api_rt`, `begin; select set_config('request.jwt.claims', $1, true)`, `fn(tx)`, commit or rollback. Claims are the verified token's payload, never client-supplied JSON. Library: `pg`.
- **Permission check**: handlers call `requirePermission(tx, 'core.staff.manage')`, which asks the database (`core.has_permission`), so the API and RLS read the same truth (0001 §9: check in the API, enforce again in RLS).
- **Recent authentication** for role, status and invitation changes: the JWT's `amr` entry for `totp` must be at most 15 minutes old; otherwise `403 urn:mandato:error:reauth_required`, and the client re-prompts the TOTP code.
- **Errors**: RFC 9457 as in `docs/api-conventions.md`; never echo e-mail or name.
- **Sign-up hook endpoint** `POST /api/v1/auth/hooks/before-user-created`: Standard Webhooks signature with the hook secret from the instance secret store, 5-minute timestamp tolerance; runs as `api_rt` with the anonymous claim and calls only `core.invitation_open(bi_email)` (definer, returns boolean).

| Endpoint | Caller | Database call |
| --- | --- | --- |
| `GET /api/v1/me` | any aal2 | `app_user` own row, own assignments |
| `POST /api/v1/me/activate` | aal2, not yet `app_user` | `core.activate_invitation` |
| `POST /api/v1/staff/invitations` | chief, recent auth | insert `staff_invitation` |
| `GET /api/v1/staff` | chief | `app_user` + assignments, names decrypted in the API |
| `POST /api/v1/staff/{id}/roles` | chief, recent auth | `core.grant_role` |
| `DELETE /api/v1/staff/roles/{assignment}` | chief, recent auth | `core.revoke_role` |
| `POST /api/v1/staff/{id}/status` | chief, recent auth | `core.set_user_status` |
| `GET /api/v1/audit/events?cursor=&limit=` | chief | `audit.event` (policy `chief_read`), ids and field names only |

## 5. Minimal key management (`packages/core-crypto`)

E0.5 is the first code that writes C2 columns, so it ships the part of 0001 §4.6 it needs; rotation stays in the crypto lane.

- Envelope and AAD exactly as 0001 §4.6, XChaCha20-Poly1305 via `libsodium-wrappers` (pinned).
- KEK from the instance secret store, exposed to the process as `MANDATO_KEK_<kek_id>` (base64, 32 bytes); never logged, never sent to the database.
- `mandato keys init <tenantDir> <db>` (operator): creates the active DEKs for `core.app_user.pii_name`, `core.app_user.pii_email`, `core.staff_invitation.pii_name`, `core.staff_invitation.pii_email` and the index key for `bi_email`, all wrapped by the KEK, and prints the age-encrypted recovery copy instructions (0001 §4.6).
- Blind index: normalization v1 from `packages/crypto/vectors/normalize-v1.json` (already tested in TS and Python), HMAC-SHA256 with version byte.
- Deferred to the crypto lane, unchanged: KEK rotation (implementation test 4), DEK retirement (test 5), re-encryption jobs.

## 6. Database changes (`0003_core.sql`, forward only)

- `core.staff_invitation`: `id` uuid v7, `pii_name` bytea C2, `pii_email` bytea C2, `bi_email` bytea C2 unique among open invitations, `initial_role` text C1 null (only `chefe_gabinete`, only with `bootstrap`), `bootstrap` boolean C1, `invited_by` uuid C1 null (null only for bootstrap), `expires_at`, `used_at`, `used_by` C1, timestamps. RLS forced; `api_rt` inserts and selects only through `has_role('chefe_gabinete')`. Audited by the row trigger.
- Definer functions, all `set search_path = pg_catalog, core, pg_temp`, owned by `core_owner`, `EXECUTE` to `api_rt` only: `core.invitation_open(bytea) → boolean`, `core.activate_invitation(bytea, bytea, bytea) → uuid`, `core.set_user_status(uuid, text)`.
- New permission `core.staff.manage` mapped to `chefe_gabinete`; new audit terms `invite`, `activate`, `bootstrap_chief`, `set_status`.
- Appendix A gains the table; grants regenerated into `packages/db/grants.md`.

## 7. Tests (definition of done)

Adversarial, each written to fail first:
1. Sign-up hook: refuses an e-mail without invitation, an expired or used invitation, a bad signature, a stale timestamp; accepts an open invitation.
2. Activation: refuses aal1, a JWT e-mail that differs from the invitation, a second activation, a removed user; the bootstrap path refuses when an active chief exists.
3. API: every staff endpoint refuses aal1, a suspended user, a non-chief, and stale `amr` for the recent-auth ones; JWT with wrong `aud`, `iss`, expired, HS256 or unknown `kid` is refused.
4. Database: `set_user_status` on self fails; `removed → active` fails; a suspended chief cannot grant; `api_rt` cannot read `staff_invitation` without the chief role; `bi_email` never appears in an audit row.
5. Crypto: envelope round trip, AAD mismatch (other row, other column, other instance) fails, wrapped DEK under another purpose fails; normalization vectors.
6. No PII in logs or errors: a test greps captured logs and responses for the synthetic e-mail and name.

Runs in CI: unit and handler tests in `pnpm test` (local JWKS, no network), SQL in `packages/db/test/run.sh`, an API-against-Postgres test in the database job. Review: cross-provider (Codex) on this design, then two reviewers on the code because it touches authentication and keys (plan 08, lane K rule applied to E0.5).

## 8. Out of scope

CMS screens (E1.1), the App do Gabinete login (E8.1), SSO, passkeys (later, once Supabase WebAuthn MFA is generally available), citizen accounts, KEK rotation.

## 9. Decisions open to veto

- Invite-only sign-up through the Before User Created HTTP hook, instead of the Supabase admin API, keeps `service_role` out of the API.
- The first chief self-grants once, through the operator-created bootstrap invitation; every later grant follows `grant_role`.
- Lost TOTP is an operator procedure, not an API feature.
- E0.5 pulls forward the envelope, DEK registry use and blind index from the crypto lane, but not rotation.
