# Stage 0 — Scope and method

- **Design under review:** `docs/designs/0001-core-contracts.md` (Design 0001 — Core contracts, backlog E0.0), commit `328d1e0`.
- **Date:** 2026-11-14
- **Mode:** uninterrupted (no checkpoints with the author between stages).
- **The design document was not modified.** Every output of this review is in `docs/designs/egm/0001/`.

## How this run differs from the plugin

The repo pins the Elephant-Goldfish plugin (`egm@egm`, ref `v0.1.1`) in `.claude/settings.json`. In this session the plugin did not load, because the workspace is untrusted and its `permissions.allow` entries are ignored (run log kept outside the repo). So `/egm:egm-review` could not run as a command. This review follows the same method by hand:

| Role | Who | Context |
| --- | --- | --- |
| Elephant (keeps context, consolidates) | the orchestrating agent | the design, AGENTS.md, and repo history |
| Goldfish (fresh context, one lens each) | 5 independent subagents | only the files in this repo; no private planning docs; no shared notes between them |
| Verifier (adversarial) | 1 fresh subagent | the design and the stage 1 reports; tries to refute each finding |

The plugin's own reviewer prompts and severity rubric were not available, so this report uses its own rubric: **blocker** (the contract cannot be frozen as written), **major** (lanes will diverge or rework is likely), **minor** (clarify before or during the freeze), **nit**.

## Stages

1. **Stage 1 — Goldfish reviews**, run in parallel:
   - `stage1-goldfish-security-privacy.md`: RLS, audit, encryption, AI guard, LGPD
   - `stage1-goldfish-data-model.md`: Postgres/Supabase schema design
   - `stage1-goldfish-extension-contracts.md`: extension points, open-core boundary, versioning
   - `stage1-goldfish-sync-publish-api.md`: offline sync, bundles, tokens, API conventions
   - `stage1-goldfish-clarity-yagni.md`: whether the doc stands on its own, internal consistency, YAGNI
2. **Stage 2 — Adversarial verification** (`stage2-verification.md`): each finding gets a verdict of CONFIRMED, PLAUSIBLE, or REJECTED, and duplicates are merged.
3. **Stage 3 — Consolidated report** (`REPORT.md`): deduplicated findings ranked by severity, answers to the design's §6 open questions, and the minimum changes needed before E0.0 can be frozen.

## Constraints on the reviewers

- This is a public AGPL-3.0 repo (AGENTS.md). Reviewers saw only synthetic or public material. No real mandate data, personal data, prompts, or closed-module content went into any prompt or report.
- The reports avoid the literal strings that `scripts/check-boundaries.sh` rejects, so committing them keeps CI green.
- Reviewers report findings and recommendations only. Applying them is up to the design owner (the architecture backbone), in line with "contracts first".
