# Agent instructions — mandato-framework

This repository is **public** and licensed **AGPL-3.0-only**, copyright Tekne Health Tech Ltda. Read this file before any change. Planning docs (plan, specs, architecture, backlog, ADRs) live in the private repo `Tekne-Health-Tech/mandato-pro` under `docs/plataforma/`; the relevant ones are ADR-0012 (open core), ADR-0003 (stack), `06-arquitetura.md` and `08-execucao-multiagente.md`.

## Hard rules

1. **Dependency direction.** Nothing here imports, vendors or names `mandato-pro` or a mandate config repo. Closed modules plug in only through the published extension points (`registerModule`, `Connector`, `AiProvider`, `ContentEnricher`, `PublishTarget`, `Screen`/`Route`, `Job`). CI: `scripts/check-boundaries.sh`.
2. **Licenses.** New dependencies must use a license in the allow-list of `.github/workflows/ci.yml` (MIT, Apache-2.0, BSD, ISC, 0BSD, MPL-2.0 and a few equivalent permissive ones). A package outside the list needs a reviewed, commented entry in `allow-dependencies-licenses` (permissive or attribution-only licences only). No third-party GPL/LGPL/AGPL code, copied or linked. CI: dependency review.
3. **Data.** Code, docs and synthetic data of the fictitious demo mandate only. No real mandate content, no personal data, no secrets, no AI prompts or analytical business rules (those belong to `mandato-pro`). CI: gitleaks.
4. **Cut rule.** A component belongs here only if every mandate system would have it, carries no prompt/analytics/knowledge curation, and publishing it does not let anyone assemble a working competitor. When in doubt, it stays closed.
5. **Literals** (paths, commands, config keys, file names) are never translated. Code and code comments in English; user-facing strings in pt-BR via i18n files.

## How work is done

- **Contracts first.** Interfaces and schemas (backlog item E0.0) are frozen before lanes start; changing a contract goes through the architecture backbone, not a lane.
- **Design before code.** Non-trivial work starts with a design doc reviewed with the Elephant-Goldfish method; code that drifts from the reviewed design is flagged in the sprint drift report.
- **Ponytail.** Climb the YAGNI ladder: no abstraction, option or file the current task does not need. Run `/ponytail-review` on your diff before opening a PR.
- **Cross-provider review.** The reviewer runs on a different AI provider than the executor. Security-sensitive changes (auth, RLS, crypto, audit) get two reviewers.
- **Definition of done** is verified by someone who did not execute the task. An agent never certifies its own work as done.
- Branch per task, draft PR, CI green before review.
