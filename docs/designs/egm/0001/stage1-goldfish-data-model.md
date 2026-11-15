# Stage 1 — Goldfish review: data model & SQL

Design under review: `docs/designs/0001-core-contracts.md` (draft, 2026-11-14).
Reviewer lens: database and data model on Supabase Postgres (§3.3, and its interaction with §3.4 and §3.6; §6 Q1).
Reviewer context: fresh. Only `AGENTS.md` and the design doc were read. Anything not written in them is treated as a gap.

## Summary

§3.3 states sound intentions (schema isolation, RLS deny-by-default, append-only audit, classification in the catalog), but as a *frozen contract* it is not yet implementable by independent lanes. The biggest problems:

1. The table columns are defined by reference to a private document ("platform data model (03)") that the public repo and its lanes cannot see, so the core SQL contract does not actually exist in this repo (DB-1).
2. `core_api` views are the only sanctioned path from modules into `core`, but nothing says they are `security_invoker`. On Supabase, views created by `postgres` bypass RLS by default, which turns `core_api` into a hole in deny-by-default (DB-2).
3. The module id to schema name mapping is undefined for dotted ids, and the boundary between "core tables" and "core modules" (`core.content` vs `core.content_item`) is ambiguous (DB-3).
4. Module migrations have no defined runner, ordering, tracking, DB role or rollback, and nothing enforces the rule that modules may only touch `core` through FKs and `core_api` (DB-4).
5. `has_role` will recurse when used on `role_assignment`, does not account for `aal2`, and the audit trigger has no actor source for workers or the service role (DB-5, DB-6).

Most fixes are small text additions to §3.3. DB-1 and DB-2 should be resolved before the contract is frozen.

## Findings

| ID | Severity | Confidence | Section | Claim |
| --- | --- | --- | --- | --- |
| DB-1 | blocker | high | §3.3 Tables | Columns are specified only by reference to a private document, so the public contract is not self-contained and lanes cannot implement or mock it. |
| DB-2 | blocker | high | §3.3 Schemas, RLS | `core_api` views are unspecified; with Supabase defaults they run as `postgres` and bypass RLS on `core` tables. |
| DB-3 | major | high | §3.3 Schemas, §3.4 manifest | `mod_<module_id>` is undefined for dotted ids and is ambiguous for `core.*` modules whose tables already live in `core`. |
| DB-4 | major | high | §3.3, §3.4 `migrations` | Module migrations have no runner, ordering, version tracking, owning role or rollback, and the module/core access rule is unenforceable. |
| DB-5 | major | high | §3.3 RLS | `core.has_role` will hit RLS recursion on `role_assignment`, lacks a performance pattern, and ignores the `aal2` requirement from §3.7. |
| DB-6 | major | high | §3.3 Audit | Audit triggers have no defined `actor_id` source for workers, service role or migrations, and "append-only" does not bind the table owner. |
| DB-7 | major | medium | §3.3 Roles, §3.4 | Roles as data has no namespace, no lifecycle on module disable/removal, and the manifest's `permissions` have no table to live in. |
| DB-8 | major | high | §3.3 Classification, §3.6 | Classification is table-level plus prefixed columns only, but `core-publish` filters by column class; unprefixed columns have none, and `auth.*` is outside the check. |
| DB-9 | minor | medium | §3.3 Ids, §3.6, §3.7 | `core.uuid7()` needs a defined implementation for PG 15/17 on Supabase, and its timestamp is exposed in C0 bundles. |
| DB-10 | minor | high | §3.3, §3.7 | `municipality` keyed by IBGE code conflicts with the "uuid `id` everywhere" assumptions of FKs, audit `entity_id` and §3.3 Ids. |
| DB-11 | minor | high | §3.3, §3.6 | Delta sync needs `updated_at` and soft-delete tombstones on every published table, but §3.3 defines no such column convention. |
| DB-12 | minor | high | §3.3, §2, §3.2 | The singleton `instance` row is not enforced, and its relation to `tenant.yaml` (source of truth, sync) is unstated. |
| DB-13 | nit | high | §3.2, §3.3 | `cause` vs `theme` naming is inconsistent: `tenant.yaml` comment still says "drives `theme` rows". |

## Detailed findings

### DB-1 — Core table columns live in a document outside this repo (blocker, high)

**Section:** §3.3 "Tables in 0001 … Columns as in the platform data model (03)".

