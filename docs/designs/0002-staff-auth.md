# Design 0002 — Staff authentication, profiles and audit trail (E0.5)

Status: **Draft v3** · 2026-11-22 · Builds on design 0001 (contract 0.1.0, frozen). Owner: architecture backbone. v2 answers the Codex review `egm/0002/stage1-codex.md`; §10 maps each finding.

## 1. Problem

Design 0001 froze the database side of staff access: `core.has_role` (aal2, active user, enabled module), `grant_role`/`revoke_role`, `audit.write` with a derived actor, and `api_rt` running each request with the caller's JWT claims. Nothing yet lets a person become staff, proves their second factor, runs a request under their identity, or shows the audit trail. E0.5 delivers that and nothing else. Content, agenda and the CMS screens come later and use what E0.5 exposes.

## 2. Constraints

- Supabase Auth issues identities. Citizens get no account in P1 (0001 §4.1).
- `service_role` and the database superuser are used only by bootstrap and the operator runbook, never by the API or workers (0001 §4.1). The API cannot call the Supabase admin API.
- `app_user.pii_name` and `pii_email` are C2 ciphertext; `bi_email` is C1 (0001 §3, §4.6). The database never holds an unwrapped key, so anything that encrypts, decrypts or computes a blind index runs in the API process, which holds the KEK.
- Every write is audited by the database. The API adds no second audit log.
- **The API checks, the database enforces again** (0001 §9). Every privileged (`SECURITY DEFINER`) function below repeats its own authorization; a handler bug alone never grants anything.

## 3. Second factor: TOTP only

- Supabase's `aal2` means "some second factor", which could include phone OTP. The framework accepts **TOTP only**.
- 0003 tightens `core.is_aal2()` (used by the frozen `has_role`). It now returns true only when `aal = 'aal2'` and the `amr` claim has an entry with `method = 'totp'`.
- This is a narrowing of the frozen contract: every caller it accepted before is a superset of what it accepts now. It ships as a forward migration and is listed in 0001's change log as contract 0.1.1.
- Phone MFA must also be disabled in the project. `mandato auth check` (§8) verifies that, as a second layer.
- **Recent TOTP.** `core.recent_totp(max_age)` reads the **most recent** `amr` entry with `method = 'totp'`. Its `timestamp` must be numeric, no more than 60 s in the future, and no older than `max_age`.
  - Supabase derives these timestamps from the persisted session, so a token refresh does not renew them.
  - The value used is 15 minutes, by the API and by the database. On failure the API answers `403 urn:mandato:error:reauth_required`, and the client asks for the TOTP code again.

## 4. Identity lifecycle

| Step | Who | How |
| --- | --- | --- |
| 0. First chief | operator, once per instance | `mandato staff bootstrap-chief <tenantDir> <db> --name --email` creates a `bootstrap` invitation for `chefe_gabinete`. It takes the instance lock (§6), first cancels any expired, unused bootstrap invitation, then refuses if an active chief or a still-valid bootstrap invitation exists. |
| 1. Invitation | chief, recent TOTP | `POST /api/v1/staff/invitations {name, email}`. The API encrypts name and email and computes `bi_email`. `core.create_invitation` (definer) re-checks chief and recent TOTP, cancels an expired open invitation for the same `bi_email`, and inserts the new one (7 days). The chief tells the person out of band; the framework sends no e-mail. `DELETE /api/v1/staff/invitations/{id}` cancels one. |
| 2. Sign-up | invitee | Supabase sign-up (e-mail + password, confirmation on). The **Before User Created** HTTP hook (§5) accepts only an e-mail with an open invitation. Every other sign-up is refused. |
| 3. Second factor | invitee | TOTP enrolment, then a verified TOTP login (`aal2` with `totp` in `amr`). |
| 4. Activation | invitee | `POST /api/v1/me/activate` with an **empty body**; any field is rejected. The API computes `bi_email` from the JWT's verified `email` claim and encrypts name (from the invitation) and e-mail. `core.activate_invitation(bi_email, pii_name, pii_email)` (definer) checks, under the instance lock: `auth.uid()` set, `core.is_aal2()`, no `app_user` with that id, an open unexpired invitation with that `bi_email`. It then creates `app_user` (`id = auth.uid()`) and marks the invitation used. For a bootstrap invitation it re-checks that no active chief exists and inserts the `chefe_gabinete` assignment with `granted_by = auth.uid()`. This is the only self-grant, and it is audited as `bootstrap_chief`. |
| 5. Roles | chief, recent TOTP | Frozen `grant_role` / `revoke_role`, tightened in 0003 to also require `core.recent_totp('15 min')`. |
| 6. Suspend, reactivate, remove | chief, recent TOTP | `core.set_user_status(target, status)` (definer). It requires `has_role('chefe_gabinete')`, recent TOTP and `target <> auth.uid()`. Allowed transitions: `active ↔ suspended`, `active/suspended → removed`. `removed` is final. A suspended user fails `has_role` at once, whatever their JWT says, so suspended users cannot act on each other. |
| 7. Lost TOTP | operator runbook | Another member of staff: (1) the chief suspends the user; (2) the operator, with `service_role`, revokes all sessions and deletes the factor; (3) the user re-enrols; (4) the chief reactivates. A stolen `aal2` token is useless from step 1, because `has_role` reads the live status. **The chief themself** (or the only chief): the operator does step 2 at once. Exposure is bounded by the remaining life of an access token (≤ 15 min), because refresh tokens are revoked. Recommended practice, not enforced: two people hold `chefe_gabinete` (for example the parliamentarian and the chief of staff), so either can suspend the other. |

