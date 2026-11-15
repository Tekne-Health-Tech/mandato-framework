# Stage 1 — Goldfish review: extension contracts & open-core boundary

Design under review: `docs/designs/0001-core-contracts.md` (draft, 2026-11-14).
Reviewer context: fresh (goldfish). Inputs read: `AGENTS.md`, `scripts/check-boundaries.sh`, the design. Nothing else is assumed; anything the design does not state is treated as a gap.
Lens: §3.1 and §3.4 — extension contracts, module loading, versioning, AI guard, open-core boundary (hard rules 1 and 4), open questions Q2 and Q4.

## Summary

The design gets the core direction right: the closed side depends on the framework and never the reverse, AI calls are funnelled through workers, and the framework ships only the guard and `NoneProvider`. But it is **not yet freezable as a contract**:

1. **There is no module composition mechanism.** The manifest lists source paths and `Route`/`Screen` use `load()`, but Expo and Next.js bundle code statically. The design never says how a closed module's code gets into a build without the public repo naming it (EXT-1, blocker). This is also where the AGPL question shows up, and that question has to go to legal.
2. **`registerModule` is listed as an extension point (hard rule 1) but is never defined.** Only a JSON manifest exists, its key naming differs from the prose (`settings_schema` vs `settingsSchema`), and what the referenced files must export is not specified (EXT-2, blocker).
3. **The AI guard cannot be implemented as written.** The guard signature and the `AiProvider.generate` signature differ, "local" is not a provider attribute, `DataClass` has no defined ordering, and nothing says how a task is routed to a provider (EXT-4, blocker).
4. About 18 referenced types are undefined. Some are harmless to leave to a lane. Others carry security or boundary weight (`JobContext`, `PublishContext`, `Part`, `Record`/`Tx`) and must be in the frozen contract (EXT-3, major).
5. Versioning and contract evolution are a single caret range with no policy (EXT-6). Connector idempotency and transaction ownership are unspecified (EXT-7). Module `PublishTarget`s can bypass the C0-only serializer (EXT-8).

On the cut rule (hard rule 4), I found no prompt or analytics leak. One gap points the other way: with only `NoneProvider`, the demo tenant and every lane's mocks cannot exercise the AI path at all (EXT-9).

## Findings table

| ID | Severity | Confidence | Section | Claim |
| --- | --- | --- | --- | --- |
| EXT-1 | blocker | high | §3.1, §3.4 (manifest `routes`/`screens`, `load()`), §3.2 `modules` | No build-time composition mechanism: the design does not say how closed-module TS code reaches the Expo/Next.js bundles without the public repo naming it, and mobile cannot load code at runtime. |
| EXT-2 | blocker | high | §3.1 row `registerModule`, §3.2, §3.4 manifest | `registerModule` is a hard-rule extension point but only a manifest exists; there is no function signature, no defined exports for the referenced files, and the key naming is inconsistent. |
| EXT-3 | major | high | §3.4 TS and Python sketches | 18 referenced types are undefined; the security-bearing ones (`JobContext`, `PublishContext`, `Part`, `Record`/`Tx`, `DataClass`) cannot be left to lanes without each lane inventing its own. |
| EXT-4 | blocker | high | §3.4 `AiProvider` + fail-closed guard | Guard and provider signatures disagree, "local" and the `DataClass` ordering are undefined, and there is no hook for routing a task to a provider, so the guard cannot be built or tested. |
| EXT-5 | minor | medium | §3.4 `generate(task, …)`, §3.3 `ai_provenance` | `task` is an unconstrained string with no namespace or registry, and nothing says what provenance stores, which invites prompt text or prompt-like names into public code and the database. |
| EXT-6 | major | high | §3.4 `requires_framework`, AGENTS.md "Contracts first" | There is no versioning or evolution policy for contracts consumed by separately released closed modules; `^0.1` plus "frozen" leaves breaking changes unmanaged. |
| EXT-7 | major | medium | §3.4 `Connector`, §3.2 `connectors[].package` | Connector sync/async, transaction ownership, cursor storage, natural keys and idempotency of `upsert` are unspecified, and so is Python discovery of closed connectors. |
| EXT-8 | major | medium | §3.4 `PublishTarget`, §3.6 | A module `PublishTarget` returns ready-made `Bundle[]`, which bypasses the C0-only serializer; bundle names for modules are also outside the fixed list in §3.6. |
| EXT-9 | minor | medium | §3.4 guard paragraph, §4, AGENTS.md rule 4 | Shipping only `NoneProvider` leaves the demo tenant and lanes with no way to exercise the AI path end to end; a deterministic fake provider passes the cut rule. |
| EXT-10 | nit | medium | §3.4 manifest example, §3.3 `mod_<module_id>` | The public example describes a real closed module's surface, and the dotted module id does not map to a valid `mod_<id>` schema name without a stated rule. |