**Problem.** `AGENTS.md` says planning docs live in a private repo. The "platform data model (03)" is therefore invisible to this public repo, to outside contributors, and to any goldfish reviewer. §1 says the purpose of this design is to *freeze* contracts so that eleven lanes can work against mocks. A contract whose columns are elsewhere is not frozen here. It also cannot be reviewed for classification: §3.3 requires every `pii_`/`phi_`/`piim_`/`enc_` column to be classed, but the reviewer cannot see which columns exist. AGENTS.md rule 3/4 also means the private doc may contain material that must not be copied verbatim. Someone has to decide what part becomes public.

**Failure scenario.** The database lane writes `content_item` from the private doc. The publish lane, which may run on a different provider with no private-repo access, mocks `content_item` from §3.6 alone (`id`, `updated_at`, `deleted`). The column names diverge (`deleted` vs `deleted_at`, `title` vs `headline`), and the mismatch only surfaces at integration, which is the cost §1 says this design exists to avoid.

**Recommendation.** Put the column list for all 17 tables in this repo, either in the design or as `packages/db/migrations/0001_core.sql` in draft, reviewed as part of this design. For each table give: name, PK type, class (C0–C3), columns with type and class, FKs, and which roles get select/insert/update. Drop the reference to (03), or keep it only as non-normative history.

### DB-2 — `core_api` views bypass RLS unless declared `security_invoker` (blocker, high)

**Section:** §3.3 Schemas ("the views in `core_api`") and RLS.

**Problem.** `core_api` appears once and is never defined: no view list, no columns, no owner, no grants. By default a Postgres view runs its underlying table access with the **view owner's** privileges and RLS context. On Supabase, migrations run as `postgres`, which owns the `core` tables and is not subject to their RLS (owner, no `FORCE ROW LEVEL SECURITY`). So any view in `core_api` created the usual way returns **all rows** to anyone who can select from it, whatever the RLS on the base table says. That silently undoes "RLS enabled on every table, deny by default". Postgres 15+ supports `WITH (security_invoker = true)`, and Supabase's own linter flags such views ("security definer view").

**Failure scenario.** `core_api.app_user` is created to let modules show names next to records. A module's RLS-guarded screen joins it. A user with only `operador` reads the view through PostgREST or a module query and gets every staff row, including any `pii_` columns, because the view ran as `postgres`.

**Recommendation.** In §3.3, state that:
- Every view in `core_api` is created `WITH (security_invoker = true)` (plus `security_barrier` where it filters), and a CI check fails on any view in `core_api` or `mod_*` without `security_invoker`.
- `core_api` lists its views and their columns, classed like tables (see DB-8). By default it exposes only `id` plus C0/C1 columns.
- Base tables use `ALTER TABLE … FORCE ROW LEVEL SECURITY` where the owner role could otherwise read through, or ownership goes to a dedicated non-login role (see DB-4).

### DB-3 — Module id to schema name mapping is undefined (major, high)

**Section:** §3.3 Schemas; §3.4 manifest (`"id": "pro.secretaria"`); §3.2 (`core.content`, `core.agenda`).

**Problem.**
1. Ids contain dots. `mod_pro.secretaria` is a legal identifier only when double-quoted (`"mod_pro.secretaria"`), and quoting everywhere breaks tools, `search_path` strings and PostgREST's `db_schemas` list. A naive `replace('.', '_')` gives `mod_pro_secretaria`, which collides: `a.b_c` and `a_b.c` both map to `mod_a_b_c`. Postgres also truncates identifiers at 63 bytes without raising an error, so two long ids can silently share a schema.
2. Several of the `core.*` modules in §3.2 (`core.content`, `core.agenda`) have their tables (`content_item`, `content_version`, `agenda_event`) in **schema `core`** under §3.3. Does `core.content` get a `mod_core_content` schema too? Is it a module or part of the framework? The manifest schema then has to say whether `core.*` modules may declare `migrations`.
3. The demo module id `demo.hello` (§4) shows the namespace is open-ended, but no id grammar is given anywhere.

**Failure scenario.** Two closed modules, `pro.cap_tura` and `pro_cap.tura` (or simply long ids sharing a 63-byte prefix), install into the same schema. The second migration fails on a `CREATE TABLE` conflict, or worse, succeeds with `IF NOT EXISTS` and writes into the other module's table.