## 5. Sign-up hook

`POST /api/v1/auth/hooks/before-user-created`:

- It verifies the **raw request bytes** with the official `standardwebhooks` library, the hook secret from the instance secret store, and the library's default 5-minute tolerance. It never parses the body before verifying it, and never follows redirects.
- It answers within Supabase's 5-second budget. Statement timeout is 2 s; on timeout or error it refuses (fail closed).
- The answer is JSON in Supabase's documented form: `{}` with 200 to allow, or `{"error": {"http_code": 403, "message": "Cadastro apenas por convite."}}` to refuse.
- It runs as `api_rt` with the anonymous claim and calls only `core.invitation_open(bi_email) → boolean` (definer).
- **Replay** within the window cannot change state (the call is read-only), but it could be used to flood the endpoint. Each API process therefore keeps the `webhook-id`s it has seen in the last 5 minutes (bounded in-memory set) and answers a repeat at once without touching the database, and allows at most 4 hook requests in flight; excess requests are refused at once (fail closed: a refused sign-up can be retried by the invitee).

## 6. Database changes (`0003_core.sql`, forward only, contract 0.1.1)

- `core.staff_invitation` columns:

| Column | Type and class | Notes |
| --- | --- | --- |
| `id` | uuid v7, C1 | |
| `pii_name`, `pii_email` | bytea, C2 | |
| `bi_email` | bytea, **C1** | |
| `bootstrap` | boolean, C1 | |
| `invited_by` | uuid, C1 | null only when `bootstrap` |
| `expires_at` | C1 | |
| `used_at`, `used_by`, `cancelled_at` | C1 | |
| timestamps | | |

- Constraints and policies on `core.staff_invitation`:
  - Unique `bi_email` where `used_at is null and cancelled_at is null`.
  - Unique `(bootstrap)` where `bootstrap and used_at is null and cancelled_at is null`. An expired row stays in that index until cancelled, so `bootstrap-chief` and `create_invitation` cancel expired open rows under the lock before inserting.
  - RLS is forced. `api_rt` may select only with `has_role('chefe_gabinete')`; there is no direct insert or update grant.
  - Audited by the row trigger.
- **Instance lock.** Bootstrap creation and activation both run `select … from core.instance where id = 1 for update`, then re-check under that lock. This serializes the "no chief yet" decision.
- Definer functions:
  - All are `set search_path = pg_catalog, core, pg_temp`, owned by `core_owner`, with `EXECUTE` for `api_rt` only.
  - The list: `invitation_open`, `create_invitation`, `cancel_invitation`, `activate_invitation`, `set_user_status`, `index_key(purpose)`, `recent_totp`.
  - `create or replace` of `is_aal2`, `grant_role` and `revoke_role`, which only adds the checks of §3 and §4.