## Detailed findings

### EXT-1 — No build-time composition mechanism for closed modules (blocker, high)

**Section.** §3.1 (`Route`, `Screen` in TypeScript), §3.4 manifest keys `routes: ["web/routes.ts"]`, `screens: ["mobile/screens.ts"]`, `Route.load` / `Screen.load: () => Promise<…>`, §3.2 `modules: [{ id, enabled }]`.

**Problem.** The design never says how module UI code is discovered and included:
- **Expo / React Native.** Metro builds a static bundle. A `load()` returning a dynamic `import()` only splits code that is already in the build graph. The app cannot fetch and execute JS from a closed repo at runtime, and app-store policy restricts downloaded executable code anyway. Both the citizen and gabinete apps therefore need every module's screens present at build time.
- **Next.js.** Bundling is also static. A string path in a JSON manifest (`"web/routes.ts"`) cannot be `import()`ed from inside a framework package unless something generates a static import map.
- **Python workers** are different. They *can* discover installed packages at runtime, for example through `importlib.metadata` entry points. The design doesn't use that either (see EXT-7).
- `tenant.yaml` `modules[].enabled` reads as a *runtime* switch, but inclusion is a *build-time* fact. The design never states what happens when an enabled module is not in the build, or when a built module is not listed.

**Hard rule 1 interaction.** Something must contain `import … from '<closed module package>'`. If that is any file in this repo (for example a generated `modules.generated.ts`, or `package.json` dependencies in `apps/web`), it violates hard rule 1 and should fail `check-boundaries.sh` (as long as the package name matches the pattern; a renamed scope would slip past the grep, which is a separate weakness of the check).

**Failure scenario.** The web-shell lane implements `load: () => import(manifest.routes[0])` and it works for `demo.hello` because that module lives in this repo. The mobile-shell lane does the same and it works in Expo Go dev. The closed-modules lane then finds there is no place to put its package in the app's dependency graph without editing `apps/*` in the public repo. The workaround is a fork of `apps/mobile`, which forks the shell and defeats the framework.

**Recommended change.** Add a §3.x "Composition" decision:
- The public repo publishes **packages** (`core-contracts`, shells as libraries exposing `createWebApp({ modules })` / `createMobileApp({ modules })`) plus a thin **demo app** that composes only public modules.
- A deployable app is assembled in a **separate composition repo** (private per mandate, or a closed "distribution" repo). It depends on framework packages and closed modules, and a codegen step (`core-modules generate`) reads enabled manifests from `tenant.yaml` and writes a static import map.
- `load()` stays for code splitting only. Its implementation is always a static `import()` emitted by codegen.
- Boot fails if `tenant.yaml` enables a module id absent from the build. The reverse (built but not enabled) is allowed and hidden.
- Python discovers modules and connectors via an entry-point group such as `mandate_framework.modules`, with no string import of arbitrary paths.

