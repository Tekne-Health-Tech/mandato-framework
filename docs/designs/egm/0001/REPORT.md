# EGM review — Design 0001: Core contracts (consolidated report)

- **Design:** `docs/designs/0001-core-contracts.md` (commit `328d1e0`, status "draft for Elephant-Goldfish review")
- **Date:** 2026-11-14 · **Mode:** uninterrupted · **Design doc not modified**
- **Stage reports:** [stage 0, scope and method](stage0-scope-and-method.md) · stage 1 goldfish reviews: [security & privacy](stage1-goldfish-security-privacy.md), [data model](stage1-goldfish-data-model.md), [extension contracts](stage1-goldfish-extension-contracts.md), [sync/publish/API](stage1-goldfish-sync-publish-api.md), [clarity & YAGNI](stage1-goldfish-clarity-yagni.md) · stage 2 verification: [A](stage2-verification-a.md), [B](stage2-verification-b.md)

## Verdict

**Not ready to freeze. Revise and run the review again.**

The overall direction is sound, and the reviewers found no reason to change it:
- one database per instance
- a language-neutral module manifest
- all AI calls happen in workers, behind one fail-closed guard
- citizens read static C0 bundles
- data classes are part of the schema

What blocks the freeze is under-specification. Five contract areas cannot be implemented independently by parallel lanes as written. Lanes would each invent different shapes for them, which is the failure §1 sets out to prevent.

| | Stage 1 (raw) | After stage 2 verification |
| --- | --- | --- |
| Findings | 90 (5 reviewers) | 83 kept, 7 rejected |
| Blockers | 12 | 7 findings, in **5 clusters** |
| Majors | 45 | 35 findings, in **15 clusters** |

Severity rubric: **blocker** means the contract cannot be frozen as written. **Major** means lanes will diverge or rework is likely. **Minor** means it can be fixed in the same revision with little effort.

## Blockers (must change before freeze)

### B1. The core SQL column contract is not in the repo
*DB-1, CLR-1, DB-11 · §3.3 line 76*

§3.3 says "Columns as in the platform data model (03)", and that document is not in this public repo. The database, publish, auth and demo lanes cannot write `0001_core.sql` or mocks from this repo alone. Reviewers also cannot check the class of each column.

Those columns are not secret, since they will ship publicly in the migration anyway. So inline them.

**Change:** add an appendix table for the 17 tables in 0001 with:
- column
- type
- class
- prefix
- nullability
- the conventions every published table shares (`updated_at`, a soft-delete/tombstone column)

Keep the private doc as rationale only.

### B2. Which database surfaces clients can reach, and where `aal2`/RLS are enforced
*SEC-1, DB-2, DB-5, SYNC-14, CLR-19 · §3.3 RLS, §3.7 Auth, §6 Q1*

`aal2` and rate limiting are specified only at the Next.js API. A Supabase JWT, however, can also reach PostgREST/RPC on any schema the project exposes.

There are also two RLS gaps:
- `core_api` views bypass RLS unless they are created with `security_invoker = true`.
- `has_role` ignores `aal2`.

Nothing says which identity `auth.uid()` maps to in `app_user`, or who counts as "staff".

**Change:** add a short "Access surfaces" subsection that covers:
1. Which schemas PostgREST exposes. The recommendation is none, or a single `api` schema of `security_invoker` views.
2. That `has_role` also checks `(auth.jwt()->>'aal') = 'aal2'` for staff roles, and is `SECURITY DEFINER` with a pinned `search_path`.
3. That `app_user.id` = `auth.users.id`. This is not UUIDv7, so say so.
4. That "staff" means any principal holding a role.

### B3. The fail-closed AI guard cannot be built or enforced as specified
*SEC-2, EXT-4, CLR-18, EXT-5, EXT-9, §6 Q4 · §3.4 lines 128–134*

There are three problems:
- `AiProvider.generate(task, inputs, output_schema)` and the guard's `ai.generate(task, inputs, data_class, schema)` disagree.
- "Local" is not a provider attribute.
- `DataClass` has no defined ordering, and there is no hook that routes a task to a provider. Without a routing hook, closed modules cannot plug in routing, even though the design says they own it.

The guard also trusts a `data_class` label supplied by the caller.

