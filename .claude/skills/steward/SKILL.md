---
name: steward
description: Rules for PR Steward and /steward watches when fixing checks, conflicts and review comments in mandato-framework.
---

Follow `AGENTS.md`. While fixing a pull request:

- Fix each finding with a test that failed before the fix. Never skip, delete, loosen or quarantine a test, and never edit `tests/fixtures/negative/**` or crypto vectors to make a check pass.
- Do not touch the sensitive paths listed in `.claude/approvals.yml` (CI, `.claude/`, license/CLA files, agent instructions, dependencies, contracts, `packages/db`, crypto). If a fix needs one, stop and comment on the PR explaining what the maintainer must decide.
- Never push to, rebase or delete the `cla-signatures` branch, and never edit `signatures/`.
- Synthetic demo data only. No real names, documents, contacts or clinical data, even in tests.
- Never merge, approve or enable auto-merge. Merging is left to the GitHub ruleset.
- After three fix rounds on the same finding without passing, stop and comment with what is still failing.
