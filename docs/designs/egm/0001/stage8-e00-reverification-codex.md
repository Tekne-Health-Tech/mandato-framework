<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

## Previous blockers

1. Projection validation: **closed**. Database permission check covers C2+ columns and whole-row access.
2. Static provider checks: **not closed**. `from ... import EchoProvider as E; E().generate(...)` passes [check-ai-boundary.sh](scripts/check-ai-boundary.sh:18) with exit 0.
3. PostgREST fail-closed: **not closed**. Migration run before `authenticator` exists skips configuration permanently; later PostgREST starts with default exposed schema instead of `api`. CI’s shim has this exact ordering.
4. Pre-existing dangerous role privileges: **not closed**. Attributes and memberships are cleared, but direct grants remain. Pre-existing `worker_c1` with `USAGE` and `SELECT` on `public.secrets` keeps both after [0001_core.sql](packages/db/migrations/0001_core.sql:8).
5. Anonymous `api_rt` access to wrapped C2 keys: **closed**. Policy now requires active AAL2 staff.
6. Arbitrary personal values in `audit.write`: **not closed**. `{"patient":"mariasilva"}` passes identifier regex in [details_ok](packages/db/migrations/0001_core.sql:466) and stores personal plaintext in C1 audit.
7. Signed key revocation ignored: **closed**. Current-key signature, update application, and final revocation now tested.
8. AI guard does not control real calls: **not closed**. Same alias scenario directly invokes provider while static check passes.
9. Local C3 provider with external egress: **closed** for specified scenario; schema and runtime guard reject `api.external.example`.
10. Negative projection tests only names: **closed**. Database privilege check now exercises whole-row leak.
11. Revoked-key test bypasses signed rotation: **closed**. Test now performs signed update sequence.

## New blocker

- Provider failure leaves no provenance. [AiGateway.generate](workers/core/contracts/ai.py:141) calls provider before provenance writer. Reproduced: provider received C2 input, raised `RuntimeError`, provenance list remained empty. Violates §7.5 requirement that every provider-reaching call records provenance.

Notes: `pnpm test`, 16 Python tests, TypeScript compile, static positive/negative checks, and `git diff --check` passed. DB suite not rerun: script drops `mandato_test` and mutates persistent roles; escalation rejected as unsafe. Deferred should-fixes not reopened.

E0.0 not accepted