- **Index key access.** `core.index_key('bi:email:v1')` returns the wrapped bytes of exactly that one blind-index key, to `api_rt` only, whatever the caller's claims.
  - Without the KEK, which only the API process holds, the bytes are useless, and the frozen `key_read` policy on data DEKs is unchanged.
  - It exists because the hook caller and a not-yet-activated user are not staff.
- New permission `core.staff.manage` (chief). New audit terms: `invite`, `cancel_invite`, `activate`, `bootstrap_chief`, `set_status`.
- Appendix A gains the table. `grants.md` is regenerated.

## 7. API layer (`packages/core-api`)

Handlers are framework-agnostic, on the Fetch API (`(Request) => Promise<Response>`). Next.js route handlers mount them as they are, and tests call them directly.

- **JWT verification** (`jose`):
  - Supabase asymmetric keys from the project JWKS. Allowed algorithms: `ES256`, `RS256`. HS256 and `none` are refused.
  - Checks: `iss`, `aud = authenticated`, `exp`, and `sub` is a UUID.
  - JWKS caching: the set is cached for 10 minutes. An unknown `kid` triggers at most one refetch per 5 minutes. A key dropped from the set is evicted on the next fetch.
  - If the JWKS endpoint is down, the last good set is used for up to 1 hour, then requests fail closed.
- **Request runner** `withRequest(claims, fn)`: one pooled connection as `api_rt`, running `begin; set_config('request.jwt.claims', $1, true)`, then `fn`, then commit or rollback. Claims come only from the verified token.
- **Authorization**: `requirePermission(tx, 'core.staff.manage')` asks the database (`core.has_permission`). Recent TOTP is checked in the API and again inside the definer.
- **Errors**: RFC 9457. Never an e-mail or a name.

| Endpoint | Caller | Database |
| --- | --- | --- |
| `GET /api/v1/me` | aal2 (TOTP) | own `app_user`, own assignments |
| `POST /api/v1/me/activate` | aal2, empty body | `activate_invitation` |
| `POST /api/v1/staff/invitations` | chief, recent TOTP | `create_invitation` |
| `DELETE /api/v1/staff/invitations/{id}` | chief, recent TOTP | `cancel_invitation` |
| `GET /api/v1/staff?cursor=&limit=` | chief | `app_user` + assignments; names decrypted in the API; `{data, next_cursor}` |
| `POST /api/v1/staff/{id}/roles` | chief, recent TOTP | `grant_role` |
| `DELETE /api/v1/staff/roles/{assignment}` | chief, recent TOTP | `revoke_role` |
| `POST /api/v1/staff/{id}/status` | chief, recent TOTP | `set_user_status` |
| `GET /api/v1/audit/events?cursor=&limit=` | chief | `audit.event` (`chief_read`) |

## 8. Keys and project settings

- **`packages/core-crypto`**:
  - Envelope and AAD exactly as 0001 §4.6, with XChaCha20-Poly1305 (`libsodium-wrappers`, pinned).
  - The KEK reaches the process as `MANDATO_KEK_<kek_id>` (base64, 32 bytes) from the secret store. It is never logged and never sent to the database.
  - `mandato keys init` (operator) creates the DEKs for the four `pii_` columns and the `bi:email:v1` index key, all wrapped. It then prints the steps for the age-encrypted recovery copy.
  - Rotation (implementation tests 4 and 5) stays in the crypto lane.
- **`mandato auth check <tenantDir>`** (operator, not runtime):
  - It reads the hosted project's auth configuration through the Supabase Management API (`GET /v1/projects/{ref}/config/auth`), with an operator access token limited to the `auth:read` scope where possible (fields `hook_before_user_created_*`, `mfa_totp_*`, `mfa_phone_*`, `mfa_web_authn_*`, `sessions_*`, `jwt_exp`, `password_min_length`, `mailer_autoconfirm`).
  - The token is never stored in the instance and never given to the API.
  - It checks: sign-up hook enabled and pointing to the instance API, e-mail confirmation on, TOTP enabled, phone and WebAuthn MFA disabled, JWT expiry ≤ 15 min, inactivity timeout set, password minimum ≥ 12.
  - Runs at bootstrap and in the weekly operations check (E7.1). Field names are confirmed against the live API in implementation; an unreadable field is a failure, not a pass.
