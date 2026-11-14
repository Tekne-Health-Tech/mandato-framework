# Stage 2 — Adversarial verification (B): sync/publish/API, clarity & YAGNI

Design under review: `docs/designs/0001-core-contracts.md` (draft, 2026-11-14).
Findings verified: `stage1-goldfish-sync-publish-api.md` (SYNC-1..20) and `stage1-goldfish-clarity-yagni.md` (CLR-1..27, YAGNI-1..10). 57 findings in total.

## Method

The verifier read `AGENTS.md`, `.github/workflows/ci.yml`, `CONTRIBUTING.md`, the design, and both stage 1 reports. To check for cross-report conflicts it also read the finding tables of the other three stage 1 reports (DB-*, EXT-*, SEC-*). The goal for each finding was to refute it. Four checks were applied:

1. Re-read the quoted design text and test whether the reviewer's reading is the only reasonable one. If the doc could have meant something else, the finding is an ambiguity, not a flaw.
2. Check the technical claims (CDN caching and ETag, store-app update behaviour, Postgres `now()`, Supabase auth ids, RFC 9457, WCAG 1.4.3/1.4.11/1.4.1, LGPD treatment of IP addresses) against known behaviour.
3. Ask whether the issue affects more than one lane, or a shape that ships inside store apps or closed modules. If one lane can decide it locally without affecting others, it is at most **minor**. If a later change is purely additive (an optional key or field), it does not stop the freeze.
4. YAGNI cuts are accepted only when the cost is real now, and only if no other reviewer's finding depends on the thing being cut.

**Severity rubric** (same as stage 0):
- **blocker**: the contract cannot be frozen as written.
- **major**: lanes will diverge, or rework is likely.
- **minor**: clarify before or during the freeze.
- **nit**: cosmetic.

**Verdicts:**
- **CONFIRMED**: the claim holds as stated, although the severity may still change.
- **PLAUSIBLE**: the issue is real but partly overclaimed, speculative, or narrower than stated.
- **REJECTED**: a misreading, already covered, or the recommendation does more harm than good.

## Verdict table

