# Stage 3 brief: cross-provider code review of E0.5 (Codex, reviewer of record)

Executor of the code: Claude. Reviewer: Codex via `codex exec` in a read-only sandbox, on VPS-Líbano, in
`~/Produtos/App-Dra.Mayra/mandato-framework`. The review is adversarial: find ways to break it, not style.

## Steps for the session on the VPS

1. `git fetch origin claude/project-thread-uxtp45 && git checkout claude/project-thread-uxtp45 && git pull --ff-only`
2. Run, from the repository root:
   `codex exec --sandbox read-only "$(sed -n '/^## Prompt for Codex/,$p' docs/designs/egm/0002/stage3-code-review-brief.md)" > /tmp/stage3-codex-code.md`
3. Save the report verbatim as `docs/designs/egm/0002/stage3-codex-code.md`, with this first line:
   `<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->`
   and rewrite absolute local paths to repo-relative ones (nothing else).
4. `git add docs/designs/egm/0002/stage3-codex-code.md && git commit -m "E0.5 code review (Codex)" && git push origin claude/project-thread-uxtp45`

## Prompt for Codex

You are the security reviewer of record for E0.5 (staff authentication) of an AGPL framework for parliamentary offices.
Design: `docs/designs/0002-staff-auth.md` (read §3–§9 and §13; the design was already reviewed in stage 1 and 2, do not
re-review the design). Contract: `docs/designs/0001-core-contracts.md` §4.1, §4.4–§4.6. Review ONLY the code of
commits `a310e6b..HEAD` on this branch:

- `packages/db/migrations/0003_core.sql` (definer functions, policies, grants) and its tests in `packages/db/test/run.sh`
- `packages/crypto/src/envelope.js`
- `packages/core-api/src/*.js` (JWT verification, request runner, key ring, handlers, sign-up hook, operator commands)
- `packages/core-config/bin/mandato.js` (new operator commands)
- tests: `tests/envelope.test.js`, `tests/core-api.test.js`, `packages/core-api/test/api-pg.test.js`

Look for, in this order:
1. Authorization bypass: any path where a caller without aal2-with-TOTP, without chefe_gabinete, with a stale TOTP, or
   suspended gets data or changes state; any definer function that trusts its caller; RLS gaps opened by the new
   `self_read` policies, `my_invitation` or `staff_keys`; self-grant beyond the one bootstrap case.
2. Token verification: algorithm confusion, kid handling, JWKS cache/cooldown/stale logic, issuer/audience, clock.
3. Sign-up hook: signature over the raw body, replay set, in-flight limit, fail-closed paths, anything that lets a
   sign-up through without an open invitation.
4. Keys: AAD construction, key selection by id, active vs decrypt_only, KEK handling, anything that sends key material
   or plaintext to the database or to logs.
5. Personal data: any e-mail or name in errors, logs, audit rows or responses other than GET /me and GET /staff.
6. Concurrency: bootstrap lock, activation races, invitation re-creation.
7. Tests that pass while the property they claim is false.

Output format (Markdown):
- `## Verdict` — one line: number of blockers, should-fix, nits.
- `## Findings` — one numbered item each: severity (blocker | should-fix | nit), `file:line`, the defect in one
  sentence, and a concrete failure scenario (inputs or state → wrong result). Only findings you can tie to a line.
- `## Checked and fine` — short list of what you examined and found sound.
Do not propose rewrites of the design. Do not edit files.
