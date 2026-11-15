# Stage 1 — Goldfish review: self-sufficiency, consistency & YAGNI

Design under review: `docs/designs/0001-core-contracts.md` (draft, 2026-11-14).
Reviewer context: fresh ("goldfish"). Only `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `scripts/check-boundaries.sh`, `.github/workflows/ci.yml` and the design were read. No other source was consulted.

## Summary

The design makes good, defensible calls (Python/TS split, all AI calls in workers, fail-closed guard, C0-only bundles, roles as data, contrast as part of the contract). But as a document an agent must start from tomorrow, it is **not self-sufficient**:

- **The database lane cannot start.** Table columns are defined only as "as in the platform data model (03)", a document that is not in this repo. The queue table that the workers lane needs is not in the table list at all.
- **The design cites private decisions as its constraints** (ADR-0002, -0003, -0004, -0006, -0012, "the planning docs") without inlining them. This repo is public and has a CLA path for outside contributors, who cannot read any of them.
- **The freeze has no definition of done.** The design does not say which artifacts make E0.0 done, who signs off, how a frozen contract is versioned or changed, or what "architecture backbone", "lane" and "instance boot" mean.
- **There are internal contradictions** that will make lanes diverge. Examples: `modules.<id>.settings` (a map) against a list-shaped `modules:`; `settingsSchema` against `settings_schema`; a stale `theme` row comment after the rename to `cause`; cause icons defined in two places; AI label text "from the instance config" with no config key while unknown keys are rejected; column-level C0 filtering in publish with only table-level classes in SQL; `mod_<module_id>` with dotted module ids; "3 users (one per role)" against 4 seeded roles.
- **On YAGNI:** a handful of hooks impose real day-one cost with no consumer in this repo: `PublishTarget.dependsOn`, `Screen.tab` and the `gabinete` variant, `Connector.discover`, `pronoun_style`, and Python codegen. Several day-one needs are missing instead: the content state machine, the queue table and job envelope, the app_user ↔ auth mapping, the runtime location of `tenant.yaml`, the `DataClass` ordering, and a pagination scheme compatible with delta sync.

Counts: **3 blockers, 19 major, 13 minor, 2 nits** across 37 findings (27 CLR, 10 YAGNI).

## Findings table

| ID | Sev | Conf | Section | Claim |
| --- | --- | --- | --- | --- |
| CLR-1 | blocker | high | §3.3 | Table columns are delegated to "platform data model (03)", which is not in this repo, so `0001_core.sql` cannot be written. |
| CLR-2 | blocker | high | Status, §1, AGENTS "Contracts first" | No done criteria, sign-off owner, versioning or change process for the freeze itself. |
| CLR-3 | blocker | high | §2, §3.1, §3.2 | A public repo cites private ADRs and planning docs as binding constraints without inlining their content. |
| CLR-4 | major | high | §1, Status | "Lane", the eleven lanes' ownership, "architecture backbone" and the "closed modules" lane are undefined in this repo. |
| CLR-5 | major | high | §2, §3.3, §3.4, §3.6 | C0–C3 ordering, the `DataClass` type, the prefix semantics (`piim_`?) and column-level classes are undefined, yet the guard and publish depend on them. |
| CLR-6 | major | high | §3.3 vs §3.6 | Publish must refuse "any column not classed C0", but SQL classes only tables and prefixed columns. |
| CLR-7 | major | high | §3.2, §3.4 | Naming convention is inconsistent: `settingsSchema` vs `settings_schema`; snake_case JSON vs camelCase TS vs kebab tokens, with no rule. |
| CLR-8 | major | high | §3.2 | `modules.<id>.settings` implies a map keyed by id; the example `modules:` is a list without `settings`. |
| CLR-9 | major | high | §3.2, §3.5, §4 | `theme:` path base, the stale "drives `theme` rows" comment, and cause icons defined in both tenant.yaml and tokens are ambiguous. |
| CLR-10 | major | high | §2, §3.6, §3.2 | The AI label text "comes from the instance config", but no key exists and unknown keys are rejected. |
| CLR-11 | major | high | §3.3, §3.4 | `mod_<module_id>` with dotted ids (`pro.secretaria`, `demo.hello`) yields invalid or quoted identifiers; `core_api` views are undefined. |
| CLR-12 | major | high | §3.2, §3.4 | "Instance boot" is undefined: which process, where `tenant.yaml` lives at runtime, how manifests are discovered, and whether `instance` row or file wins. |
| CLR-13 | major | high | §3.4 | `registerModule` has no signature; manifest paths and loading are undefined; `permissions` has no table or enforcement; role `label` is a pt-BR literal outside i18n. |
| CLR-14 | major | high | §3.3, §3.4 | There is no queue/job table in 0001, `job.schema.json` fields are missing, and `JobRequest`, retry and idempotency are undefined. |
| CLR-15 | major | high | §3.2, §3.4, §3.6 | Connector identity is split across `id`, `package`, `source_id` and `data_source`; supporting types and transaction ownership are undefined. |
| CLR-16 | major | high | §3.6 | Newest-first fixed pages of 100 change every page's hash on each new item, which defeats delta sync. |
| CLR-17 | major | high | §3.4, §3.6, §4 | Publish trigger, storage target, `PublishContext`/`Bundle`/`EntityKind` and the content states that count as "published" are undefined. |
| CLR-18 | major | medium | §3.4 | The guard requires "provider is not local", but `AiProvider` has no locality attribute; the guard signature differs from the provider's. |
| CLR-19 | major | medium | §3.3, §3.7 | `app_user` ↔ `auth.uid()` mapping, "staff" for the `aal2` rule, and UUIDv7 vs Supabase auth ids are unspecified. |
| CLR-20 | minor | high | §4 vs §3.3 | "3 users (one per role)" contradicts the four seeded roles. |
| CLR-21 | minor | high | §3.2 | `flags.electoral_restricted_mode` has no defined behaviour. |
| CLR-22 | minor | high | §3.7 | `docs/api-conventions.md` is named as a location but does not exist, and its status as an E0.0 deliverable is unclear. |
| CLR-23 | minor | medium | §3.1, §3.2 | Repo layout and tooling are unstated (package manager, Python import root `core.` vs `workers/core/`, codegen output paths). |
| CLR-24 | minor | medium | §2 vs §3.6 | "Every number shown to citizens carries source and reference date" is only realised for indicator bundles. |
| CLR-25 | minor | medium | §6 | Open questions 1 and 3 change lane work but have no decision deadline or default. |
| CLR-26 | minor | medium | §3.4 | `requires_framework: "^0.1"` uses npm range syntax in a "language-neutral" manifest, and the framework version source is undefined. |
| CLR-27 | nit | high | repo (`ci.yml` vs AGENTS/CONTRIBUTING) | The license allow-list in CI is broader than the documented list. |
| YAGNI-1 | major | medium | §3.4 `PublishTarget` | `dependsOn: EntityKind[]` forces an incremental-build dependency engine for five bundle kinds. |
| YAGNI-2 | major | medium | §3.3 Schemas, §6 Q1 | Per-module Postgres schemas impose PostgREST exposure, grants and a `core_api` view layer before any module exists here. |
| YAGNI-3 | minor | medium | §3.4 `Screen` | `tab?: TabSlot` and `variant: 'gabinete'` commit the mobile lane to unscoped navigation (gabinete screens are out of scope per §5). |
| YAGNI-4 | minor | high | §3.2 `pronoun_style` | Gendered UI copy multiplies every pt-BR string in the web and mobile lanes for no current requirement. |
| YAGNI-5 | minor | medium | §3.4 `Connector.discover` | It forces resource enumeration and a `Resource` type on single-resource connectors. |
| YAGNI-6 | minor | medium | §3.1 codegen | Generating both TS and Python models from one schema adds two toolchains and drift CI; validation alone suffices on the Python side. |
| YAGNI-7 | minor | low | §3.2 `office` enum | Enumerating unused offices freezes values that are breaking to remove; start narrow, since additions are non-breaking. |
| YAGNI-8 | minor | medium | §3.4 `ContentEnricher` | A split TS/Python hook with no consumer in this repo duplicates what `Job` plus a content-save event already gives. |
| YAGNI-9 | nit | medium | §3.7 `/api/v2` policy | A sunset policy for a version that does not exist is harmless now; keep it to one line. |
| YAGNI-10 | major | high | §3 (missing) | The under-specified day-one set (content states, job envelope, auth mapping, DataClass, mock fixtures, error-type catalog) matters more than the speculative hooks. |
## Part A — Self-sufficiency and internal consistency

Lanes simulated: **database**, **publish**, **connectors/workers**, with spot checks on **theme**, **auth** and **demo tenant**.

### CLR-1 — Table columns live in a document that is not here (blocker, high)

- **Section:** §3.3 "Tables in 0001 … Columns as in the platform data model (03)".
- **Problem:** The design lists 17 table names and no columns. "Platform data model (03)" is not in this repo, and from AGENTS.md it appears to be a private planning document.
- **Consequence (database lane):** The lane cannot write `0001_core.sql`. It would guess columns for `content_item`, `content_version`, `agenda_event`, `ai_provenance`, `data_source_run` and the rest. The content, publish, connectors and auth lanes then build mocks against different guesses, which is exactly the integration cost §1 says the freeze exists to prevent.
- **Recommendation:** Inline a column table per core table (name, type, nullability, class, FK) in this design or in a sibling `docs/designs/0001-core-contracts-data-model.md`. At minimum, give columns for every table touched by another lane's contract: `content_item`, `content_version`, `cause`, `agenda_event`, `municipality`, `data_source`, `data_source_run`, `ai_provenance`, `audit_event`, `app_user`, `role_assignment`, `module_registry`, `instance`.

### CLR-2 — The freeze has no definition of done or change process (blocker, high)

- **Section:** Status line ("Owner: architecture backbone"), §1, and AGENTS.md "Contracts first … changing a contract goes through the architecture backbone, not a lane".
- **Problem:** Nothing says:
  - which artifacts must exist for E0.0 to be done;
  - who verifies and signs off (AGENTS.md requires someone other than the executor);
  - how a frozen contract is versioned (`schema_version: 1` exists for tenant.yaml and the bundle manifest, but not for the module manifest, the job envelope or the TS/Python interfaces);
  - how a lane requests a change, and whether additive changes need the same process as breaking ones.
- **Consequence (all lanes):** Lanes cannot tell whether they may start. A lane that finds a gap either blocks or quietly patches the contract, which is the drift AGENTS.md forbids.
- **Recommendation:** Add a §7 "Freeze criteria" with:
  1. The artifact checklist. Proposed: `tenant.schema.json`, `module.schema.json`, `job.schema.json`, `tokens.schema.json`, `bundle.schema.json`, `src/{ui,publish,content}.ts`, `workers/core/contracts/{connector,job,ai,enricher}.py`, `0001_core.sql`, `docs/api-conventions.md`, and `tenants/demo/*`.
  2. A CI check that every example in `tenants/demo/` validates against its schema and the migration applies cleanly.
  3. A named approver role, distinct from the author.
  4. Semver per contract package, where additive changes are a minor bump and breaking changes go through a new design doc and EGM review.
  5. A change-request path: an issue labelled `contract-change` that blocks the lane until resolved.

### CLR-3 — Private decisions are cited as binding constraints in a public repo (blocker, high)

- **Section:** §2 (ADR-0002, -0003, -0004, -0012), §3.1 ("The planning docs list …"), §3.2 comment (ADR-0006), §3.3 ("platform data model (03)").
- **Problem:** README and CONTRIBUTING invite external contributors under a CLA, and §2 presents the ADRs as the constraints everything else rests on. An outside contributor, or an agent without the private planning repo, cannot read them. Some appear only as one-line paraphrases (ADR-0006 appears only in a YAML comment). §3.1 even argues against a private document ("That is wrong for half of them"), which a reader here cannot check.
- **Consequence:** External contributors, and lane agents provisioned with only this repo, cannot tell a hard constraint from a preference. The rationale behind "one database per mandate" or "no WhatsApp Business API" is invisible, so contributors will propose already-rejected alternatives.
- **Recommendation:**
  - Inline a short "Decision record summary" for each cited ADR: one to three sentences on what was decided and what it rules out, without private rationale. Keep the number only as a cross-reference.
  - Rewrite §3.1 to state the decision rather than rebut an unseen document.
  - Replace "(03)" with the inlined data model (CLR-1).
  - Apply the same rule to AGENTS.md, which points to private ADRs and doc filenames; it is out of scope for this design, but noted.

### CLR-4 — "Lane", lane ownership and "architecture backbone" are undefined (major, high)

- **Section:** §1, Status.
- **Problem:**
  - The eleven lanes are named but not defined: there is no scope, no mapping to the contracts each one produces or consumes, and no order.
  - "Architecture backbone" is used as an owner but never defined (person, role, agent?).
  - A "closed modules" lane is listed for a public repo, so it is unclear what of that lane happens here.
  - The "demo tenant" lane overlaps with §4, which says the synthetic examples ship with the contracts, so it is unclear who produces `tenants/demo/`.
- **Consequence:** A demo-tenant agent and the contracts author both create `tenants/demo/`. The closed-modules lane has no defined interface surface to test against in this repo.
- **Recommendation:** Add a lane table with columns *lane | owns (paths) | consumes contracts | produces contracts | can start when*. Define "architecture backbone" in one line. State that the closed-modules lane only consumes the extension points and that §4's examples belong to E0.0, not to the demo lane.

### CLR-5 — Data classes are used as an ordered type but never defined (major, high)

- **Sections:** §2, §3.3, §3.4 (`data_class > provider.max_data_class`, `data_classes: ["C1","C2"]`), §3.6.
- **Problem:**
  - C0–C3 names are given, but ordering is only implied. The `DataClass` type is not specified: is it a string enum, an `IntEnum`, or a SQL domain? How does `"C1"` in the JSON manifest map to the Python type?
  - The prefix semantics are not explained. What is `piim_`? Which class does each prefix imply? Is `phi_` always C3?
  - §3.3 says "C2 `pii_` columns and C3 `enc_` columns hold ciphertext" but says nothing about `phi_` and `piim_`.
  - The CI rule checks `pii_`/`phi_`/`piim_` against a table class below C2 but never checks `enc_`.
- **Consequence (workers, database, publish):** The workers lane implements `>` on strings, where `"C10"` would sort wrongly in future and comparison is fragile. The database lane guesses which prefixed columns are encrypted. The crypto lane does not know its input set.
- **Recommendation:** Add a normative table: *class | meaning | ordinal | allowed prefixes | encrypted? | may leave the instance? | may reach an external AI?* Define `DataClass` once (JSON enum `"C0".."C3"` plus an ordinal mapping) and reference it from the SQL comment format, the module manifest, the `Job` and the `AiProvider`.

### CLR-6 — Publish filters columns by class, but SQL classes tables (major, high)

- **Section:** §3.3 "every table and every `pii_`/`phi_`/`piim_`/`enc_` column has a `COMMENT ... IS 'class=Cn'`" vs §3.6 "`core-publish` refuses to serialize any column not classed C0".
- **Problem:** Unprefixed columns carry no class. `content_item` is plausibly C1 because it holds drafts and authors, yet its published title and body must reach the bundle.
- **Consequence (publish lane):** Under the rule as written, publish either serializes nothing (no column is classed C0) or the lane invents a fallback, such as inheriting the table class, which would also block everything in C1 tables. A security-relevant rule gets resolved ad hoc.
- **Recommendation:** Pick one model:
  - (a) Every column carries an explicit class, and the CI test enforces that.
  - (b) Publish reads only from C0 views (e.g. `core_api.published_content`), and the class check applies to the view.

  Option (b) is simpler and also gives `core_api` a definition (see CLR-11).

### CLR-7 — Naming conventions contradict each other (major, high)

- **Sections:** §3.2 ("that module's own `settingsSchema`") vs §3.4 manifest (`settings_schema`). Also §3.4 TS (`dependsOn`, `onSave`), §3.5 tokens (`brand-on`, `cta-on`), §3.7 (`next_cursor`).
- **Problem:** No rule says which casing applies where. The same concept appears as `settingsSchema` and `settings_schema`.
- **Consequence:** Codegen from JSON Schema (§3.1) produces either snake_case TS properties or a mapping layer. Each lane picks differently, and the manifest validator rejects one of the spellings because unknown keys are rejected.
- **Recommendation:** Add a one-paragraph naming rule:
  - Wire and file formats (YAML, JSON schemas, bundles, API bodies, SQL) use snake_case.
  - Token role names use kebab-case.
  - TS and Python identifiers follow language idiom, and generated types keep wire names verbatim.
  - Fix §3.2 to say `settings_schema`.

### CLR-8 — `modules` is described as a map but shown as a list (major, high)

- **Section:** §3.2 prose "inside `modules.<id>.settings`" vs YAML `modules: - { id: core.content, enabled: true }`.
- **Problem:** The path notation implies a mapping keyed by module id, while the example is a sequence with no `settings` key.
- **Consequence (config/demo lanes):** The schema author must choose. Whichever is chosen, either the doc's prose or its example is wrong, and the validator's carve-out for open `settings` is written against one shape.
- **Recommendation:** Keep the list and say "the `settings` object of each `modules[]` entry, validated by that module's `settings_schema`". Add `settings: {}` to one example entry. State that ids are unique (a list allows duplicates; a map would not).

### CLR-9 — Theme path, stale "theme rows", and cause icons in two places (major, high)

- **Section:** §3.2 `theme: theme/tokens.json  # path inside the mandate config repo`, `causes: # drives theme rows and icons`; §3.3 "`theme` renamed `cause`"; §3.5 `icons.causes`; §4 `tenants/demo/theme/tokens.json`.
- **Problems:**
  1. The path base is undefined. §4 places the demo under `tenants/demo/`, so the path is presumably relative to the directory holding `tenant.yaml`, but the comment says "inside the mandate config repo".
  2. "Drives `theme` rows" is stale after the rename and contradicts the stated purpose of the rename.
  3. A cause's icon is defined in `tenant.yaml` (`causes[].icon`) and again in `tokens.json` (`icons.causes`). There is no rule for which wins, nor whether `core.cause` rows are seeded from `tenant.yaml`, edited in the back-office, or both.
- **Consequence (theme, database, publish):** The theme lane and the publish lane read icons from different sources. `causes.json` in the bundle may disagree with the app's icons.
- **Recommendation:**
  - State that paths in `tenant.yaml` are relative to the file's directory.
  - Fix the comment to say "drives `core.cause` rows".
  - Make one source authoritative. Proposed: `tenant.yaml` owns slug, name and icon; tokens own only colors and type. Drop `icons.causes`, or else drop `causes[].icon`.
  - State the sync direction: file to DB at boot (upsert by slug).

### CLR-10 — AI label text "from instance config" has no config key (major, high)

- **Sections:** §2 "every AI-assisted text carries a disclosure label"; §3.6 "the label text comes from the instance config"; §3.2 "Unknown keys are rejected everywhere".
- **Problem:** No `tenant.yaml` key holds the label text, and the strict schema forbids adding one ad hoc. It is also unclear whether "instance config" means `tenant.yaml`, the `core.instance` row, or i18n files (AGENTS rule 5 says user-facing strings go through i18n).
- **Consequence (publish, web, mobile):** Each lane hard-codes or invents a source. The label is a compliance element, so inconsistency here is visible to citizens.
- **Recommendation:** Pick one:
  - (a) The i18n key `ai.disclosure_label`, with the default in the framework's pt-BR file and an optional override `labels.ai_disclosure` in `tenant.yaml`, added to the schema.
  - (b) A key in the `manifest.json` header, so the app does not need the config.

  Specify whether the bundle carries the text or only `ai_label: true`.

### CLR-11 — `mod_<module_id>` with dotted ids, and undefined `core_api` (major, high)

- **Section:** §3.3 Schemas; §3.4 `"id": "pro.secretaria"`; §3.2 `core.content`; §4 `demo.hello`.
- **Problems:**
  - Module ids contain dots. `mod_pro.secretaria` is not a valid unquoted Postgres identifier, and a quoted one breaks every tool and convention, including PostgREST schema exposure.
  - Are `core.content` and `core.agenda` "modules" that get their own `mod_core.content` schema, or do they live in `core`?
  - The views in `core_api` that modules may use are never listed.
- **Consequence (database lane, demo `demo.hello`):** The first module migration fails or uses a lane-invented mangling. The `demo.hello` example in §4 cannot be written consistently.
- **Recommendation:**
  - Define the mapping, e.g. lowercase and replace `.` with `_` → `mod_demo_hello`, with a 63-byte limit and a collision rule.
  - State that `core.*` built-in modules live in schema `core`.
  - List the initial `core_api` views, or remove `core_api` until a module needs it (see YAGNI-2).

### CLR-12 — "Instance boot" and runtime config location are undefined (major, high)

- **Section:** §3.2 "Validation runs … at instance boot; boot refuses to start"; §3.4 "Module manifest … validated at boot"; §2 "a single `instance` row".
- **Problem:** The instance consists of a Next.js app, Python workers and a database, so it is unclear which of them boots. The design also leaves open:
  - where `tenant.yaml` is at runtime (env var path, baked into the image, fetched from the config repo);
  - how module manifests are discovered (`node_modules` scan, an explicit list in `tenant.yaml`, a Python entry point);
  - whether the `core.instance` row is written from `tenant.yaml` at boot, or edited in the app and authoritative.
- **Consequence (workers, web shell, database):** The web and workers lanes each write their own loader with different failure behaviour. The demo tenant cannot be booted by a third party.
- **Recommendation:** Add a "Boot sequence" paragraph covering:
  - the env var (e.g. `TENANT_CONFIG_DIR`);
  - validation in both runtimes using the same JSON Schema;
  - module discovery via `tenant.yaml` `modules[].id` resolved to an installed package;
  - an upsert of `core.instance`, `core.cause`, `core.role` and `core.module_registry` from config, with config as the source of truth;
  - the exit code and log line on failure.

### CLR-13 — `registerModule` and manifest semantics are under-defined (major, high)

- **Section:** §3.1 and §3.4 module manifest.
- **Problems:**
  - `registerModule` is listed as an extension point, but no function signature or call site is given.
  - The paths `routes: ["web/routes.ts"]`, `screens`, `jobs` and `migrations` have no stated base, and their export shape is unspecified (default export of `Route[]`?). Next.js and Expo also need static imports at build time; the design does not say how a closed module's routes get into the build without the framework importing it (AGENTS rule 1).
  - `permissions` (`minutes.approve`) has no core table (none of the 17 tables is `permission`), and RLS has only `core.has_role`, so permissions have no enforcement path.
  - `roles[].label: "Secretaria"` is a pt-BR user-facing literal inside a manifest, which conflicts with AGENTS rule 5 (i18n files).
- **Consequence (web shell, mobile shell, closed modules):** Integration is impossible to mock, because the shell lanes cannot load a module and the module lane cannot know what to export.
- **Recommendation:**
  - Define `registerModule(manifest, impl)`, or state that it is manifest-only and the shells resolve `routes` by package export name.
  - State that paths are relative to the module package root.
  - Define the build-time composition mechanism (e.g. a generated `modules.generated.ts` from the mandate config at build).
  - Either add `core.permission` plus `core.has_permission()`, or drop `permissions` from v1.
  - Replace `label` with `label_key` (i18n).

### CLR-14 — The job queue has no table, envelope or semantics (major, high)

- **Sections:** §2 "Postgres-backed queue"; §3.1 `schema/job.schema.json for the payload envelope`; §3.4 `Job`, `JobRequest`; §3.3 table list.
- **Problems:**
  - No queue table appears in the 0001 tables, and no queue implementation is named (a custom table with `FOR UPDATE SKIP LOCKED`? an extension?).
  - The envelope fields are not given.
  - `JobRequest` (TS) is undefined, as are retry, backoff, dead-letter, idempotency and the meaning of `Job.data_class` (max class of payload? of data touched?).
  - `concurrency` is undefined in scope (per worker process? global?).
- **Consequence (workers lane):** It cannot start. The web lane cannot enqueue, and the content lane's enricher hook has nothing to produce.
- **Recommendation:**
  - Add `core.job` to 0001 with columns such as id, queue, payload jsonb, data_class, status, attempts, run_after, locked_until and idempotency_key.
  - Specify the envelope `{ job_id, queue, data_class, payload, enqueued_by, idempotency_key }`.
  - Specify the claim query semantics, a default of N retries with backoff, and that a payload above the job's `data_class` is rejected at enqueue.

### CLR-15 — Connector identity and types are split and undefined (major, high)

- **Sections:** §3.2 `connectors: - { id: ibge-municipios, package: core.connectors.ibge, schedule, params }`; §3.4 `ConnectorManifest` (comment-only field list incl. `source_id`); §3.3 `data_source`, `data_source_run`; §3.6 `indicators-<source_id>.json`.
- **Problems:**
  - Four identifiers (`id`, `package`, `source_id`, `data_source.id`) have no stated relation.
  - The `ConnectorManifest` field types are missing: what are `robots`, `auth`, `automation` and `cadence`, and how does `cadence` relate to the tenant `schedule`?
  - `Resource`, `RawBatch`, `Record`, `ValidationReport`, `UpsertStats` and `Tx` are undefined.
  - It is unclear who opens the transaction, whether a failed `validate` aborts the upsert, who writes `data_source_run`, and whether the cron `schedule` is in UTC or the instance `timezone` (`America/Fortaleza`).
- **Consequence (connectors lane):** The IBGE connector, the runner and the indicator bundle each pick their own key. Runs land on the wrong hour, and indicator bundles cannot be named consistently.
- **Recommendation:**
  - State that `connectors[].id` equals `ConnectorManifest.source_id` equals `data_source.id` (slug) and is used in bundle names, and that `package` is the Python import path.
  - Specify that the cron is evaluated in UTC, or in the instance `timezone`.
  - Give the runner algorithm in five lines: open run → fetch → normalize → validate (abort on errors) → upsert in a runner-owned tx → close run with stats.
  - Give minimal dataclass definitions for each type.

### CLR-16 — Fixed newest-first pages defeat delta sync (major, high)

- **Section:** §3.6 "`content-<page>.json` (newest first, 100 items per page)" plus "downloads only bundles whose `sha256` changed".
- **Problem:** Prepending one new item shifts every item down a page, so every page's content and hash changes. Tombstones and edits to old items have the same effect on the page they sit on, but the shift is the dominant cost.
- **Consequence (publish, mobile):** Each publish forces a full re-download of all content pages over 3G, which contradicts §2 "syncs deltas and works offline on 3G". The publish lane would implement the doc literally, and the problem would surface only in field testing.
- **Recommendation:** Pick one:
  - (a) Partition by stable keys, e.g. `content-<yyyy-mm>.json` by creation month, so only the current month and edited months change.
  - (b) A single `content-delta-<since>.json` plus periodic full snapshots.

  Either way, define the delta key (`updated_at` cursor vs bundle hash).

### CLR-17 — Publish trigger, storage and "published" state are undefined (major, high)

- **Sections:** §3.4 `PublishTarget { build(ctx: PublishContext): Promise<Bundle[]> }`; §3.6; §4 "5 content items in different states"; README "fluxo editorial".
- **Problems:**
  - The content editorial states and transitions are not given anywhere, nor which state makes an item eligible for bundles.
  - `PublishContext`, `Bundle` and `EntityKind` are undefined.
  - It is unclear what triggers a publish (state transition, schedule, a job), where bundles are uploaded (Supabase Storage bucket? the bucket name uses `slug` per §3.2), who writes `manifest.json` (the framework, or each target?), and whether builds are atomic (manifest written last).
- **Consequence (publish and content lanes):** The two lanes cannot agree on the hand-off, and the seed data's "different states" cannot be written.
- **Recommendation:**
  - Add the content state machine, e.g. `draft → in_review → approved → published → archived`, listing which roles can move each edge and that only `published` and not deleted reach bundles.
  - Define `Bundle { name, records }`. The framework computes the hash, uploads to bucket `<slug>-public` and writes `manifest.json` last.
  - Publish runs as a `Job` enqueued on state change.

### CLR-18 — The AI guard depends on an attribute the provider lacks (major, medium)

- **Section:** §3.4 `AiProvider` and "Fail-closed guard".
- **Problem:** The guard refuses "when `data_class == C3` and the provider is not local", but `AiProvider` has only `id` and `max_data_class`, with no `is_local`. This rule also makes `max_data_class = C3` meaningful only for local providers; the design never states that relation. The guard signature `ai.generate(task, inputs, data_class, schema)` differs from `AiProvider.generate(task, inputs, output_schema)` without saying that the former is the facade.
- **Consequence (workers lane):** It cannot implement the guard as written. It will either add an unreviewed attribute to a frozen contract or drop the rule, and this is the security boundary.
- **Recommendation:** Add `is_local: bool` (or `location: Literal['local','external']`) to `AiProvider`. Add a validation that `max_data_class == C3` implies `is_local`. Name the facade (`core.ai.generate`) and state that providers are never called directly.

### CLR-19 — Auth identity mapping and "staff" are unspecified (major, medium)

- **Sections:** §3.3 RLS ("`core.has_role(text)` reads `role_assignment` for `auth.uid()`"), Ids (UUIDv7); §3.7 "staff sessions require a second factor claim (`aal2`)".
- **Problems:**
  - Is `app_user.id` equal to `auth.users.id`? Supabase generates auth ids, not `core.uuid7()`, so the UUIDv7 rule cannot hold for `app_user` if they are equal.
  - "Staff" is not defined: any user with a role assignment? citizens with no role?
  - It is unclear whether `has_role` itself checks `aal2` or each policy does.
- **Consequence (auth and database lanes):** RLS policies and the second-factor rule get implemented twice, differently. A bug here is a privilege bug.
- **Recommendation:** State that `app_user.id = auth.users.id` (FK) and is excepted from the UUIDv7 rule. Define staff as having at least one `role_assignment`. Have `core.has_role()` return false unless the JWT `aal` is `aal2`, so the rule is enforced in one place.

### CLR-20 — Seed user count contradicts the role count (minor, high)

- **Sections:** §4 "3 users (one per role)" vs §3.3 four seeded roles (`parlamentar`, `chefe_gabinete`, `comunicacao`, `operador`).
- **Consequence:** The demo lane silently drops one role. The `operador` C3 restriction is the likeliest one left untested.
- **Recommendation:** Seed 4 users, one per role, and say which one exercises the `operador` C3 denial.

### CLR-21 — `electoral_restricted_mode` has no behaviour (minor, high)

- **Section:** §3.2 `flags: { electoral_restricted_mode: false }`.
- **Problem:** The flag is part of a frozen schema, but nothing says what it changes (hide content? stop publishing? block AI?).
- **Consequence:** Each lane interprets it, or ignores it.
- **Recommendation:** Either specify its effect per lane in two to three bullets, or drop `flags` from schema v1 and add it when designed. Adding it later is a non-breaking change.

### CLR-22 — `docs/api-conventions.md` is referenced but absent (minor, high)

- **Section:** §3.7 heading.
- **Problem:** It is unclear whether the heading names a deliverable of E0.0 or an existing document. Error `type` URIs are "stable", but neither a base URI nor a catalog is given.
- **Recommendation:** List it as an E0.0 artifact (CLR-2). Add the `type` URI base (e.g. `https://example.org/problems/<slug>` placeholder, configurable) and the initial catalog: validation, auth, aal2-required, rate-limited, idempotency-conflict, not-found.

### CLR-23 — Repo layout and tooling are implicit (minor, medium)

- **Sections:** §3.1 paths, §3.2 `package: core.connectors.ibge`.
- **Problem:** `packages/*` and `workers/core/*` imply a monorepo, but there is no package manager or workspace tool, and no Python packaging (import root `core` vs `workers.core`). Where generated TS and Python types are written, and whether they are committed, is also not stated.
- **Consequence:** The first two lanes to start create conflicting scaffolding.
- **Recommendation:** Add a short layout block (tree), with the workspace tool, the Python package root and the codegen output paths, as part of E0.0.

### CLR-24 — "Every number shown to citizens" is only covered for indicators (minor, medium)

- **Section:** §2 vs §3.6.
- **Problem:** Numbers inside content items (e.g. "R$ 2 milhões em emendas") have no source or reference-date fields.
- **Recommendation:** Narrow the constraint to "every indicator value" for v1, or add an optional `sources[]` to content records.

### CLR-25 — Open questions block lanes but have no default (minor, medium)

- **Section:** §6, questions 1 (module schemas) and 3 (tombstone fallback).
- **Problem:** Both questions change the database and mobile lanes' work, yet the design has no default answer and no decision deadline.
- **Recommendation:** Give each question a default that applies if review does not resolve it. Suggested defaults: Q1 → prefixed tables (YAGNI-2); Q3 → full resync when `last_sync < now - window`. Q3's answer is close to free and should simply be adopted.

### CLR-26 — The version range syntax in the "language-neutral" manifest (minor, medium)

- **Section:** §3.4 `requires_framework: "^0.1"`.
- **Problem:** `^` is npm range syntax, and Python's packaging uses different syntax. The doc does not say what "the framework version" is (which package's version?).
- **Recommendation:** Define it as a semver range in npm syntax, evaluated against `packages/core-contracts` version, with a named library on the Python side. Alternatively, use a simple `framework_major: 0` until 1.0.

### CLR-27 — CI license list differs from documented list (nit, high)

- **Sections:** AGENTS rule 2 / CONTRIBUTING item 3 vs `.github/workflows/ci.yml` `allow-licenses` (adds CC0-1.0, Unlicense, BlueOak-1.0.0, Python-2.0).
- **Recommendation:** Align the docs with CI, or CI with the docs. This is outside the design, but contract lanes will add dependencies first.

## Part B — YAGNI / Ponytail

The test applied: name the cost each item imposes **now**, on a lane, for a first freeze. Items that are cheap, or costly to retrofit, are kept.

### YAGNI-1 — `PublishTarget.dependsOn` (major, medium)

- **Section:** §3.4.
- **Cost now:**
  - The publish lane must define `EntityKind`.
  - It must track changes per entity kind and build a dependency-driven incremental rebuild.
  - Every target author must keep `dependsOn` accurate, and a missing kind means stale bundles that are hard to detect.

  The framework produces five bundle kinds from small tables, and a full rebuild plus hash comparison (already in §3.6) gives the same citizen-side result.
- **Recommendation:** Drop `dependsOn` from v1. `build(ctx)` always runs, and the unchanged-hash check skips uploads. Re-add it as an optional field (non-breaking) when a target is measurably slow.

### YAGNI-2 — Per-module Postgres schemas (major, medium)

- **Section:** §3.3 Schemas; §6 Q1.
- **Cost now:**
  - Each module schema must be added to Supabase's exposed schemas, with grants per schema and per-schema RLS defaults.
  - A `core_api` view layer must be designed (still undefined).
  - The dotted-id mangling problem appears (CLR-11).

  The only module in this repo is `demo.hello`.
- **Counterpoint (why not pure YAGNI):** Namespacing is expensive to retrofit after closed modules ship tables. So a convention must be frozen now; the question is which one is cheapest.
- **Recommendation:** Freeze table prefixes in one `app` schema (`<module_slug>__<table>`, with `core` tables in `core`). Freeze that modules may FK only to `core.*.id`, enforced by the same CI test that checks classes. Defer `core_api` until a module needs a cross-module read.

### YAGNI-3 — `Screen.tab` and the `gabinete` variant (minor, medium)

- **Section:** §3.4 `Screen`; §5 ("gabinete app screens" out of scope).
- **Cost now:**
  - The mobile shell lane must design a `TabSlot` model (fixed slots? ordering? conflict between two modules claiming one slot?).
  - It must also support a second app variant that has no screens in scope.
- **Recommendation:** v1 `Screen = { id, roles?, load }` for the citizen variant only, with navigation placement decided by the shell. Add `variant` and `tab` when the gabinete design exists. Both are additive optional fields.

### YAGNI-4 — `pronoun_style` (minor, high)

- **Section:** §3.2.
- **Cost now:** If honoured, every pt-BR string mentioning the parliamentarian needs ICU `select` variants across the web and mobile lanes, plus tests per variant. If not honoured, it is a dead key in a frozen schema.
- **Recommendation:** Drop it from schema v1. `public_name` covers the demo. It can be added later as an optional key with a default, which is non-breaking.

### YAGNI-5 — `Connector.discover` (minor, medium)

- **Section:** §3.4.
- **Cost now:** Every connector must implement enumeration, and the `Resource` type must be designed and frozen. The only framework connector (IBGE municipalities) is a single resource, with `params` already in `tenant.yaml`.
- **Recommendation:** v1 is `fetch(params, since) -> RawBatch`. Add `discover` as an optional protocol method later. Keep `validate` separate from `normalize`: data-quality reporting is a day-one need, since `data_source_run` exists.

### YAGNI-6 — Generating both TS and Python models from one schema (minor, medium)

- **Section:** §3.1 row `registerModule`.
- **Cost now:** Two generators must be chosen, license-checked and pinned, and generated code must be checked in or built, with a drift CI job. Python only needs to validate the manifest at boot and read a few fields.
- **Recommendation:** The JSON Schema is the source. Generate TS types, since the shells consume them heavily. Python validates with a standard JSON Schema validator and reads a `dict`/`TypedDict` written by hand. Revisit if Python use grows.

### YAGNI-7 — `office` enum values (minor, low)

- **Section:** §3.2.
- **Cost now:** Small but real. Each enum value implies house semantics (`vereador` → a municipal chamber, where `house.uf` alone is insufficient; `senador`, `deputado_federal` → a federal house) and copy. Removing a value later is breaking, while adding one is not.
- **Recommendation:** Keep the field. Freeze only the values a lane will exercise (`deputado_estadual`, perhaps `deputado_federal`), and document that more are added by minor schema bumps. Low confidence: if the federal connectors already depend on `office`, keep the full list.

### YAGNI-8 — `ContentEnricher` as a separate split hook (minor, medium)

- **Section:** §3.1, §3.4.
- **Cost now:** A TS interface, a Python interface and the glue between them, all frozen with no implementation or consumer in this repo, so the contract cannot be tested here. Its function (enqueue work on content save) is a special case of `Job` plus an event.
- **Recommendation:** Replace it with a framework event `content.version_saved`. Modules subscribe by declaring a job for that event in the manifest (`jobs[].on: "content.version_saved"`). This gives one mechanism instead of two and is testable with `demo.hello`.

### YAGNI-9 — `/api/v2` sunset policy (nit, medium)

- **Section:** §3.7.
- **Cost now:** Nearly none. Mobile clients in the field do justify a stated policy early. Noted only to keep it to one line and to define "one app release cycle", which is otherwise ambiguous.
- **Recommendation:** Keep `/api/v1`. Phrase the policy as "old version kept until the minimum supported app version no longer calls it".

### YAGNI-10 — What lanes need on day one that is missing (major, high)

Balancing the list above, these gaps cost more than any speculative hook, and each is already a finding in Part A:

1. The content editorial state machine and role permissions per transition (CLR-17).
2. The queue table, job envelope, and retry and idempotency semantics (CLR-14).
3. The `DataClass` definition, ordering and per-column classification model (CLR-5, CLR-6).
4. `app_user` ↔ auth mapping and the `aal2` enforcement point (CLR-19).
5. The boot sequence and config location (CLR-12).
6. The table columns themselves (CLR-1).
7. Mock fixtures beyond §4. §1 promises "lanes can work against mocks", but there are no example job payloads, connector raw batches, `PublishContext` fixtures, or problem+json samples.
8. The pagination scheme compatible with delta sync (CLR-16).

**Recommendation:** Before freezing, trade the speculative fields (YAGNI-1 to -8) for these. The freeze becomes smaller and more complete at the same time.

## Things that are right and should stay

- All AI calls in workers, behind a single fail-closed guard, with the framework shipping only `NoneProvider` (§3.1, §3.4).
- C0-only bundles and refusal at serialization time (§3.6), once CLR-6 is resolved.
- Roles as data, seeded by framework and extended by manifest (§3.3).
- Contrast as part of the tokens contract, with a passing default theme (§3.5).
- Strict `tenant.yaml` validation at boot, with refusal to start (§3.2).
- An append-only audit through a security-definer function, logging no content (§3.3).
- Synthetic examples shipped with the contracts (§4).