**Question for legal (not legal advice).** Under this composition, closed module code ends up in the same Next.js server and client bundles, and the same mobile JS bundle, as AGPL-3.0 framework code. That bundle is distributed to citizens (app stores) and served over a network (AGPL §13). Legal should answer:
- Is the combined bundle a single work, and does Tekne's position as copyright holder (plus whatever `CLA.md` grants over external contributions) cover distributing it under non-AGPL terms?
- What obligations apply to *third parties* who build their own mandate on the public framework? For example, can they link their own proprietary modules, and does the project intend a commercial license for that?
- Does the AGPL dependency rule in hard rule 2 (no third-party AGPL/GPL) need a mirror rule for the closed side?

The design should record the answer as an ADR reference before the composition contract freezes, because the answer may force a process boundary (for example closed web routes served as a separate service) instead of in-bundle linking.

### EXT-2 — `registerModule` is named but not specified; manifest is incomplete and inconsistently named (blocker, high)

**Section.** §3.1 row "`registerModule` (manifest) | Language-neutral", §3.2 "validated by that module's own `settingsSchema`", §3.4 manifest JSON (`settings_schema`), §3.3 `module_registry` table.

**Problem.**
- AGENTS.md hard rule 1 lists `registerModule` as an extension point, which reads as a function. The design reduces it to a JSON manifest and never states whether a callable exists, in which language, who calls it, and when (build, boot, or migration time).
- The manifest references files (`web/routes.ts`, `mobile/screens.ts`, `workers/jobs.py`) but does not say what they must export. Possibilities include `export default Route[]`, a named `routes`, or a Python `JOBS: list[type[Job]]`.
- Manifest keys are `snake_case` (`settings_schema`, `requires_framework`, `data_classes`) while the prose says `settingsSchema`. With TS types *generated* from the JSON Schema, one spelling is wrong and the generated type will not match the prose.
- Semantics are missing for: `data_classes` (enforced against the module's table comments? used to gate jobs or providers?), `permissions` (format of permission ids, how they map onto RLS or route `roles`), `migrations` (ordering relative to core and other modules, down-migrations, which DB role runs them), the column contract of `module_registry`, and the extension points not represented in the manifest at all (`PublishTarget`, `ContentEnricher`, `Connector`, `AiProvider`).
- A module id like `pro.secretaria` and the rule "the hook is added here first" (§2) imply a namespace policy that is never written down.

**Failure scenario.** Lane A writes `export const routes: Route[]` and lane B expects `export default`. The generated TS type has `settings_schema` while the config loader reads `settingsSchema`, so settings validation silently does nothing and invalid closed-module settings reach production. Separately, a closed module ships a `PublishTarget`, but the manifest has no key for it, so it has no defined path to registration.

**Recommended change.**
- Define it in both languages.
  - TS: `export function defineModule(m: ModuleDefinition): ModuleDefinition`, where `ModuleDefinition = ModuleManifest & { routes?: Route[]; screens?: Screen[]; publishTargets?: PublishTarget[]; enrichers?: ContentEnricher[] }`, as the default export of `<module>/web.ts` and `<module>/mobile.ts`.
  - Python: `def register(registry: ModuleRegistry) -> None`, exposed through an entry point. It registers `Job`, `Connector`, `AiProvider` and the Python half of enrichers.
- Say explicitly that "`registerModule`" in AGENTS.md is this pair, or rename the hard-rule list in a follow-up so it matches.
- Pick `snake_case` for all manifest keys and fix the prose (`settings_schema`).
- Add a manifest key (or definition field) for every extension point, and specify each key's semantics in a table.
- Specify migration ordering: core first, then modules in dependency order. Add a `depends_on` field only if it is needed now (YAGNI).

### EXT-3 — Undefined types block mock-based parallel work where they carry boundary or security weight (major, high)

**Section.** §3.4 TS and Python sketches.

**Problem.** The design promises "synthetic example data so lanes can work against mocks" (§1), but these types are undefined: `RoleId`, `RouteModule`, `ScreenModule`, `TabSlot`, `EntityKind`, `PublishContext`, `Bundle`, `ContentVersionRef`, `JobRequest`, `ConnectorManifest` (fields only listed in a comment), `Resource`, `RawBatch`, `Record`, `ValidationReport`, `UpsertStats`, `Tx`, `JobContext`, `JobResult`, `Part`, `AiResult`, `DataClass`.

They fall into three groups:

| Type | Why it cannot be left to a lane |
| --- | --- |
| `JobContext` | Decides whether a job reaches the DB through a role subject to RLS or a service role that bypasses it, and whether it gets only the guarded `ctx.ai` or can construct providers directly. This is the guard's enforcement point. |
| `PublishContext`, `Bundle` | Decide whether the C0-only rule (§3.6) is enforceable (see EXT-8). |
| `Part` | Q4 depends on it (per-part class). |
| `DataClass` | The guard uses `>`. Comparing the strings `"C0"`–`"C3"` happens to work lexicographically, but a `C10` or a value-less enum breaks it. Needs to be an `IntEnum`/ordered union defined once in the schema. |
| `Record`, `Tx` | Decide idempotency and transaction ownership (EXT-7) and sync vs async (`psycopg` connection vs async). |
| `JobRequest` | Must equal the `job.schema.json` envelope, otherwise TS enqueues payloads Python rejects. |

| Type | Can be lane-owned if named as such |
| --- | --- |
| `RouteModule`, `ScreenModule` | Shell-specific (Next.js page or route handler vs RN component). Must still say whether a `Route` is a page, an API handler, or both. |
| `TabSlot`, `EntityKind` | Need the enum values and whether modules can extend them (an `EntityKind` added by a module must be expressible for `dependsOn`). |
| `Resource`, `RawBatch`, `ValidationReport`, `UpsertStats`, `AiResult` | Shape can be minimal now, but `AiResult` must carry what `ai_provenance` stores. |

**Failure scenario.** The workers lane gives `JobContext` a `db` attribute connected as the service role. A closed-module job reads a C3 `enc_` column and passes it to `ctx.ai.generate(..., data_class=C1)`. RLS never applies and the guard sees C1, so the decrypted C3 content reaches an external provider. This needs two more gaps to line up, but the contract left the door open.

**Recommended change.** Add a "Contract types" appendix with the security-bearing types fully specified: `DataClass`, `Part`, `JobContext` (fields: `db` with its DB role stated, `ai` as the *only* AI entry, `audit`, `log`, `settings`), `PublishContext`, `Bundle`, `JobRequest` (pointing at `job.schema.json`), `Record`, `Tx`. The rest get a one-line shape plus an explicit "lane-owned, may extend" marker. Ship them as TS/Python stubs with the synthetic fixtures from §4.

### EXT-4 — The fail-closed AI guard is not implementable from the contract (blocker, high)

**Section.** §3.4 `AiProvider` and the "Fail-closed guard" paragraph; §3.1 "all AI calls happen in workers".

**Problem.**
- **Signature mismatch.** The guard is `ai.generate(task, inputs, data_class, schema)` and the provider is `generate(task, inputs, output_schema)`. The intent seems to be guard-wraps-provider, but the doc does not say so, does not name the guard's module or type, and does not say whether module code can ever hold a raw `AiProvider` reference.
- **"Local" is not a provider attribute.** The guard refuses C3 "when the provider is not local", but `AiProvider` has only `id` and `max_data_class`. "Local" is undefined: same host, same VPC, on-premises, `sa-east-1`? A provider can therefore declare `max_data_class = C3` and pass the guard while being remote.
- **No routing hook.** "Routing tables … live in closed modules", but no extension point lets a closed module tell the guard which provider handles a given `task`/`data_class`. The hard-rule list has no `AiRouter`, and §2 says "if a closed module needs a new hook, the hook is added here first". So the hook is missing, or the guard picks providers by an unstated rule.
- **Multiple providers.** "When no provider is configured" implies a configured set, but `tenant.yaml` (§3.2) has no `ai` section and the manifest has no `ai_providers` key.
- **Job vs call class.** `Job.data_class` is declared and the call's `data_class` is declared separately. The rule relating them is not stated.
- **Provenance.** "Every successful call writes `core.ai_provenance`" does not say what is written. Refused calls are not mentioned at all, and auditing refusals is probably wanted.

**Failure scenario.** A closed module registers a hosted LLM provider with `max_data_class = C3` because the guard only checks `data_class > max_data_class`. The C3-local clause cannot be evaluated, so the implementer either skips it or reads it from the provider's own id. C3 data leaves the instance. This is the one invariant §2 states without qualification.

**Recommended change.**
- One public entry point, `AiGateway.generate(task: TaskId, inputs: list[Part], data_class: DataClass, output_schema: dict) -> AiResult`, reachable only via `JobContext.ai`.
- `AiProvider` gains `locality: Literal["in_instance", "external"]`. It is set by framework config at registration (deployment-attested), not self-declared by the module.
- Effective class = `max(job.data_class, declared data_class, max(part.data_class))`. Refuse if it exceeds `provider.max_data_class`, or if it is C3 and `locality != "in_instance"`.
- Add an `AiRouter` extension point, `route(task: TaskId, data_class: DataClass) -> provider_id | None`. Add it to the AGENTS.md hard-rule list in a follow-up. The framework default routes everything to `NoneProvider`.
- Specify the `ai_provenance` columns: `task`, `provider_id`, `model`, `data_class`, `input_hash`, `output_hash`, `prompt_ref` (opaque), `outcome` (including refusals).
- Define `DataClass` as an ordered type (see EXT-3).

### EXT-5 — `task` naming has no namespace and no provenance rule, which risks prompt leakage (minor, medium)

**Section.** §3.4 `generate(task: str, …)`; §3.3 `ai_provenance`; AGENTS.md rule 3.

**Problem.** `task` is a bare `str`. The design does not say who defines task names, whether the framework keeps a registry, or whether the guard validates them. Without a convention, a closed module could use descriptive tasks (for example a full instruction sentence) or embed prompt text in `inputs`. Those end up in public code examples, tests, logs, or `ai_provenance` rows. The `output_schema` of a closed task is also analytical structure and must stay closed.

**Failure scenario.** A public test for the guard uses a realistic-looking task string copied from a closed module, which leaks the shape of a closed analysis into the public repo. A provenance row stores prompt text, which then appears in a support export.

**Recommended change.** Define `TaskId` as opaque `<module_id>.<snake_name>`. The framework never interprets it except for routing lookup. Public code and tests use only `demo.*` tasks. Provenance stores `task` and an opaque `prompt_ref` (version hash) and never prompt text. Add a line to §3.4 stating that output schemas for closed tasks live in the closed module.

### EXT-6 — No versioning or evolution policy for contracts consumed by independently released modules (major, high)

**Section.** §3.4 `"requires_framework": "^0.1"`; AGENTS.md "Contracts first … frozen before lanes start; changing a contract goes through the architecture backbone".

**Problem.**
- "Frozen" covers the start of lanes but not later evolution. Closed modules live in another repo with their own release cadence, and the design does not say what "framework version" means: a git tag, the `core-contracts` package version, or a separate contract version. TS types and Python models are generated from the same schema but may be published separately (npm and PyPI or wheels) with no lockstep rule.
- Under npm semver, `^0.1` means `>=0.1.0 <0.2.0`, so every 0.x minor is a breaking boundary by definition. A JSON-schema validator still has to choose a semver library (Python and JS implementations differ on `^0.x`).
- §3.7 has a v1→v2 policy for REST but nothing comparable for extension contracts, DB `core_api` views (which modules depend on per §3.3), `job.schema.json` (jobs in the queue during a deploy), or `module.schema.json` itself (no `schema_version`, unlike `tenant.yaml`).

**Failure scenario.** The backbone adds a required field to `JobContext` and renames a `core_api` view. Closed modules built against the previous version still declare `^0.1` and pass the boot check, then fail at runtime in production. Queued jobs enqueued with the old envelope crash the new workers mid-deploy.

**Recommended change.**
- Define one **contract version** carried by `core-contracts` (TS and Python published in lockstep from the same schema). `requires_framework` refers to it, and the matching uses a specified semver implementation and range syntax.
- Additive changes are minor. Breaking changes are major, with the previous major supported for N releases (pick N) and a deprecation note.
- `module.schema.json` gets `schema_version`. `job.schema.json` envelopes carry `v`, and workers accept the current and previous `v`.
- Publish a **conformance test kit** (mock `JobContext`, `PublishContext`, fixtures) that closed modules run in their own CI against a declared contract version. That also gives lanes their mocks.

### EXT-7 — Connector execution model, idempotency and discovery are unspecified (major, medium)

**Section.** §3.4 `Connector` Protocol; §3.2 `connectors: [{ id, package: core.connectors.ibge, schedule, params }]`; §3.3 `data_source`, `data_source_run`.

**Problem.**
- **Sync vs async.** All methods are sync, which is fine in a worker process, but the design should say so. It should also say whether `fetch` may block for minutes, who enforces `rate_limit`, and whether a connector may spawn its own concurrency.
- **`since` cursor.** It is unclear where the cursor is persisted (`data_source_run`?), who advances it, and whether it is advanced only after a successful commit.
- **`upsert(records, tx)`.**
  - Who opens and commits `tx`? If the connector commits, partial runs become possible.
  - Which tables may a connector write: core tables such as `municipality`, its module's `mod_*` schema, or both?
  - What is the natural key? Idempotency requires `Record` to carry `(source_id, natural_key)` plus `reference_date`, and `upsert` to be defined as `INSERT … ON CONFLICT` semantics. §2 and §3.6 require source and reference date on every citizen-facing number, but `Record` is not required to carry them.
- **Discovery.** `package: core.connectors.ibge` implies a dotted import string. For closed connectors this means `importlib.import_module` of an arbitrary string from config, with no allow-list. The design does not say how it relates to module registration.
- `ConnectorManifest` fields (`robots`, `automation`, `auth`) have no types, and `data_class` there could conflict with the module manifest's `data_classes`.

**Failure scenario.** A connector times out after `upsert` wrote half the records and the worker retries. Without a natural key the retry duplicates indicator values, and the next publish produces two values for the same municipality and reference date, both shown to citizens.

**Recommended change.**
- State that connectors are sync and run one per worker task.
- The framework owns `tx` and the cursor: it opens `tx`, calls `upsert`, commits, then writes `data_source_run` with the new cursor, all in one transaction.
- `Record` must include `source_id`, `natural_key`, `reference_date`, `source_url`. `upsert` must be idempotent per `(source_id, natural_key, reference_date)`.
- Connectors are registered via the Python `register()` from EXT-2, and `tenant.yaml` refers to them by registered `id` instead of `package`.

### EXT-8 — Module `PublishTarget` can bypass the C0-only serializer (major, medium)

**Section.** §3.4 `PublishTarget { build(ctx): Promise<Bundle[]> }`; §3.6 "Bundles hold C0 data only; `core-publish` refuses to serialize any column not classed C0", fixed bundle-name list.

**Problem.** If `build()` returns finished `Bundle` objects (serialized JSON), module code does the serialization and the column-class check never runs. If instead `Bundle` is a list of column refs serialized by `core-publish`, the doc should say so. In addition:
- Module bundle names are not in the §3.6 list, so collisions with core names or with other modules are possible.
- `dependsOn: EntityKind[]` implies change-triggered rebuilds, but no mechanism is described.
- The citizen app has no defined way to render a module bundle except through a module `Screen`, so the two contracts are coupled without saying so.

**Failure scenario.** A closed module's target builds `indicators`-style JSON by querying a view that joins a C2 table. Nothing classifies the output, the bundle ships to the CDN, and personal data becomes public and cached offline on citizens' phones with a 90-day tombstone window.

**Recommended change.**
- `PublishContext` exposes only C0 read access (C0-classed `core_api` views and module views classed C0). `build()` returns `BundleSpec { name, records: Iterable<Record> }`.
- `core-publish` validates every field against the class catalog before hashing and uploading.
- Module bundle names are namespaced `mod-<module_id>-<name>.json`.

### EXT-9 — `NoneProvider`-only leaves the AI path unexercisable in public; a fake provider passes the cut rule (minor, medium)

**Section.** §3.4 guard paragraph ("The framework ships only `NoneProvider`"), §4 synthetic examples, AGENTS.md rule 4.

**Problem.** Rule 4 keeps prompts, routing and real providers closed, which is correct. Nothing in the design leaks analytical rules: the guard, data classes, connector protocol and IBGE connector are generic and do not let anyone assemble a competitor. In the other direction, though, every mandate needs the guard to be *testable* end to end. With only `NoneProvider` (always refuses), the demo tenant, the workers lane, and `ai_provenance` writes cannot be exercised in public CI. Each lane will then invent its own fake.

**Failure scenario.** The workers lane writes the "successful call writes provenance" path but can only test it with a closed provider in another repo. The public CI never covers it, and a regression in the provenance write ships unnoticed.

**Recommended change.** Ship a deterministic `FakeProvider` in the test or demo package. It echoes a fixture that matches `output_schema`, uses `locality = "in_instance"`, carries no prompts, and is used only with `demo.*` tasks. This adds nothing to competitive value and gives the guard and provenance a public test.

### EXT-10 — Example manifest describes a closed module; module id to schema name mapping is undefined (nit, medium)

**Section.** §3.4 manifest example (`"id": "pro.secretaria"`, `minutes.approve`); §3.3 `mod_<module_id>`; §5.

**Problem.** The public contract's only manifest example describes the surface (roles, permissions) of a real closed module. That is not a rule-3 violation, but it publishes closed product scope, and it is avoidable because §4 already plans a `demo.hello` module. Separately, `mod_<module_id>` with id `pro.secretaria` produces `mod_pro.secretaria`, which is not a valid unquoted Postgres identifier. The id-to-schema mapping (dots to underscores? length limit of 63?) is not stated, and two ids could collide after mapping (`a.b_c` vs `a_b.c`).

**Recommended change.** Use `demo.hello` in the example. Constrain module ids to `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)?$` and define `schema = "mod_" + id.replace(".", "__")`, rejecting at boot any id whose mapped schema collides with another or exceeds 63 bytes.

## Answers to open questions in my lens

### Q2 — Should `Connector` also exist in TypeScript?

**No, keep it Python-only for now** (confidence: medium). A second-language connector contract doubles the surface to freeze and version (EXT-6). It would also split the idempotency, cursor and transaction rules (EXT-7) across two runtimes, and §3.1 already concludes that ingestion belongs in workers. "Lightweight federal APIs" are equally lightweight in Python. AGENTS.md's YAGNI ladder applies: revisit only if a concrete connector needs to run in the web runtime (none is named). If one ever does, the TS side should *enqueue a Python job*, as `ContentEnricher` does, rather than introduce a second `Connector` protocol.

### Q4 — Is the fail-closed guard enough without classifying each `Part`?

**No** (confidence: high). The guard as written trusts one caller-declared `data_class`. Declaring one class per call is exactly the mistake that leaks C3: a job assembles inputs from several columns and declares the class of the "main" one. Recommendation, folded into EXT-4:
- `Part` carries its own `data_class`.
- Effective class = `max(job.data_class, declared, max(part.data_class))`, and the guard refuses if `declared` is lower than the effective class. That mismatch is a bug signal, so log it to `audit_event` without content.
- Provide a framework helper that builds a `Part` from a column reference and reads the class from the column's `COMMENT … 'class=Cn'` (§3.3), so classes come from the catalog instead of developer memory.
- Free-text `Part`s with no column origin default to the job's class.

This costs one field and one `max()`, and it turns the guard from "trust the caller" into "trust the catalog".
