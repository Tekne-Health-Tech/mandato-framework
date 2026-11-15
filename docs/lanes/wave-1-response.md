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

## Re-check (`wave-1-recheck-codex.md`, at 2490df6): 3 open, 1 new

| # | Finding | Fix | Test (failed before, passes now) |
| --- | --- | --- | --- |
| new, and 1 on existing instances | 2490df6 edited `0001_core.sql`, which is recorded by hash, so an instance built before could neither upgrade nor lose `migrator`'s `core_owner` membership | `0001_core.sql` is back to the version merged on `main`, byte for byte. The change ships as `0002_core.sql`: revoke `core_owner` from `migrator`, `record_migration` with the lease check, `migrator_read`. `mandato bootstrap` applies every core migration not yet recorded, as the superuser, in one transaction that also records it (as `migrator`, under a migration lease). `mandato migrate` refuses a core migration bootstrap has not applied | `run.sh` "upgrade of an instance built before 0002": 0001 only, then `migrate` refuses, `bootstrap` applies 0002, membership gone, `migrate` applies modules, a second run changes nothing |
| 4 | `key` not caught | the heuristic also covers `key`, `key_*`, `*_key`, `pin`, `signature`, `salt` (public-key fields of `publish_keys` excepted). It stays a lint: the boundary is each connector's `params` schema, which the connector lane delivers with `additionalProperties: false`; the loader validates `params` against it, and `--strict` (production boot) refuses a connector without one | `config.test.js` "re-check 4" |
| 6 | symlinks escape the root | `inside()` also compares real paths once the target exists | "re-check 6" (outside link refused, inside link accepted) |

## Final check (`wave-1-final-check-codex.md`, at f0fd880): 1 and 4 closed

| # | Finding | Answer |
| --- | --- | --- |
| 6 | a module directory symlinked outside the tenant passed | fixed: the module directory itself must resolve inside the tenant. Test `config.test.js` "final check 6" failed before |
| upgrade | a database that recorded 0001 at the intermediate commit 2490df6 cannot migrate | accepted, not a defect: 2490df6 never reached `main`, and only throwaway test databases were built from it. `0001_core.sql` is byte-identical to `main` again, so every database built from a released commit upgrades through 0002 (test "upgrade of an instance built before 0002") |

Stopping rule: the review loop ends here. The last fix (item 6) is covered by its test and CI; the next wave's review reads it.