**Recommendation.** Add to `module.schema.json` an id grammar such as `^[a-z][a-z0-9]{1,15}(\.[a-z][a-z0-9]{1,30})+$` (no underscores inside segments). Then define schema name = `mod_` + id with `.` replaced by `_`. That makes the mapping injective and keeps it under 63 bytes. Store the derived name in `core.module_registry.db_schema`, unique. State that `core.*` modules ship their tables in `core` (or move `content_*`/`agenda_event` into their module schemas), but not both.

### DB-4 — Module migrations: no runner, ordering, ownership or enforcement (major, high)

**Section:** §3.3 Schemas ("may only reference `core` tables through foreign keys to `id` columns and the views in `core_api`"); §3.4 manifest `"migrations": "migrations/"`, `"requires_framework": "^0.1"`.

**Problem.** The design does not say:
- **Who applies** module migrations. The Supabase CLI tracks one linear directory in `supabase_migrations.schema_migrations`, so a set of per-module directories needs its own runner. Is it the boot sequence, a CI deploy step or a CLI?
- **Ordering**: module migrations must run after the core migrations they depend on. `requires_framework: ^0.1` is a package semver, not a schema version, so a module could run against a database where the core migration it needs has not been applied yet.
- **Tracking**: no per-module applied-version or checksum table. `core.module_registry` exists but has no columns specified (DB-1).
- **Rollback / disable**: what `enabled: false` in `tenant.yaml` does to the schema (keep data, revoke grants, drop?). There is no statement that migrations are forward-only.
- **DB role**: if module SQL runs as `postgres`, a closed module can `ALTER POLICY` on `core` tables, `GRANT` itself anything, or create `SECURITY DEFINER` functions. The rule "only through FKs and `core_api`" is then advisory. Also, FK constraint checks run without RLS, so a module can probe for existence of any `core` id. This is acceptable, but should be stated.

**Failure scenario.** A closed module's migration `0003` adds a policy on `core.app_user` to make its own screen work. CI in this repo never sees it, because the code is closed. The audit trigger and the deny-by-default guarantee are changed in production with no review in the public contract.

**Recommendation.** Specify:
- One runner (`packages/db` CLI) that applies `core` first, then each enabled module in dependency order, recording `(module_id, version, checksum, applied_at)` in a `core.schema_migration` table. Migrations are forward-only, and a checksum mismatch aborts boot.
- Manifest field `requires_core_schema: <int>`, checked before applying.
- Each module's DDL runs under `SET ROLE mod_<x>_owner`. That role owns `mod_<x>`, has `USAGE` on `core_api` and `REFERENCES (id)` on the `core` tables listed in the manifest, and has nothing else on `core`. This makes the access rule enforceable.
- Disable = revoke the module's grants to `authenticated` and stop its jobs, with data kept. Removal is an explicit, separate, audited operation.

### DB-5 — `has_role`: recursion, performance and the missing `aal2` check (major, high)

**Section:** §3.3 RLS; §3.7 Auth ("staff sessions require a second factor claim (`aal2`)").

**Problem.**
1. **Recursion.** `role_assignment` has RLS enabled. Its own policy will naturally be something like "a `chefe_gabinete` can see all assignments", i.e. `using (core.has_role('chefe_gabinete'))`. If `has_role` is `SECURITY INVOKER`, it reads `role_assignment`, which evaluates that policy, which calls `has_role` again, and Postgres raises `infinite recursion detected in policy`. The function must be `SECURITY DEFINER`, owned by the table owner, with `SET search_path = ''`. The design does not say so.
2. **Performance.** As a plain `STABLE` function called per row, `has_role` runs a subquery per row scanned. The pattern Supabase documents is `using ((select core.has_role('x')))`, so the planner evaluates it once as an initPlan, plus an index on `role_assignment(user_id, role)`. Without it, a 100k-row `audit_event` listing does 100k lookups.
3. **`aal2`.** §3.7 requires a second factor for staff, but if that is only enforced in Next.js route handlers, any client holding an `aal1` JWT that reaches the database directly (PostgREST, supabase-js on mobile; see Q1) passes RLS. `has_role` reads only `auth.uid()`.
4. **Validity.** No `revoked_at`/`expires_at`, and nothing about roles of disabled modules (DB-7).
5. **`auth.uid()` mapping.** The relation between `core.app_user.id` and `auth.users.id` (same id? FK? on delete?) is not stated.

**Failure scenario.** A staff member's password leaks. The attacker signs in at `aal1`, skips the Next.js app and calls the Supabase REST endpoint with the JWT. `has_role('comunicacao')` returns true and the attacker reads C1/C2 tables, despite the documented 2FA requirement.