**Change:**
- Define `DataClass` as an ordered enum (C0 < C1 < C2 < C3).
- Add `locality: 'local' | 'external'` to `AiProvider`.
- Add `Part.data_class`, set by the framework where the data is loaded (from the column class), with unknown treated as C3. The guard uses the maximum of the job's class, the declared class and each part's class.
- Define a `ProviderRouter` extension point. The framework default always returns `NoneProvider`.
- Add a deterministic `EchoProvider` for CI and the demo tenant. It contains no prompts, so the cut rule still holds.
- Constrain `task` to a namespaced id (`<module>.<task>`).
- Say what `ai_provenance` stores: ids and hashes, never prompt text.

### B4. Module registration, build-time composition and migrations are undefined
*EXT-1, EXT-2, CLR-12, CLR-13, DB-4 · §3.1, §3.2, §3.4*

`registerModule` exists only as a manifest. The design does not define:
- what the files it lists must export
- how a closed module's TS code gets into the Expo and Next.js builds without the public repo naming it. Store apps cannot load code at runtime.
- manifest keys for `PublishTarget`, `ContentEnricher`, `Connector` and `AiProvider`
- what "instance boot" is
- who applies module migrations, in what order, as which DB role, and with what rollback/disable behaviour

**Change:**
- Specify composition. The usual pattern is a build-time generated registry file in the instance's build workspace, produced from `tenant.yaml` `modules[]` plus each package's manifest. The public repo ships the generator and never the list.
- Specify the export shape of each manifest entry, and add the missing manifest keys.
- Define the boot sequence: validate `tenant.yaml`, then resolve manifests, then check `requires_framework`, then run migrations in topological order under a per-module DB role, then start.
- **Ask legal** (do not decide in the design) how AGPL §13 interacts with closed modules that are statically bundled into the same web and mobile artifacts. The answer may change the composition model, so it gates the freeze of B4.

### B5. The offline read path mixes two sync models
*SYNC-2, SYNC-1, CLR-16, SYNC-3, SYNC-4, §6 Q3 · §3.6*

Clients detect changes by whole-bundle `sha256`, but records also carry per-record tombstones and `updated_at`. The design never says whether the app replaces a bundle or merges upserts.

Two further problems:
- Newest-first pages of 100 shift on every insert, so every page hash changes and 3G clients re-download everything.
- A device offline for more than 90 days keeps deleted records forever. This includes legal or electoral takedowns.

Once app builds ship to the stores, the apply model cannot be fixed from the server.

**Change:** pick one model and write the client algorithm in the contract. The recommendation is **snapshot per stable partition**:
- Bundles are partitioned by a stable key, such as content by month or ID range, not "newest page N".
- The app replaces each changed bundle atomically, so deletions propagate when a record is absent.
- The manifest carries a monotonic `generation`, `tombstones_since`/`min_generation` (anything older triggers a full resync), `min_app_version`, and a small `takedowns[]` list.
- Bundle URLs are content-addressed and immutable. Only `manifest.json` is mutable.

## Major (fix in the same revision)

