# Review gate and auto-merge

How a pull request reaches `main` in this repository.

1. An agent opens a draft PR from a branch of this repository.
2. When the PR is marked ready, two workflows run from `main` (never from the PR):
   - `Claude review gate` (`.github/workflows/claude-review.yml`): Claude reviews the diff against `REVIEW.md` and `AGENTS.md` and posts inline comments. The check passes only with zero Important findings and no sensitive path touched.
   - `Auto-merge` (`.github/workflows/auto-merge.yml`): turns on GitHub auto-merge (squash).
3. The `main` ruleset requires the CI checks and `Claude review gate`. GitHub merges as soon as all of them are green.
4. A PR that touches a sensitive path, comes from a fork, or has an Important finding stays open. The maintainer reads it and merges with the ruleset's admin bypass, or an agent fixes the finding and pushes again.

Sensitive paths: CI, `.claude/`, `REVIEW.md`, agent instructions, license/CLA files, dependency manifests, `scripts/`, `packages/core-contracts/`, `packages/db/`, crypto, negative test fixtures and `signatures/`. The list lives in the gate workflow and in `.claude/approvals.yml`.

To stop automatic merging at once: disable the `Auto-merge` workflow in the Actions tab. To cancel it on one PR: `gh pr merge --disable-auto <number>`. To undo a merge: revert the merge commit in a new PR.