**Recommendation.** Specify `core.has_role(role text) returns boolean language sql stable security definer set search_path = ''`. It returns true only if a non-revoked, non-expired assignment exists for `auth.uid()` **and** `(auth.jwt() ->> 'aal') = 'aal2'` for staff roles. Mandate the `(select …)` wrapping in policies, enforced by a lint, and the composite index. State `core.app_user.id = auth.users.id` with an FK `on delete restrict`, and that deletion is handled by an explicit anonymisation process.

### DB-6 — Audit triggers: no actor for non-user writers; append-only is not enforced against the owner (major, high)

**Section:** §3.3 Audit.

**Problem.**
1. **Actor source.** Triggers write `actor_id`, presumably from `auth.uid()`. Python workers, connectors (`upsert(records, tx)`), publish jobs and migrations connect with the service role or a direct DB connection, so `auth.uid()` is NULL. Every machine write is then unattributed, and an attacker who obtains the service key leaves no actor trace.
2. **Append-only.** `revoke update, delete` removes privileges from grantees, but the **owner** (`postgres`) and any role with table ownership can still update, delete or `TRUNCATE`. Supabase's `service_role` also commonly receives broad grants via default privileges.
3. **Scope and volume.** "Row triggers on C1+ tables" covers `data_source_run` and connector-written tables. An IBGE monthly sync upserting thousands of rows yields thousands of audit rows of low value. It is also unclear whether `audit_event` (presumably C1+) audits itself.
4. **`entity_id` type.** If it is `uuid`, tables with natural keys (DB-10) cannot be audited.

**Failure scenario.** A worker job with a bug blanks `content_version` bodies. The audit log shows 300 updates with `actor_id = NULL`, which is indistinguishable from a leaked service key. During the incident review nobody can tell which job or deployment did it.

**Recommendation.** Add `actor_kind` (`user` | `job` | `system`) and `actor_ref text` (job id / connector id) to `audit_event`. The trigger takes `auth.uid()` if present, else `current_setting('core.actor', true)`. The worker `JobContext`/`Tx` must `set_config('core.actor', 'job:<id>', true)` per transaction, and the trigger **rejects** writes from non-`postgres` sessions where neither is set. Add a `BEFORE UPDATE OR DELETE OR TRUNCATE` trigger on `audit_event` that raises, and move ownership to a non-login role. Define bulk connector writes as statement-level audit (one event per run, referencing `data_source_run`). Make `entity_id text` or require uuid PKs everywhere.

### DB-7 — Roles as data: namespace, lifecycle and permissions storage (major, medium)

**Section:** §3.3 Roles; §3.4 manifest `roles`, `permissions`.

**Problem.**
1. **Namespace.** Role ids are bare (`secretaria`, `triagem`). Two independently written modules can both declare `secretaria` with different meanings, and `core.role` PK conflicts at install time, or one module's staff silently gain the other's access.
2. **Lifecycle.** When a module is disabled or removed, its roles have `role_assignment` rows pointing at them. `ON DELETE CASCADE` loses who-had-what history (an LGPD accountability concern). `RESTRICT` blocks removal. Leaving them active means a disabled module's role still satisfies `has_role` in any policy that references it.
3. **Permissions.** The manifest declares `permissions: [{ id: "minutes.approve", roles: [...] }]`, and grants a *core* role a module permission. There is no `permission` or `role_permission` table among the 17. Is enforcement in RLS (by role) or in app code (by permission)? This is unspecified, so modules will implement it differently.
4. **Seeding.** Who inserts manifest roles: the migration runner or boot? Is it idempotent? What happens when a manifest drops a role?

**Failure scenario.** Module A and module B both ship role `encarregado`. B is installed second, `INSERT … ON CONFLICT DO NOTHING` succeeds, and B's RLS policies grant `encarregado` access to B's C3 tables. A's DPO-assistant users, assigned `encarregado` for A's purpose, can now read B's sensitive data.

**Recommendation.** Make `core.role` `(id text pk, module_id text null references core.module_registry, label, active bool)`, with module role ids required to be prefixed by the module id (`pro.secretaria:secretaria`, synthetic). Framework roles keep bare ids. `has_role` ignores inactive roles, module disable sets `active = false`, and FKs are `ON DELETE RESTRICT` (roles are never hard-deleted). Either add `core.permission` / `core.role_permission` tables plus `core.has_permission(text)`, or remove `permissions` from the manifest until it is needed (YAGNI).