| # | Cluster | Findings | Change in short |
| --- | --- | --- | --- |
| M1 | Column classification and the C0-only publish guard | SEC-3, DB-8, SYNC-6, CLR-6, EXT-8 | Every column gets a `class=` comment, not only prefixed ones, and `enc_` is included in the CI rule. Draft and published rows share a table, so publish filters both by column class **and** by row state. Module `PublishTarget`s return records through the core serializer, never raw `Bundle[]`. Module bundle names are namespaced. |
| M2 | `DataClass` and the prefix vocabulary | CLR-5 | Define C0–C3 and each prefix (`pii_`, `phi_`, `piim_`, `enc_`) in one table: meaning, minimum class, whether it is encrypted. `piim_` is never explained today. |
| M3 | Role model | DB-7, SEC-7, DB-5 | Namespace module roles (`<module>.<role>`). Add a `core.permission` table for manifest `permissions`. Specify what disabling a module does to its roles and assignments. Turn "`operador` has no select on C3" into a CI test over all policies. Specify who may write `role_assignment`. |
| M4 | Module id → schema name | DB-3, EXT-10, CLR-11 | Define the module id grammar (`^[a-z][a-z0-9_]{0,30}(\.[a-z][a-z0-9_]{0,30})?$`) and an injective mapping to schema names, or a registry-assigned short name, within 63 bytes. Say whether `core.*` modules get their own schema. List the `core_api` views. |
| M5 | Audit actor and integrity | DB-6, SEC-4 | Workers, the service role and migrations set the actor via `set_config('app.actor', …)`. Triggers record `actor_kind`. Revoke `EXECUTE` on `core.audit()` from client roles. Revoke `TRUNCATE` too. |
| M6 | Encryption contract | SEC-5 | Specify the ciphertext envelope (version, key id, AAD), key hierarchy and rotation, and blind indexes for lookup and uniqueness. Cover `phi_`/`piim_`. If rows are AAD-bound, note the conflict with ids generated in the database. |
| M7 | Personal-data lifecycle (LGPD) | SEC-6, SEC-8 | Each module declares retention and a data-subject-request hook (export/erase) in the manifest. Audit keeps ids, not content, and is retained under LGPD art. 16 I / art. 37. Specify retention and hashing for idempotency keys and rate-limit keys on public writes. |
| M8 | Job envelope and the queue | CLR-14, EXT-3, SEC-9 | Add the queue table to 0001. Define `job.schema.json` (`v`, `id`, `queue`, `data_class`, `idempotency_key`, `attempts`, `run_after`, `payload_ref`). Payloads carry references, never C2/C3 plaintext. Define `JobContext`, the place where the guard and actor are enforced. |
| M9 | Contract types lanes mock against | EXT-3 | Define `PublishContext`, `Bundle`, `EntityKind`, `ContentVersionRef`, `JobRequest`, `Record`, `Tx`, `Part`, `AiResult` at least to field level. The rest can stay lane-local. |
| M10 | Connector contract | EXT-7, CLR-15, YAGNI-5 | Use one connector identity (`source_id`) across config, the manifest, `data_source` and bundles. Specify sync vs async, who owns the transaction, where the `since` cursor lives, natural keys and idempotent `upsert`. Resolve connector packages through an entry-point allow-list rather than a free dotted import. Give the cron timezone. |
| M11 | Content state machine and publish trigger | CLR-17, YAGNI-1 | Define `content_item` states and transitions, which state counts as "published", what triggers a publish, and the publish target storage. Keep `dependsOn` only if `EntityKind` is defined. |
| M12 | Bundle schema evolution | SYNC-5, SYNC-10, EXT-6, CLR-26 | Bundles follow "ignore unknown fields". The manifest carries `min_app_version`. Define what "one app release cycle" means for `/api/v1` sunset. Version contracts semver-like (0.x allows breaks only through the change process). |
| M13 | Media assets on the read path | SYNC-9 | Define how records reference media (URL, dimensions, sha256, size budget) and that EXIF/GPS is stripped at upload. |
| M14 | Anonymous public writes | SYNC-11, SYNC-12 | Public writes are exempt from the JWT rule. Define the rate-limit key (hashed and rotated, no raw IP stored), plus the scope, TTL and conflict behaviour of `Idempotency-Key`. |
| M15 | Freeze process and change control | CLR-2, CLR-4, CLR-23 | Add a "Definition of done for E0.0" section listing the artifacts (schemas, SQL, TS/Py stubs, fixtures, CI checks), who signs off (the backbone, verified by a non-executor per AGENTS.md), and how a frozen contract changes. Add a one-block repo layout. Say who owns `tenants/demo/`. |

## Minor and nit (batch edit)

- **Naming and consistency:**
  - `settingsSchema` → `settings_schema` (CLR-7).
  - The `modules` key is shown as a list but described as a map (CLR-8).
  - Line 52 still says "drives `theme` rows" after the rename to `cause` (DB-13).
  - Cause icons are defined in both tenant.yaml and tokens; keep one (CLR-9, SYNC-16).
- **AI label text:** it "comes from the instance config", but `tenant.yaml` has no such key. Add `labels.ai_assisted` (SYNC-7, CLR-10).
- **"Every number carries source and date":** the rule is stated in §2 but only indicator bundles carry it. Enforce it on every numeric field in C0 bundles, or narrow the claim (SYNC-8, CLR-24).
- **API conventions:**
  - date-only and period values
  - cursor stability
  - field-level validation errors in RFC 9457 `errors[]`
  - the `type` URI base

  (SYNC-13, CLR-22.)
