<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

## Verdict

**REQUEST CHANGES — 6 blockers.** Design cannot safely proceed to implementation. Main failures: activation cannot access blind-index key under frozen RLS, privileged definer functions lack explicit database-side authorization, bootstrap is raceable, and `aal2` does not prove TOTP.

## Blockers

1. **Activation and signup hook cannot read blind-index key under frozen contract.**

   [Design §5](docs/designs/0002-staff-auth.md:58) stores email index key wrapped in `core.data_key`. Hook and activation need that key to compute `bi_email` ([lines 23–25](docs/designs/0002-staff-auth.md:23)). Frozen migration permits `api_rt` to read C2 keys only when `core.is_staff()` is true ([0001_core.sql:753](packages/db/migrations/0001_core.sql:753)). Anonymous hook caller and not-yet-activated user are not staff.

   Scenario: clean instance, first chief confirms email and calls `/me/activate`; API cannot load index key, so activation cannot compute lookup value. Any fix granting anonymous/non-staff key access changes frozen §4.6 access contract.

   Required: define contract-compatible key-loading authority. Likely separate narrowly scoped definer returning only required wrapped index key, reviewed as frozen-contract change, or store index key through another approved secret-store contract.

2. **`core.activate_invitation` does not explicitly enforce `aal2` inside privileged function.**

   Design identifies endpoint caller as `aal2`, but function contract only states invitation/email checks ([line 25](docs/designs/0002-staff-auth.md:25), [lines 64–68](docs/designs/0002-staff-auth.md:64)). Function is `SECURITY DEFINER`, bypassing table RLS. Frozen contract requires API authorization plus database enforcement ([core §9](docs/designs/0001-core-contracts.md:405)).

   Scenario: handler regression accepts an `aal1` JWT; definer inserts `app_user` and bootstrap chief assignment. Password-only caller becomes chief.

   Required inside function: non-null `auth.uid()`, `core.is_aal2()`, no existing `app_user`, invitation binding, and atomic bootstrap guard. Add direct SQL test invoking function with `aal1`; handler-only test is insufficient.

3. **`core.set_user_status` lacks stated database-side chief authorization.**

   Function contract lists only “not self,” target existence, and terminal `removed` ([line 27](docs/designs/0002-staff-auth.md:27)). No stated `core.has_role('chefe_gabinete')` or `core.has_permission('core.staff.manage')` inside definer.

   Scenario: non-chief staff reaches function through a miswired handler and suspends chief. Two suspended colluding users can reactivate each other because only self-change is forbidden.

   Required: definer itself enforces active chief, `aal2`, target transition, and actor binding. Recent-TOTP enforcement also needs database-side definition if “API + database” remains contract.

4. **Bootstrap chief uniqueness is raceable.**

   Command refuses when active chief exists, and activation tests absence of active chief, but no serialization mechanism exists ([lines 21, 25](docs/designs/0002-staff-auth.md:21)). Existing unique index only covers `(user_id, role_id)` ([0001_core.sql:187](packages/db/migrations/0001_core.sql:187)).

   Scenario: operator accidentally creates two bootstrap invitations before either activates. Both activations concurrently observe no chief; both self-grant.

   Required: serialize invitation creation and activation against one stable lock—singleton instance row or transaction-scoped advisory lock—and recheck under lock. Test two concurrent activations.