### DB-8 — Classification granularity does not match what `core-publish` and `operador` need (major, high)

**Section:** §3.3 Classification, RLS ("`operador` has no select on C3 tables"); §3.6 ("refuses to serialize any column not classed C0").

**Problem.**
1. Only tables and *prefixed* columns carry a class. §3.6 filters by **column** class. An unprefixed column (`title`, `body`, `location`, `notes`) has no column class. Either publish refuses it (nothing ever publishes) or it falls back to the table class, which is not stated. A free-text `notes` column in a C0 table then gets published.
2. The CI rule checks `pii_`/`phi_`/`piim_` against table class, but not `enc_` (a C3 `enc_` column can sit in a C1 table). The `operador` rule is table-level, so `operador` can read the C3 column in that C1 table.
3. Supabase's `auth.users` (email, phone, IP in `auth.audit_log_entries`) is plaintext C2 outside `core`/`mod_*`, so the CI test does not cover it, and §3.3 Encryption ("database never sees keys") gives a misleading picture of where personal data sits.
4. Comment parsing: `COMMENT` is free text, and any later `COMMENT ON` (e.g. a doc generator) silently replaces the class. Views in `core_api` and module views are not covered.
5. `pii_` C2 columns hold application ciphertext, so the database cannot index or uniquely constrain them (e.g. find an `app_user` by e-mail, de-duplicate contacts). No blind-index convention is given, so every lane will invent one.

**Failure scenario.** The content lane adds `content_item.internal_notes text` (unprefixed) to a C0 table. Publish uses table class as fallback, and editorial notes such as "waiting on legal re: ex-staffer" ship to every citizen's phone and to the CDN.

**Recommendation.** Require a class comment on **every** column and every view column (format exactly `class=C[0-3]`, optionally `; ` + free text after, parsed with an anchored regex). CI rules: table class = max of its column classes; `enc_` ⇒ column C3; `pii_`/`piim_`/`phi_` ⇒ column ≥ C2; `operador` has no select on any table *containing* a C3 column. Publish serializes only columns explicitly `class=C0`. Extend CI to `core_api` views. Document `auth.*` as C2 and out of scope of the comment check, with a stated mitigation. Add a convention `<col>_bidx bytea` (keyed HMAC computed by the app) for lookups on encrypted columns.

### DB-9 — `core.uuid7()` implementation and timestamp exposure (minor, medium)

**Section:** §3.3 Ids; interacts with §3.6 (ids in public bundles) and §3.7 (cursor pagination).

**Problem.** Native `uuidv7()` arrives in PostgreSQL 18. Supabase projects run 15 or 17 today, and third-party extensions such as `pg_uuidv7` are not available on hosted Supabase (to my knowledge, medium confidence). So `core.uuid7()` must be a SQL/plpgsql function. The design does not say that, or how (`gen_random_uuid()` with the timestamp overlaid, `clock_timestamp()` vs `now()`, monotonicity within a millisecond). Separately, UUIDv7 embeds the creation millisecond. Ids in C0 bundles reveal when an item was *drafted*, which may differ from its public date. For future module tables (e.g. a citizen report), the id reveals submission time to anyone who sees the id.

**Failure scenario.** Using `now()` gives every row in one transaction the same timestamp prefix, so "ordering by id approximates creation time" breaks for a bulk import. A cursor paginator then returns rows in random-bit order within a batch, which is fine, unless a lane relies on id order for "newest first" in `content-<page>.json`.

**Recommendation.** Specify a pure-SQL `core.uuid7()` using `clock_timestamp()`, with no ordering guarantee within a millisecond, to be replaced by the native `uuidv7()` behind the same name once the instance runs PG 18. State that ordering for display uses an explicit timestamp column, never id. Note the timestamp-disclosure property in the classification guidance (ids are C0 only if their creation time is).

### DB-10 — `municipality` keyed by IBGE code vs uuid ids (minor, high)

**Section:** §3.3 Ids, Tables; §3.7 ("municipality by IBGE code"); interacts with DB-6 `entity_id`.

**Problem.** §3.7 makes IBGE code the external identifier, and §3.3 says all ids are UUIDv7. If `municipality.id` is a uuid with a separate `ibge_code`, the API and connectors must translate on every call. If `municipality` is keyed by IBGE code, then "modules reference core tables through FKs to `id` columns" and uuid `entity_id` in audit both break. The type is also unspecified: the 7-digit code fits `integer`, but leading-zero-free assumptions and `char(7)` choices diverge between lanes.

