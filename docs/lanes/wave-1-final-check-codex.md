<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

1. **Item 1 — Closed.** `bootstrap` applies `0002_core.sql`, which revokes `core_owner` from `migrator` before module migrations run.

4. **Item 4 — Closed.** Loader validates installed connector params against connector schema; `--strict` rejects connectors lacking installed schema. Heuristic remains lint as accepted.

6. **Item 6 — Open.** Concrete failing input: make `tenant/modules/hello` a symlink to an external directory containing valid module files. `loadTenant()` returns no errors because `modDir` itself becomes comparison root at [load.js:73](packages/core-config/src/load.js:73).

New upgrade finding — **Open.** Concrete failing input: database that already recorded `0001_core.sql` from `2490df6` has hash `38177b…`; current file has `3e9c3d…`. After upgrade, `mandato migrate` still fails at [migrate.js:119](packages/db/src/migrate.js:119) with `migration core:0001_core.sql changed after it was applied`.