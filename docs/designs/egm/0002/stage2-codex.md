<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

## Verdict

6 blockers closed. 7 of 10 should-fix closed. 3 remain open. No qualifying new finding.

### Blockers

1. **B1 index key access — Closed.** Narrow `core.index_key('bi:email:v1')` definer supplies wrapped key without changing general `data_key` RLS. [§6](docs/designs/0002-staff-auth.md:75)

2. **B2 activation database authorization — Closed.** Definer checks `auth.uid()`, TOTP-backed `aal2`, prior activation, invitation, and bootstrap state under lock. Direct SQL tests specified. [§4](docs/designs/0002-staff-auth.md:35)

3. **B3 status authorization — Closed.** Definer requires chief role, recent TOTP, non-self target, and valid transition. [§4](docs/designs/0002-staff-auth.md:37)

4. **B4 bootstrap race — Closed.** Creation and activation share row lock on `core.instance`; activation rechecks chief absence under lock. Concurrency test specified. [§6](docs/designs/0002-staff-auth.md:70)

5. **B5 `aal2` does not imply TOTP — Closed.** `is_aal2()` now requires `totp` in `amr`; hosted configuration also disables other MFA methods. Contract/test compatibility caveat below. [§3](docs/designs/0002-staff-auth.md:17)

6. **B6 `bi_email` classification — Closed.** Invitation index now C1, matching frozen dictionary. [§6](docs/designs/0002-staff-auth.md:58)

### Should-fix

1. **S1 MFA recovery — Open.** Scenario: sole chief loses TOTP. `set_user_status` forbids self-suspension, no second chief exists, and operator procedure cannot perform required step 1. Stolen JWT remains useful until expiry while reset occurs. Design needs explicit sole-chief recovery with immediate database-side disablement and safe restoration.

2. **S2 raw hook verification/response — Closed.** Raw bytes, official library, exact JSON response, no redirects, timeout, and fail-closed behavior specified. [§5](docs/designs/0002-staff-auth.md:40)

3. **S3 webhook replay — Open.** Scenario: attacker replays captured valid request repeatedly during five-minute window. Each replay consumes API and DB capacity; enough parallel requests exhaust pool and deny legitimate sign-ups. “Only costs a lookup” does not make replay harmless. Add bounded replay cache or endpoint-specific rate/concurrency control.

4. **S4 recent TOTP semantics — Closed.** Most recent TOTP entry, numeric timestamp, 60-second future bound, and 15-minute age defined. [§3](docs/designs/0002-staff-auth.md:23)

5. **S5 JWKS bounds — Closed.** Algorithm allow-list, cache lifetime, unknown-`kid` cooldown, stale-set ceiling, fail-closed behavior, and eviction specified. [§7](docs/designs/0002-staff-auth.md:85)

6. **S6 session wording/plan — Closed.** Correct bound stated as 12 hours plus 15 minutes; Pro dependency explicit. [§8](docs/designs/0002-staff-auth.md:118)

7. **S7 settings authority — Closed.** Operator-only Management API token, endpoint, scope intent, no runtime persistence, and fail-closed field discovery specified. Exact live fields remain implementation validation, not unresolved authority design. [§8](docs/designs/0002-staff-auth.md:113)

8. **S8 invitation uniqueness — Open.** Scenario: bootstrap invitation expires unused. Partial unique index still treats it as open because `used_at` and `cancelled_at` remain null. Bootstrap command refuses existing open invitation—or insertion hits uniqueness—while no bootstrap cancellation path is defined. Expired bootstrap must be cancelled under instance lock before replacement, or operator cancellation must be explicit.

9. **S9 activation input — Closed.** Empty body required; every supplied field rejected. Identity comes from verified JWT. [§4](docs/designs/0002-staff-auth.md:35)

10. **S10 staff pagination — Closed.** Frozen query and `{data, next_cursor}` shape specified. [§7](docs/designs/0002-staff-auth.md:100)

## `is_aal2` narrowing

Yes: it breaks current frozen 0001 tests and narrows frozen behavior.

Current test helper emits only `{"sub": ..., "aal":"aal2"}`, without `amr`. Positive tests for C1 reads, writes, key reads, and chief grants therefore fail after 0003. [Test helper](packages/db/test/run.sh:11), [positive tests](packages/db/test/run.sh:75)

It does not weaken any security guarantee. It strengthens authorization. But frozen 0.1.0 behavior accepted active, assigned users carrying generic `aal2`; TOTP-backed `amr` becomes an additional requirement. Therefore this is intentional breaking contract evolution, not compatible clarification. Contract 0.1.1 must update 0001 history and existing fixtures in same PR, as frozen change control requires. Claim that “every existing 0001 test still passes” is false unless those claims are updated.

## Product-owner decisions

Yes, beyond Pro cost:

- Invite-only sign-up: product onboarding policy.
- TOTP-only: user-visible authentication constraint; security may set minimum, but owner must accept usability/support impact.
- Operator-only lost-TOTP recovery: product and operations decision, especially recovery availability and sole-chief outage.

First-chief self-grant is architecture/security bootstrap detail; no separate product-owner decision needed once invariant and audit behavior are accepted.

Skipped runtime tests and external Supabase API verification; review limited to requested design, frozen contract, migration, and repository tests.