**Recommendation.** State: `municipality.id integer primary key` = 7-digit IBGE code, `check (id between 1000000 and 9999999)`, an explicit exception to the uuid rule. Set `audit_event.entity_id text` (DB-6). Bundles and the API use the same integer.

### DB-11 — No column convention for delta sync and tombstones (minor, high)

**Section:** §3.3 (no convention); §3.6 ("Every record has `id`, `updated_at`, `deleted` (tombstones kept 90 days)").

**Problem.** Delta sync needs every published row to have a trigger-maintained `updated_at` and soft deletion (`deleted_at`), and a purge job after 90 days. §3.3 defines neither, so a lane that hard-deletes `agenda_event` makes the deletion invisible to clients, and the citizen app keeps showing a cancelled event. Soft delete also interacts with RLS (policies must hide `deleted_at is not null` from staff views where intended) and with LGPD erasure (personal data in tombstoned rows must still be erased, keeping only the id).

**Recommendation.** Add to §3.3: every table classed C0 that feeds a bundle has `created_at`, `updated_at` (maintained by the `core.touch_updated_at()` trigger) and `deleted_at timestamptz`. Hard `DELETE` is revoked from `authenticated` on those tables. A core job purges tombstones older than the window and nulls their non-key columns.

### DB-12 — Singleton `instance` row not enforced; source of truth unclear (minor, high)

**Section:** §2 ("a single `instance` row"), §3.2, §3.3.

**Problem.** Nothing prevents a second `instance` row, and code that does `select … from core.instance limit 1` becomes nondeterministic. It is also not stated whether the row is written from `tenant.yaml` at boot (overwritten each boot) or edited in the database (and then drifts from the config repo).

**Recommendation.** `id boolean primary key default true check (id)` (or a unique index on `((true))`). State that boot upserts it from `tenant.yaml`, that the database copy is read-only for `authenticated`, and which fields are mirrored (`slug`, `display_name`, `office`, `locale`, `timezone`).

### DB-13 — `cause` vs `theme` naming leaks back (nit, high)

**Section:** §3.2 comment "drives `theme` rows", §3.3 "with `theme` renamed `cause`", §3.5 (visual theme).

**Problem.** §3.2 still says the `causes:` list "drives `theme` rows", which contradicts the rename in §3.3. Lanes reading §3.2 first will create `theme`.

**Recommendation.** Change the §3.2 comment to "drives `core.cause` rows". Also state the seeding rule: `cause.slug` is unique and is the join key to `icons.causes` in §3.5, and causes removed from `tenant.yaml` are soft-deleted (DB-11), not hard-deleted, because content references them.

## Open-question answers

**§6 Q1 — Per-module Postgres schema vs prefixed tables in one schema?**

Keep per-module schemas, **conditional on deciding whether the Supabase Data API (PostgREST) is a client at all.** The doc does not say, and the answer depends on it.

- Supabase exposes only the schemas listed in the API settings (`public`, `graphql_public` by default). Each `mod_*` schema, `core_api` and `core` would need to be added to that list per instance, which is a project configuration change outside migrations, *and* granted `USAGE` to `anon`/`authenticated`. With dynamically enabled modules, that is real operational friction, and the risk of accidentally exposing `core` is high.
- §3.7, however, defines the API as Next.js route handlers under `/api/v1`, and §3.1 routes AI and ingestion through workers. If that is the only path, **expose no schema to the Data API at all** (empty exposed-schema list, or only a minimal `public` with nothing in it). Revoke `USAGE` on `core`/`mod_*` from `anon`. Then the friction disappears, and schemas give exactly what §3.3 wants: collision-free names, per-module ownership (DB-4), and grant-by-schema.
- If the mobile apps are meant to call supabase-js directly (for realtime, or for offline-first writes), prefer a **single exposed schema `api`** of `security_invoker` views (DB-2) over exposing `mod_*` schemas. Prefixed tables in one schema do not fix anything here: they still need per-table grants, lose ownership isolation, and keep the 63-byte name issue.

Either way, the design should add one sentence: "The Supabase Data API exposes `<list>`; everything else is reachable only through `/api/v1` and workers." The RLS and `aal2` reasoning in DB-5 depends on it.
