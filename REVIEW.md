# Review guidance (Claude Code Review)

Read `AGENTS.md` first; its hard rules are review criteria. Flag as **Important**:

1. **Data.** Any real mandate content, personal data (names, CPF, phone, e-mail, address), clinical data, secrets or tokens in code, fixtures, docs or test data. Only the fictitious demo mandate is allowed.
2. **Dependency direction.** Imports or names of `mandato-pro` or a mandate config repo; closed functionality not going through the published extension points.
3. **Licenses.** A new dependency outside the CI allow-list, or copied GPL/LGPL/AGPL code.
4. **Zero-knowledge.** A server path that can see decrypted content; weakened envelope encryption or key handling.
5. **AI boundary.** AI prompts, analytics rules or knowledge curation landing here (they belong to `mandato-pro`); AI output written without the review/audit trail ("app proposes, the physician/parliamentarian decides").
6. **Tests weakened to pass.** Deleted, skipped or loosened assertions, changed expected vectors, or negative fixtures edited, without a stated reason in the PR.
7. **Contract drift.** Changes to frozen contracts (E0.0) without a referenced backbone decision.

Do not flag style preferences that the linters and tests don't enforce.