- **Tokens:** check every contrast pair in both light and dark mode. Add `link/surface` and `muted/surface`. Add one usage line per colour role (`brand` vs `accent` vs `cta`) (SYNC-15, SYNC-17).
- **Fixtures:**
  - "3 users (one per role)" vs 4 seeded roles.
  - Add fixtures for paging, tombstones and the C0 filter.

  (SYNC-18, CLR-20.)
- **Ids:** `core.uuid7()` must be a SQL implementation, since native `uuidv7()` arrives only in PG 18. State that `municipality` is keyed by `ibge_code char(7)` (DB-9, DB-10). The single `instance` row needs a constraint, and the doc should say which side wins, the row or `tenant.yaml` (DB-12).
- **Config:** connector credentials are by reference only (`*_secret_ref`), never inline (SEC-10). `flags.electoral_restricted_mode` needs defined behaviour, or should come out of the frozen schema (CLR-21).
- **Manifest example:** replace `pro.secretaria` with `demo.hello` or another fictitious module. A public contract doc should not describe a closed module's roles and permissions (EXT-10).
- **YAGNI, low-cost trims:**
  - drop `Screen.tab` until the gabinete app is in scope (YAGNI-3)
  - consider JSON Schema validation instead of Python codegen (YAGNI-6)
  - `pronoun_style` can stay, since its use is UI copy only (YAGNI-4)
- **Outside the design:** the CI licence allow-list is broader than AGENTS.md (CLR-27). File it separately.

## Rejected in verification (for the record)

| Finding | Why it was rejected |
| --- | --- |
| CLR-3 | "Inline private ADRs" goes too far. §2 already states each constraint as a one-line rule, and private reasoning stays private under AGENTS.md rules 3 and 4. |
| CLR-25 | Open questions are expected in a draft sent for review. |
| YAGNI-2 | Per-module schemas conflict with nothing once no schema is exposed (B2). |
| YAGNI-7 | The `office` enum costs nothing, and the framework serves every mandate type. |
| YAGNI-8 | `ContentEnricher` is a published extension point in AGENTS.md hard rule 1. |
| YAGNI-10 | It only rolls up other findings. |
| CLR-22 | The file is planned, not missing. |

The verifiers also scaled back several findings (SEC-1, SEC-6, SEC-8, EXT-2, DB-5). They still count, at the adjusted severity.

## Answers to the design's open questions (§6)

1. **`mod_<id>` schemas vs prefixed tables.** Keep per-module schemas. The friction with Supabase disappears if PostgREST exposes no internal schema: clients go through `/api/v1`, or at most a single `api` schema of `security_invoker` views. Define the id→schema mapping (M4).
2. **TypeScript `Connector`.** Python-only is acceptable. If a lightweight federal API must be triggered from TS, enqueue a Python job rather than add a second protocol.
3. **90-day tombstones.** Not enough on their own. The server must declare the horizon (`tombstones_since` / `min_generation`), and clients older than it do a full resync. With the snapshot-per-partition model in B5, deletions propagate when a record is absent, and the window matters only for the per-record merge. Legal takedowns go in a separate small manifest list.
4. **Is the guard enough without classifying each `Part`?** No. Each `Part` carries a class set by the framework where the data is loaded. The guard takes the maximum, unknown means C3, and the routing hook in B3 sees the effective class.

## Elephant notes (context the goldfish reviewers did not have)

- **Public-repo hygiene held up:** no reviewer found prompts, analytical rules or real data in the design. The only leak-adjacent item is the `pro.secretaria` example, listed under minor.
- **Recommended edit order:** B1 + M2 (the data dictionary) first, because B2, B3 and M1 all depend on per-column classes. Then B4 (it needs the legal answer) and B5 (it is independent and can run in parallel).
- **This run did not follow AGENTS.md "cross-provider review":** every reviewer and verifier ran on the same provider as the orchestrator. For a design review that is a limitation, not a rule breach. Still, the revised design's security clusters (B2, B3, M1, M3, M5–M7) should get the second reviewer from a different provider that AGENTS.md requires for security-sensitive changes.
- **The plugin did not load:** `/egm:egm-review` did not run in this session (the workspace is untrusted, see stage 0). Its stage structure was reproduced by hand, so the reports may not match the plugin's own format or rubric exactly. After the design is revised, run the plugin's re-review loop once the workspace is trusted.