- **Session bound.** Supabase checks the inactivity timeout at refresh, so access lasts at most the timeout plus one JWT lifetime (12 h + 15 min). The inactivity timeout exists only on Supabase **Pro** and above, so production instances need Pro.

## 9. Tests (definition of done)

Each test is written to fail first.

1. **Hook:**
   - refuses: no invitation, an expired, used or cancelled invitation, a bad signature, a stale timestamp, a body re-serialized after signing;
   - accepts an open invitation;
   - fails closed on a database timeout.
2. **Activation, called as SQL directly (not only through the handler):**
   - refuses: `aal1`, `aal2` without `totp`, a second activation, a `bi_email` with no invitation;
   - two concurrent bootstrap activations produce exactly one chief;
   - bootstrap is refused when an active chief exists.
3. **`set_user_status`:**
   - refuses: a non-chief, self, stale TOTP, `removed → active`;
   - a suspended chief cannot act.
4. **Tightened frozen functions:** `grant_role` with stale TOTP fails; `has_role` with `aal2` but SMS in `amr` returns false; every existing 0001 test still passes after the `run.sh` claims helper adds a fresh `totp` `amr` entry (the tightening is intentional, so the helper changes, not the assertions); one new test keeps the old `{sub, aal}` claims and expects denial.
4b. **Replay and bootstrap expiry:** a repeated `webhook-id` never reaches the database; a fifth concurrent hook request is refused; an expired bootstrap invitation does not block a new one.
5. **API:**
   - every staff endpoint refuses `aal1`, a suspended user and a non-chief;
   - recent-auth endpoints refuse stale or future `amr`;
   - JWTs are refused when they have a wrong `aud` or `iss`, are expired, use HS256, or have an unknown `kid` (with the refetch cooldown honoured);
   - activation with a non-empty body returns 400.
6. **Crypto:**
   - envelope round trip;
   - AAD mismatch fails: other row, other column, other instance;
   - a wrapped DEK presented under another purpose fails;
   - normalization vectors;
   - `index_key` returns only `bi:email:v1`.
7. **No PII:** captured logs, responses and audit rows never contain the synthetic e-mail or name.

**Where they run:** unit and handler tests in `pnpm test` (local JWKS, no network); SQL in `run.sh`; an API-against-Postgres test in the database job.

**Review:** two reviewers on the code (authentication and keys).

## 10. Review findings (stage 1) and where they are answered

| Finding | Answer |
| --- | --- |
| B1 index key unreadable | §6 `core.index_key`, wrapped bytes of one purpose only |
| B2 activation lacks aal2 inside | §4 step 4, checks inside the definer; test 2 calls SQL directly |
| B3 `set_user_status` lacks chief check | §4 step 6 |
| B4 bootstrap race | §6 instance lock, unique open bootstrap invitation; test 2 concurrency |
| B5 aal2 ≠ TOTP | §3 `is_aal2` narrowed to TOTP; `auth check` requires phone MFA off |
| B6 `bi_email` class | C1, as frozen |
| S1 MFA reset | §4 step 7 order |
| S2, S3 hook body, response, replay | §5 |
| S4 recent-auth semantics | §3 |
| S5 JWKS bounds | §7 |
| S6 session wording, Pro plan | §8 |
| S7 settings authority | §8 `mandato auth check` with operator token |
| S8 partial index with `now()` | §6 uses `used_at`/`cancelled_at`; expired open invitations are cancelled on re-invite |
| S9 activation input | §4 step 4, empty body |
| S10 `/staff` pagination | §7 |

## 11. Out of scope

CMS screens (E1.1), App do Gabinete login (E8.1), SSO, passkeys, citizen accounts, KEK rotation.

## 12. Decisions open to veto

- **Sign-up:** invite-only through the sign-up hook, so `service_role` stays out of the API.
- **First chief:** self-grants once, through the operator's bootstrap invitation.
- **Second factor:** TOTP only. Contract 0.1.1 narrows `is_aal2` to match.
- **Lost TOTP:** an operator procedure, not an API feature.
- **Plan dependency:** production needs Supabase Pro (inactivity timeout). This is a cost item for the product owner.