| ID | Orig. sev. | Verdict | Adj. sev. | Duplicate-of / cluster | One-line reason |
| --- | --- | --- | --- | --- | --- |
| SYNC-1 | blocker | CONFIRMED | major | = CLR-16 · A | The literal reading (positional pages, newest first) does change every page hash on each insert. But the app finds bundles through `manifest.json` `bundles[]`, so the partition scheme is a publish-side choice that can change without an app release. The cross-lane part is SYNC-2. |
| SYNC-2 | blocker | CONFIRMED | blocker | A (anchor) | "Downloads only bundles whose sha256 changed" (snapshot) and "tombstones … for delta sync" (upsert) are two different client apply models. Store apps that ship one cannot be fixed from the server. |
| SYNC-3 | major | CONFIRMED | major | A · = §6 Q3 · CLR-25 | The client needs a server-declared horizon or resync signal. It becomes moot if SYNC-2 picks snapshot-per-partition. |
| SYNC-4 | major | CONFIRMED | major | A | Two parts are cross-lane contract: client-side all-or-nothing apply and a monotonic `generation` (rollback guard). Content-addressed URLs, TTLs and upload order are publish-lane local, because the manifest already carries `url`. |
| SYNC-5 | major | CONFIRMED | major | B (anchor) · ~ EXT-6 | "Clients ignore unknown fields" and a `min_app_version` signal must be in the first store build. They cannot be added later. |
| SYNC-6 | major | CONFIRMED | major | = CLR-6 = DB-8 ⊂ SEC-3 · C | The quoted texts match. Unprefixed columns have no class, and drafts and published rows share `content_item`. |
| SYNC-7 | major | CONFIRMED | minor | = CLR-10 · D | True: §3.2 has no key for the label. But adding an optional key to the tenant schema is additive and does not break the freeze. The `ai_label` enum proposal is speculative. |
| SYNC-8 | major | PLAUSIBLE | minor | = CLR-24 · E | The §2 vs §3.6 gap is real. "Cannot be rendered offline" is overclaimed, because each record already carries `source_url`. `figures[]` in prose is new scope. |
| SYNC-9 | major | PLAUSIBLE | major | — | How content records reference media is a cross-lane bundle shape (publish, web, mobile) and the doc says nothing about it. EXIF stripping and cache budgets are publish- and mobile-lane local. |
| SYNC-10 | major | CONFIRMED | minor | B · = YAGNI-9 | "One app release cycle" is not measurable. But no `/api/v2` exists yet, and the part that must ship in v1 clients (the minimum-version signal) is SYNC-5. |
| SYNC-11 | major | CONFIRMED | major | F (anchor) · ~ SEC-1, SEC-8 | §3.7 makes a Bearer JWT the blanket rule but also accepts writes "from the public". Citizen identity and the rate-limit key are undefined. IP addresses are personal data under LGPD. |
| SYNC-12 | minor | CONFIRMED | minor | F · ~ SEC-8 | Most of it is local to the API lane. Two parts are cross-lane: the client generates the key, and the data class of stored rows matters (SEC-8). |
| SYNC-13 | minor | CONFIRMED | minor | G | Real gaps: date-only values vs "ISO 8601 with offset", cursor semantics, field-level errors. All belong in `docs/api-conventions.md`, which is an E0.0 deliverable. |
| SYNC-14 | minor | CONFIRMED | major (merged) | H · ⊂ CLR-19, SEC-1, DB-5 | Taken alone this is minor. It is merged into the auth-identity cluster, which is major because where `aal2` is enforced (API vs RLS) is security-relevant and spans lanes. |
| SYNC-15 | major | PLAUSIBLE | minor | J | Correct that `link/surface`, `muted/surface` and status text are not checked, and that per-mode checking is not stated. Partly overclaimed on WCAG: 1.4.11 does not require a button fill to contrast with `bg` when the label identifies the control, and `link` vs `fg` 3:1 is a sufficient technique (G183), not a requirement. The pair list belongs to the theme lane. |
| SYNC-16 | minor | CONFIRMED | minor | ⊂ CLR-9 · I | `causes[].icon` and `icons.causes` both exist, with no precedence rule. |
| SYNC-17 | minor | PLAUSIBLE | minor | J | Role semantics are undefined. The theme, web and mobile lanes need one line per role. |
| SYNC-18 | minor | CONFIRMED | minor | = CLR-20 · K | "3 users (one per role)" vs 4 seeded roles is a factual contradiction. The negative-fixture suggestions are sound. |
| SYNC-19 | minor | PLAUSIBLE | nit | A | The claim about Postgres `now()` is correct, but the design syncs by `sha256`, not timestamps. Watermark choice is publish-lane local. |
| SYNC-20 | minor | PLAUSIBLE | nit | A | Manifest bundle names are opaque to the client, so the publish lane can partition later. A size budget is useful but not part of the freeze. |
| CLR-1 | blocker | CONFIRMED | blocker | = DB-1 · L | "Columns as in the platform data model (03)" freezes by reference to a document that can change on its own and that the reviewers cannot see. The columns are not private content (they will be public in `0001_core.sql` anyway), so inlining them costs nothing. |
| CLR-2 | blocker | PLAUSIBLE | major | M · versioning part = EXT-6 | AGENTS.md already covers sign-off (DoD by a non-executor) and the change path (backbone). The artifact checklist is mostly implicit in the §3 headings. The individual contracts can be frozen without a §7. |
| CLR-3 | blocker | REJECTED | nit | — | §2 already gives each ADR a one-line normative statement, and ADR-0006 appears in a YAML comment. AGENTS.md rules 3 and 4 keep planning rationale private on purpose. The only residual is rewording §3.1 so it states the decision instead of rebutting an unseen document. |
| CLR-4 | major | PLAUSIBLE | minor | M | The lane plan lives in private planning by design. One real local issue remains: who produces `tenants/demo/` (§4 vs the demo lane). |
| CLR-5 | major | CONFIRMED | major | N · ~ EXT-3, EXT-4, SEC-5 | `piim_` is never explained. Encryption is not stated for `phi_`/`piim_`. The `DataClass` type and ordering are used across JSON, Python and SQL. |
| CLR-6 | major | CONFIRMED | major | = SYNC-6 · C | See SYNC-6. |
| CLR-7 | major | CONFIRMED | minor | I · ~ EXT-2 | The JSON manifest example (`settings_schema`) is canonical, and the prose is the error. A one-paragraph casing rule fixes it. |
| CLR-8 | major | CONFIRMED | minor | I | Prose `modules.<id>.settings` vs the list example is a real contradiction. It needs a one-line fix inside the config lane. |
| CLR-9 | major | CONFIRMED | minor | I · ⊃ SYNC-16 · DB-13 | Three small fixes: the path base, a stale comment (nit), and a single source for icons. None of them stops a freeze. |
| CLR-10 | major | CONFIRMED | minor | = SYNC-7 · D | See SYNC-7. |
| CLR-11 | major | CONFIRMED | major | = DB-3 · EXT-10 · O | `mod_pro.secretaria` and `mod_demo.hello` are not valid unquoted identifiers. Whether `core.*` modules get their own schema is also undefined. |
| CLR-12 | major | CONFIRMED | major | P · ~ EXT-1, DB-12 | The web app and the workers both "boot" and both validate. Where config lives, how modules are discovered, and the precedence between `instance` row and file all span lanes. |
| CLR-13 | major | CONFIRMED | major | = EXT-2 · P · ~ DB-7 | No `registerModule` signature, no export shape, and `permissions` has no table. A pt-BR `label` in the manifest conflicts with AGENTS rule 5. |
| CLR-14 | major | CONFIRMED | major | Q · ~ EXT-3, SEC-9 | §2 says "Postgres-backed queue", but the 0001 table list has no queue table, and `JobRequest` and the envelope fields are undefined. The web and workers lanes meet here. |
| CLR-15 | major | CONFIRMED | major | R · ~ EXT-7, EXT-3 | The identity `connectors[].id` / `source_id` / `data_source` / bundle name spans lanes, and closed connectors implement this protocol. Cron time zone and runner order are lane-local. |
| CLR-16 | major | CONFIRMED | major | = SYNC-1 · A | See SYNC-1. |
| CLR-17 | major | CONFIRMED | major | S · ~ EXT-8 | The content states and the "published" predicate are needed by the content, publish and demo lanes ("5 items in different states"). |
| CLR-18 | major | CONFIRMED | major | = EXT-4 ⊂ SEC-2 · T | The text is confirmed: the guard checks "not local", but `AiProvider` has no locality attribute. Verifier A may raise this cluster to blocker. |
| CLR-19 | major | CONFIRMED | major | H (anchor) · ~ SEC-1, DB-5 | Supabase generates `auth.users.id` (not UUIDv7), so "ids are UUIDv7 from `core.uuid7()`" cannot hold if `app_user.id = auth.uid()`. "Staff" is undefined. |
| CLR-20 | minor | CONFIRMED | minor | = SYNC-18 · K | See SYNC-18. |
| CLR-21 | minor | CONFIRMED | minor | — | The flag is in the schema, but nothing says what it does. Either specify it or leave it out of schema v1. |
| CLR-22 | minor | REJECTED | nit | G | Every §3 heading names a file that E0.0 will create (for example `tokens.schema.json`), so "referenced but absent" misreads the convention. The error-type catalog point is covered by SYNC-13. |
| CLR-23 | minor | PLAUSIBLE | minor | M | Workspace tool, Python import root and codegen output paths are worth one tree block. The backbone can settle them as E0.0 scaffolding. |
| CLR-24 | minor | CONFIRMED | minor | = SYNC-8 · E | See SYNC-8. |
| CLR-25 | minor | REJECTED | — | A, O | A draft submitted for review is expected to have open questions. This review (stage 3) supplies the defaults. |
| CLR-26 | minor | PLAUSIBLE | minor | B · ⊂ EXT-6 | Python can evaluate npm-style ranges with a permissive library (for example `semantic_version`'s `NpmSpec`, BSD). The real gap, which package's version counts as "framework version", is EXT-6. |
| CLR-27 | nit | CONFIRMED | nit | — | The CI allow-list adds CC0-1.0, Unlicense, BlueOak-1.0.0 and Python-2.0. This is outside the design and does not affect the freeze. |
| YAGNI-1 | major | PLAUSIBLE | minor | S · ~ EXT-3 | `dependsOn` does not force a dependency engine, because the framework can ignore it and rebuild everything. The real cost is defining `EntityKind`. Dropping it now and re-adding it as optional later is non-breaking. |
| YAGNI-2 | major | REJECTED | — | O · conflicts with DB §6-Q1, DB-4 | The DB reviewer keeps per-module schemas and builds per-module owner roles on them (DB-4). The PostgREST friction disappears if no schema is exposed, since §3.7 puts the API in Next.js. The reviewer's own counterpoint says retrofitting is expensive. The `__` prefix still has the 63-byte issue. |
| YAGNI-3 | minor | PLAUSIBLE (tab only) | nit | — | Cutting `variant` is rejected. §2 (ADR-0003) fixes both app variants, and closed modules are exactly the consumers of gabinete screens. If `variant` were re-added later as optional, a default of `citizen` would be unsafe. Making `tab?` shell-decided is reasonable. |
| YAGNI-4 | minor | PLAUSIBLE | nit | — | The key is marked "(UI copy only)". Lanes may render neutral copy and ignore it, so "multiplies every string" is overclaimed. Gendered titles in pt-BR are a near-universal need. |
| YAGNI-5 | minor | PLAUSIBLE | nit | R | A single-resource connector can return `[Resource(params)]`. Closed state connectors, which are out of scope here, will enumerate. |
| YAGNI-6 | minor | PLAUSIBLE | minor | — | Two generators plus drift CI is a real cost now. But closed Python modules also consume the manifest model, so the hand-written-`TypedDict` alternative has to be weighed against them. |
| YAGNI-7 | minor | REJECTED | — | — | The framework serves every mandate (cut rule 4), so all four offices are in scope. Freezing enum values costs nothing. Low confidence was self-declared. |
| YAGNI-8 | minor | REJECTED | — | — | `ContentEnricher` is a named published extension point in AGENTS.md hard rule 1. Having no consumer in this repo is expected for every extension point, because the consumers are closed. The event alternative is a design option, not a YAGNI cut. |
| YAGNI-9 | nit | CONFIRMED | nit | = SYNC-10 · B | See SYNC-10. |
| YAGNI-10 | major | REJECTED | — | aggregate of L, N, C, H, P, Q, S, A, K | This is a summary of other findings. Counting it on its own double-counts them. Its one new item, mock fixtures beyond §4, is folded into K. |

## Notes on rejected and downgraded items

**SYNC-1 / CLR-16 (blocker → major).**
- The reviewer read the text correctly. "Newest first, 100 items per page" with `content-<page>.json` most naturally means positional pages. Each insert at the head shifts every item, so every hash changes. The doc may have meant stable pages numbered from the oldest, which would make this an ambiguity rather than a flaw. Either way it needs fixing.
- It is not a freeze blocker. The app finds bundles through `manifest.json` `bundles[]` (`name`, `url`, `sha256`), so how content is partitioned is decided by the publisher and can change without an app release.
- What does ship in apps is the apply model (SYNC-2) and the atomic-apply rule (SYNC-4). Those carry the blocker.
- The partial-sync drift in the failure scenario is fixed by SYNC-4's all-or-nothing apply, not by changing the paging.

**SYNC-7 / CLR-10, SYNC-10, CLR-7, CLR-8, CLR-9 (major → minor).** Each is a one-line contradiction, or a gap that an additive optional key or wording change closes. None changes a shape that other lanes have already coded against.

**SYNC-8 / CLR-24 (major → minor).**
- Indicator records carry `source_url`, so offline rendering of a source is possible. What is missing is a display name.
- Enforcing sources for numbers inside free prose is an editorial rule. The narrower fix is to scope §2 to indicators for v1.

**SYNC-15 (major → minor).**
- The missing pairs (`link/surface`, `muted/surface`, status text) and the unstated per-mode check are correct.
- On WCAG 1.4.11 (non-text contrast, 3:1): it applies to the visual information needed to identify a component, such as an input border. A filled button whose text label identifies it does not need its fill to contrast with `bg`.
- Link vs surrounding text at 3:1 is technique G183, one sufficient way to meet 1.4.1, not a requirement.
- The theme lane owns the pair list. Adding pairs later only breaks mandate themes, which are fixable.

**SYNC-19, SYNC-20 (minor → nit).** The client keys sync on `sha256`, not on timestamps. Bundle names are opaque to the client. Both topics are publish-lane implementation choices.

**CLR-2 (blocker → major, PLAUSIBLE).**
- AGENTS.md already says who signs off (definition of done is verified by a non-executor) and how changes flow (through the architecture backbone).
- The §3 headings name every artifact path.
- The real gap is contract versioning for separately released closed modules, which is EXT-6.
- A §7 checklist is useful, but its absence does not make the contracts themselves unfreezable.

**CLR-3 (blocker → REJECTED, residual nit).**
- The repo is deliberately public, and planning lives in a private repo (AGENTS.md; hard rules 3 and 4).
- §2 already turns each cited ADR into a one-line normative constraint. That is the "short summary" a public contract needs.
- Publishing rationale is neither required for a freeze nor allowed by the cut rule.
- Residual: §3.1 rebuts "the planning docs", which a public reader cannot check. Reword it to state the decision.
- Contrast with CLR-1, which is kept as a blocker. Column definitions are not private material, and they will be public in the migration anyway.

**CLR-4 (major → minor).** Lane scope lives in the private execution plan by design. The only cross-lane collision it shows is the ownership of `tenants/demo/`.

**CLR-22 (REJECTED).** The §3.7 heading names a deliverable path, as every other §3 heading does. The error-type catalog is kept under SYNC-13.

**CLR-25 (REJECTED).** Open questions in a draft sent for Elephant-Goldfish review are expected to be open. Stage 3 answers them.

**YAGNI-1 (major → minor).** The cost is defining `EntityKind`, not building an engine. Dropping the field and re-adding it later as optional is still a reasonable trade.

**YAGNI-2 (REJECTED).** Cutting per-module schemas would undermine DB-4: per-module owner roles are what make "modules touch `core` only through FKs and `core_api`" enforceable. It also contradicts the DB reviewer's answer to §6 Q1. The underlying issues are real and stay in cluster O: the dotted-id mapping (CLR-11/DB-3), RLS bypass through `core_api` (DB-2), and whether the Data API is exposed at all.

**YAGNI-3 (minor → nit, partially rejected).** `Screen.variant` must stay. The citizen and gabinete variants come from the accepted stack decision. Closed modules are expected to register gabinete screens, and without `variant` a staff screen with C2/C3 data could be mounted in the citizen app. Only `tab?` is a fair YAGNI cut.

**YAGNI-4, YAGNI-5 (minor → nit).** In both cases a lane can choose the trivial implementation: neutral copy, or a single `Resource`. The claimed cost is not forced.

**YAGNI-7 (REJECTED).** The framework is for every mandate. Enum values cost nothing and are not speculative.

**YAGNI-8 (REJECTED).** `ContentEnricher` is one of the extension points that AGENTS.md hard rule 1 publishes. Removing it changes the repo's boundary contract, which a YAGNI cut should not do. Replacing it with a `content.version_saved` job event can be proposed as an alternative shape in stage 3.

**YAGNI-10 (REJECTED as standalone).** It is a roll-up of other findings. Its new item (mock fixtures for jobs, raw batches, `PublishContext` and problem+json) moves to cluster K.

## Clusters

| Cluster | Members | Merged severity | Note |
| --- | --- | --- | --- |
| **A — Read-path sync model** | SYNC-2 (anchor), SYNC-1 = CLR-16, SYNC-3, SYNC-4, SYNC-19, SYNC-20, §6 Q3, CLR-25 | **blocker** | Choose snapshot-per-stable-partition or a record-delta feed. Add `generation` and an all-or-nothing client apply. Add a server-owned resync/takedown signal. DB-11 (tombstone column convention) depends on this choice. |
| **B — Versioning & old clients** | SYNC-5 (anchor), SYNC-10 = YAGNI-9, CLR-26, EXT-6 | major | "Clients ignore unknown fields" plus `min_app_version` in v1. Time-based API sunset. Define what "framework version" means. |
| **C — Column classification & C0 publish guard** | SYNC-6 = CLR-6 = DB-8, SEC-3, EXT-8 | major | Classify publish views per column, or classify every column. Row filter for "published". The serializer whitelists fields. |
| **D — AI disclosure label source** | SYNC-7 = CLR-10 | minor | One optional tenant key or an i18n key. Publish the label text once (manifest or `institutional.json`). |
| **E — Source and reference date for numbers** | SYNC-8 = CLR-24 | minor | Scope §2 to indicators for v1. Add a source display name. Define the `reference_date` granularity. |
| **F — Public writes: identity, rate limit, idempotency** | SYNC-11 (anchor), SYNC-12, SEC-8, SEC-1 (rate-limit part) | major | Auth per endpoint class. Rate-limit key with a hashed, short-TTL IP (LGPD). Idempotency rows store references only. |
| **G — API conventions document** | SYNC-13, CLR-22 | minor | Calendar dates vs instants, cursor semantics, problem `type` catalog, field errors. |
| **H — Auth identity & `aal2` enforcement** | CLR-19 (anchor), SYNC-14, SEC-1, DB-5 | major (verifier A may raise it via SEC-1) | `app_user.id = auth.users.id` as an exception to UUIDv7. Define "staff". Enforce `aal2` in the database. |
| **I — `tenant.yaml` internal consistency** | CLR-8, CLR-9 ⊃ SYNC-16, CLR-7, DB-13 | minor | Shape of `modules[]`, path base, stale "theme rows" comment, single source for cause icons, casing rule. |
| **J — Token semantics & contrast pairs** | SYNC-15, SYNC-17 | minor | One usage rule per role. Derive the pairs from those rules. Check both modes. |
| **K — Synthetic fixtures** | SYNC-18 = CLR-20, YAGNI-10 item 7 | minor | 4 users. Negative fixtures: draft absent, tombstone or removal, AI label, indicator. A second-generation manifest. Mock payloads per extension point. |
| **L — Self-contained data model** | CLR-1 = DB-1 | **blocker** | Inline the columns of the cross-lane tables. They are not private content. |
| **M — Freeze governance & layout** | CLR-2, CLR-4, CLR-23 | major | Artifact checklist, ownership of `tenants/demo/`, repo tree. Versioning goes to B. |
| **N — `DataClass` definition** | CLR-5, EXT-3 (part), EXT-4 (part), SEC-5 (prefix part) | major | One normative table: class, ordinal, prefixes, encrypted, may leave the instance, may reach external AI. |
| **O — Module database namespacing** | CLR-11 = DB-3, EXT-10, DB-2, DB-4; YAGNI-2 rejected | major (DB-2 carries blocker in verifier A's scope) | Injective id-to-schema mapping. `core.*` modules live in `core`. `core_api` uses `security_invoker`. Data API exposure decision. |
| **P — Module composition & boot** | CLR-12, CLR-13 = EXT-2, EXT-1, DB-12, DB-7 (permissions) | major (EXT-1/2 claim blocker; verifier A's call) | `registerModule` shape, build-time composition outside this repo, boot sequence, config as source of truth. |
| **Q — Job queue** | CLR-14, SEC-9 | major | `core.job` table, envelope, retry and idempotency, payload class check at enqueue. |
| **R — Connector contract** | CLR-15, EXT-7, YAGNI-5 | major | One identity across config, manifest, `data_source` and bundle names. Runner owns the transaction. Minimal types. |
| **S — Content lifecycle & publish pipeline** | CLR-17, YAGNI-1, EXT-8 | major | State machine and "published" predicate. `Bundle` shape. Publish runs as a `Job`. `dependsOn` is optional or dropped. |
| **T — AI guard locality** | CLR-18 = EXT-4 ⊂ SEC-2 | major here (verifier A may hold it at blocker) | `is_local` attribute, facade vs provider signature. |

Standalone (no cluster): SYNC-9 (media in bundles, major), CLR-21 (`electoral_restricted_mode`, minor), CLR-27 (CI license list, nit), CLR-3 (nit), YAGNI-3/4 (nit), YAGNI-6 (minor), YAGNI-7/8 (rejected).

## Counts

- **Verdicts (57 findings):** CONFIRMED 35 · PLAUSIBLE 15 · REJECTED 7.
- **Adjusted severity:** blocker 2 (SYNC-2, CLR-1) · major 20 · minor 21 · nit 9 · no severity (rejected outright) 5.
- **Before:** SYNC had 2 blockers and 9 majors; CLR/YAGNI had 3 blockers and 19 majors. Together, 5 blockers and 28 majors.
- **After:** 2 blockers and 20 majors across these two reports. Cluster-level blockers: A (read-path sync model) and L (self-contained data model).
