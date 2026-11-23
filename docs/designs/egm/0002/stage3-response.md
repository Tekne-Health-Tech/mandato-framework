# Stage 3 response: fixes for the Codex code review (`stage3-codex-code.md`)

Fixed in `a53c38a`. Each fix comes with a test that failed on the reviewed commit (`1695ae6`) and passes now.

| # | Finding | Fix | Test (failed before) |
| --- | --- | --- | --- |
| 1 | blocker: `self_read` lets a suspended or removed user read their own profile | `0003_core.sql` (not yet shipped): `self_read` on `app_user` requires `status = 'active'`; on `role_assignment` it requires the caller's own active row. `GET /me` then answers `404 not_active`. | `run.sh`: "a suspended user reads not even their own row", "... nor their own role assignments"; `api-pg.test.js`: suspended member gets 404 on `GET /me` |
| 2 | should-fix: hook budget starts only at the lookup | `hook.js`: one budget (4 s) covers body read, signature check and lookup; the in-flight slot is freed when it expires | `core-api.test.js`: four bodies that never finish are refused and the slots are free again |
| 3 | should-fix: concurrent verifications on JWKS cold start | `jwt.js`: a request first awaits any fetch already running | `core-api.test.js`: two concurrent verifications on cold start both pass, with one fetch |
| 4 | should-fix: concurrent deliveries of one `webhook-id` all reach the database | `hook.js`: the pending decision is stored before the lookup and shared; it is dropped on failure so a retry is looked up again | `core-api.test.js`: three concurrent deliveries of one id, one database connection |

Suites after the fixes: `pnpm test` 94/94, `packages/db/test/run.sh` 157/157, `tsc` clean, grant matrix unchanged.

Note on the reviewer's run: the sandbox had no `node_modules`, so Codex could not execute the suites; CI runs them on every push.
