<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

## Blockers

1. **Module migration escapes owner-role boundary** ([migrate.js:27](packages/db/src/migrate.js:27), [migrate.js:102](packages/db/src/migrate.js:102))

   - Failing input:
     ```sql
     select set_config('role','core_owner',true);
     select set_config('search_path','core,pg_temp',true);
     create table escaped(id integer);
     ```
   - Expected: forbidden-statement rejection.
   - Actual: `forbiddenStatements()` returns `[]`. Migration runs inside `migrator` session, which may assume `core_owner`; unqualified DDL then writes into `core`.
   - Same screen accepts `\i /path/unreviewed.sql`, letting `psql` execute unscreened content.

2. **Deleted applied migration bypasses hash verification** ([migrate.js:82](packages/db/src/migrate.js:82), [migrate.js:85](packages/db/src/migrate.js:85), [migrate.js:90](packages/db/src/migrate.js:90))

   - Failing situation: `demo.hello:0001_hello.sql` exists in `audit.migration_log`, then file disappears.
   - Expected: boot aborts because recorded migration has no matching file/hash.
   - Actual: runner iterates only current files, never checks unmatched log entries, returns `migrate: up to date`.

3. **Duplicate module `short` values are accepted** ([load.js:44](packages/core-config/src/load.js:44), [check.js:4](packages/core-config/src/check.js:4))

   - Failing input: enabled `vendor.one` and `vendor.two`, both manifests declaring `"short": "shared"`.
   - Expected: validation error; §7.1 requires uniqueness per instance.
   - Actual: validation checks module IDs only. Bootstrap maps both to `mod_shared_owner` and `mod_shared`, destroying module schema/owner isolation.

4. **Inline credentials remain valid tenant data** ([load.js:33](packages/core-config/src/load.js:33), [check.js:4](packages/core-config/src/check.js:4))

   - Failing input:
     ```yaml
     connectors:
       - source_id: example
         schedule: "0 0 * * *"
         params:
           authorization: "Bearer SYNTHETIC_NOT_A_SECRET"
     ```
   - Expected: rejection; §5 requires every credential through `*_secret_ref`.
   - Actual: schema and semantic checks accept it. Confirmed schema result: valid. Public config can therefore contain credentials under names not ending in `secret`, `token`, `password`, or `api_key`.

## Should-fix

5. **Framework compatibility and enabled dependencies are not validated** ([load.js:52](packages/core-config/src/load.js:52), [migrate.js:42](packages/db/src/migrate.js:42), [migrate.js:59](packages/db/src/migrate.js:59))

   - Failing input: manifest declares `"requires_framework": "^99.0.0"` or `"requires_modules": ["core.missing"]`.
   - Expected: validation/migration abort per §7.2.
   - Actual: framework range is ignored; every `core.*` dependency is treated as satisfied without checking tenant modules.

6. **Config paths escape tenant/module roots** ([load.js:36](packages/core-config/src/load.js:36), [load.js:57](packages/core-config/src/load.js:57), [migrate.js:48](packages/db/src/migrate.js:48))

   - Failing inputs: `theme: ../outside/tokens.json`, `settings_schema: ../../outside.json`, or `migrations: ../../outside-migrations`.
   - Expected: reject paths outside config/module package.
   - Actual: `join()` resolves and reads—or executes migrations from—outside declared roots.

7. **Misspelled `--strict` silently disables production validation** ([mandato.js:8](packages/core-config/bin/mandato.js:8), [mandato.js:20](packages/core-config/bin/mandato.js:20))

   - Failing command: `mandato validate tenants/demo --strcit`.
   - Expected: usage error, exit 2.
   - Actual: exit 0; pending modules/connectors remain non-errors.

8. **Duplicate cause slugs pass validation** ([check.js:4](packages/core-config/src/check.js:4))

   - Failing input: two `causes[]` entries with identical `slug`.
   - Expected: invalid tenant because both become `core.cause` rows.
   - Actual: `checkTenant()` performs no cause uniqueness check; failure moves to later DB synchronization.

## Notes

9. **Malformed font-family strings still pass schema** ([tokens.schema.json:30](packages/core-theme/schema/tokens.schema.json:30))

   - Failing input: `"family": "\""` or `"family": "foo'bar"`.
   - Expected: schema rejection.
   - Actual: accepted; generated CSS contains malformed declaration such as `--font-body: ";`.

10. **Invalid referenced JSON crashes loader instead of returning validation errors** ([load.js:14](packages/core-config/src/load.js:14), [load.js:39](packages/core-config/src/load.js:39), [load.js:52](packages/core-config/src/load.js:52), [load.js:57](packages/core-config/src/load.js:57))

   - Failing input: malformed theme, module manifest, or settings-schema JSON.
   - Expected: `{ config, errors, pending }` with validation error.
   - Actual: uncaught `JSON.parse`/AJV compilation exception and CLI stack trace.

Verdict: blocked by 1–4. Node suite passed 55/55; tests do not exercise these inputs.