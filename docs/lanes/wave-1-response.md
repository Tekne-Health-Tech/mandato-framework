# Wave 1 response: what changed for each finding of the Codex review

Answer to `wave-1-review-codex.md` (reviewed at b6ae4de). Every row has a test that failed before the fix and passes now.

| # | Finding | Fix | Test |
| --- | --- | --- | --- |
| 1 | Module migration escapes the owner role; `\i` runs unscreened files | The database decides. `migrator` is no longer a member of `core_owner`; core migrations run at bootstrap as the superuser (they already did). `audit.record_migration` needs the transaction's own migration lease. The runner sends each file through `EXECUTE` with a random dollar-quote tag, so psql never sees a backslash command. `set_config` added to the lint, which stays a lint | `run.sh` "set_config('role','core_owner') from a module migration", "after RESET ROLE … cannot create in core", "… cannot record another migration", "migrator is a member of no core or audit owner role", "a psql backslash command in a migration is not executed", "the backslash command did not run" |
| 2 | Deleted applied migration passes | `migrate` aborts when a recorded migration of core or of an enabled module has no file | `run.sh` "an applied migration whose file was deleted aborts" |
| 3 | Duplicate `short` accepted | `loadTenant` refuses a second module with the same `short` | `config.test.js` "review 3" |
| 4 | Inline credentials accepted | `checkTenant` walks the whole tenant, settings included: a key that names a credential and does not end in `_secret_ref`, or a value shaped like one (auth scheme, PEM private key, common token prefixes, JWT), is an error | `config.test.js` "review 4" |
| 5 | Framework range and dependencies ignored | `requires_framework` checked against contract 0.1.0 (`x.y.z`, `^`, `~`, `>=`; other syntax is an error); `requires_modules` must be enabled in the tenant, `core.*` included | "review 5" |
| 6 | Paths escape their roots | theme, manifest, `settings_schema` and `migrations` must resolve inside the tenant or module directory | "review 6" |
| 7 | Misspelled `--strict` ignored | any other argument is a usage error (exit 2) | "review 7" |
| 8 | Duplicate cause slugs | refused | "review 8" |
| 9 | Malformed font family | `family` now has a grammar: comma-separated quoted names or bare identifiers | `theme.test.js` cases `"` and `foo'bar` |
| 10 | Bad JSON crashes the loader | read and schema-compile errors become validation errors | "review 10" |

Residual, stated in design §7.2: `migrator` is still a member of every module owner role, so a hostile module migration could reach another module's schema (not `core` or `audit`). Closing it needs one login per module migration, which needs credentials in the deployment; it is part of the deployment lane's definition of done.