5. **`aal2` does not establish TOTP-only authentication.**

   Supabase defines `aal2` as any supported second factor, including TOTP or phone OTP—not specifically TOTP. Design checks only “TOTP enabled,” while ordinary reads such as decrypted `GET /staff` accept any `aal2` ([lines 30, 45–52](docs/designs/0002-staff-auth.md:30)). [Supabase MFA documentation](https://supabase.com/docs/guides/auth/auth-mfa) confirms this distinction.

   Scenario: user directly enrolls an allowed phone factor through Supabase APIs, obtains `aal2`, then reads decrypted C2 staff data without TOTP.

   Required: bootstrap must verify TOTP is the only permitted MFA factor, or every authorization boundary—including database `has_role`—must require an approved AMR method. Latter changes frozen `has_role` contract.

6. **`bi_email` classification contradicts frozen contract.**

   New table specifies `bi_email bytea C2` ([line 66](docs/designs/0002-staff-auth.md:66)). Frozen §3 says `bi_` is C1 ([core contract:34](docs/designs/0001-core-contracts.md:34)); existing `app_user.bi_email` is C1 ([Appendix A](docs/designs/0001-core-contracts.md:550)).

   Scenario: migration follows design and CI classification differs from frozen dictionary; following frozen rule instead means implementation drifts from reviewed design.

   Required: change invitation `bi_email` to C1 or formally reopen/version frozen contract.

## Should-fix

1. **MFA reset needs fail-closed recovery.** Old signed `aal2` JWT remains usable until expiry even after session/factor state changes unless application checks live session state. Scenario: stolen token remains usable for up to 15 minutes after “reset MFA.” Suspend user before reset, revoke sessions, reenroll, then explicitly reactivate.

2. **Hook must specify raw-body verification and Supabase response shape.** Standard Webhooks signature covers exact raw body. Supabase requires JSON responses and gives HTTP hooks a total 5-second budget with limited retry behavior. Scenario: framework parses and reserializes JSON; all valid signups fail. Specify raw bytes, official library, no redirects, JSON success/error form, bounded DB timeout. [Supabase Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks), [Before User Created example](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook).

3. **Use `webhook-id` replay handling or state why replay is harmless.** Five-minute tolerance is correct in Standard Webhooks libraries, but timestamp verification alone allows replay inside window. Scenario: captured signed request is replayed repeatedly, causing DB/API load. [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md).

4. **Recent-auth predicate needs exact semantics.** Require most recent `amr` entry with `method = 'totp'`, numeric timestamp, not unreasonably future-dated, and age ≤15 minutes. Supabase documents `amr` objects and `totp`; current Auth source derives timestamps from persisted session claims, so token refresh does not reset TOTP time. [JWT claims reference](https://supabase.com/docs/guides/auth/jwt-fields), [Supabase Auth session source](https://github.com/supabase/auth/blob/master/internal/models/sessions.go).

5. **JWKS cache behavior needs bounds.** Asymmetric JWKS and unknown-`kid` refresh are sound, but design lacks algorithm allow-list, refresh cooldown, outage behavior, and revoked-key eviction. Scenario: attacker floods random `kid` values, forcing outbound JWKS fetches. [Supabase JWT documentation](https://supabase.com/docs/guides/auth/jwts), [signing-key guidance](https://supabase.com/docs/guides/auth/signing-keys).

6. **Session timeout wording is inaccurate.** Inactivity timeout is checked at refresh, not proactively; effective access can last timeout plus JWT lifetime. Feature is Pro-plan-only. Say “≤12 h plus at most 15 min,” and make plan dependency explicit. [Supabase session documentation](https://supabase.com/docs/guides/auth/sessions).

7. **Bootstrap settings audit lacks authority model.** Design says `mandato bootstrap` verifies Auth hook, email confirmation, MFA, session and password settings, but says neither how it reads hosted Auth configuration nor what operator credential authorizes that read. This must not silently introduce `service_role` into runtime.

8. **“Unique among open invitations” needs implementable SQL.** PostgreSQL partial unique predicate cannot use volatile `now()` for expiry. Scenario: expired invitation blocks re-invite, or attempted migration fails. Define uniqueness as `used_at is null`, add explicit cancellation, or maintain immutable open-state column.

9. **Activation input must be explicitly server-derived.** Specify empty request body or reject identity fields. Scenario: future handler accepts client-provided `bi_email`/ciphertext and activates against another invitation.

10. **`GET /api/v1/staff` needs frozen pagination shape.** Apply `?cursor=&limit=` and `{data,next_cursor}` from [API conventions](docs/api-conventions.md:46).

## Notes

- Before User Created HTTP hook, signed through Standard Webhooks, and `user.email` availability are verified. Five-minute signature tolerance matches official Standard Webhooks libraries.
- TOTP challenge/verify upgrading session to `aal2` is verified. `amr` structure, `totp` method, timestamps, and most-recent-first ordering are verified.
- Asymmetric signing keys and project JWKS are verified. JWKS contains no keys when project still uses legacy symmetric signing.
- JWT expiry, inactivity timeout, email confirmation, and configurable minimum password length are verified. Inactivity enforcement timing and Pro-plan restriction must be reflected.
- Immediate suspension works at database authorization layer because frozen `has_role` joins current `app_user.status`; stale JWT alone does not preserve role access.
- Could not verify from Supabase documentation that one bootstrap command can read every listed hosted-project setting using credential model allowed by this design.
- Could not verify exact Management API fields or permissions needed for hook URL/secret inspection.
- No files modified; no runtime tests run. Review covers design and frozen artifacts only.