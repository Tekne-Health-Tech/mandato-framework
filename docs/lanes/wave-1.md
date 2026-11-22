# Wave 1 (E0.2, E0.3, E0.4)

Built on the accepted E0.0 contracts. Executor and reviewer are always different providers.

| Item | Executor | Reviewer | What it delivers |
| --- | --- | --- | --- |
| E0.2 `tenant.yaml` | Claude | Codex | `packages/core-config/src/load.js` (schema, semantic checks, theme contrast, local modules and their settings), `mandato validate <dir> [--strict]` |
| E0.3 theme | Codex | Claude | tokens → CSS custom properties (light, dark, `data-theme`) and a React Native object; build refuses a theme that fails contrast |
| E0.4 database | Claude | Codex | `mandato bootstrap` / `mandato migrate`: module owner roles and schemas, forward-only migrations under a migration lease and the module owner role, hash check against `audit.migration_log`, static screening of forbidden statements |

Decisions taken in this wave (technical, open to veto):
- **No feature flags in E0.2.** Design §5 removed `flags` from v1 until a flag has defined behaviour; the backlog line predates that.
- **Policy tests stay in `packages/db/test/run.sh`, not pgTAP.** The audit actor is derived from `session_user`, and pgTAP runs inside one session, so it cannot prove what each login role can do. The suite logs in as each runtime role instead (86 checks).
- **Unfinished framework parts are "pending", not errors.** `core.content`, `core.agenda` and the `ibge-municipios` connector arrive in later lanes; `mandato validate --strict` treats them as errors and is what production boot will use.
- **Gemini is out of budget**, so lane B runs with Codex executing and Claude reviewing.
