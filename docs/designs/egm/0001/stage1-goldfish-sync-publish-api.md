# Stage 1 — Goldfish review: sync, publishing, tokens & API

Design under review: `docs/designs/0001-core-contracts.md` (draft, 2026-11-14).
Reviewer lens: offline-first mobile sync, static publishing, API conventions, design tokens, synthetic examples (§2 read path, §3.5, §3.6, §3.7, §4).
Method: fresh context. Only `AGENTS.md` and the design doc were read; anything the doc does not state is treated as a gap.

## Summary

The read-path contract (§3.6) is the weakest of the six contracts in this lens. It promises "deltas on 3G" (§2) but specifies whole-file bundles identified by hash, with a paging scheme (newest-first, 100 per page) under which a single new item changes every page's hash, so every routine publish forces a full re-download. Merge semantics between whole-bundle replacement and per-record tombstones are undefined, which leaves deleted content on devices indefinitely. Publish atomicity under CDN caching is not addressed, and there is no versioning story for old app builds that never update. The C0-only guarantee is stated as a per-column check, but §3.3 only classifies tables and prefixed columns, so the check as written is not implementable.

The API conventions (§3.7) are a reasonable skeleton but leave the parts that are hard to change later undefined: deprecation horizon, how anonymous citizens authenticate for public writes, and Idempotency-Key storage and semantics. The token contract (§3.5) checks too few contrast pairs and does not say the check runs in both modes. There are two sources of truth for cause icons, and §4 has a role-count mismatch.

Recommendation: do not freeze §3.6 until SYNC-1 through SYNC-5 are resolved. These are contract-shape changes (file naming, manifest fields, record envelope) that become expensive once app builds are in the stores.

## Findings table

| ID | Severity | Confidence | Section | Claim |
| --- | --- | --- | --- | --- |
| SYNC-1 | blocker | high | §3.6 (bundle names), §2 | Newest-first fixed-size content pages make every page's sha256 change on each new item, so every publish forces a full re-download on 3G and page-boundary drift corrupts partial syncs. |
| SYNC-2 | blocker | high | §3.6 (records, app behaviour), §2 | Whole-bundle hash sync and per-record tombstones are mixed without defined merge semantics, so deletions (including legal takedowns) may never reach devices. |
| SYNC-3 | major | high | §3.6, §6 Q3 | No server-declared tombstone horizon or resync trigger exists, so an app offline longer than 90 days keeps stale deleted records indefinitely. |
| SYNC-4 | major | high | §3.6 (manifest) | Publish atomicity under CDN caching is unspecified: mutable bundle URLs plus a separately cached manifest yield hash mismatches, mixed generations, and manifest rollback. |
| SYNC-5 | major | high | §3.6 (`schema_version`), §3.7 | A single integer `schema_version` with no compatibility rules or minimum-app signal breaks old app builds still in use on the first breaking bundle change. |
| SYNC-6 | major | high | §3.6 vs §3.3 | "Refuses to serialize any column not classed C0" cannot be implemented: §3.3 classifies tables and prefixed columns only, and `content_item` mixes draft (C1) and published (C0) rows. |
| SYNC-7 | major | high | §3.6 (`ai_label`), §3.2 | The AI label text "comes from the instance config", but `tenant.yaml` has no such key and rejects unknown keys. |
| SYNC-8 | major | medium | §2, §3.6 (indicators), §3.3 `data_source` | The rule that every number carries a source and reference date is enforced only for indicator bundles, and `source_id` alone cannot be rendered offline. |
| SYNC-9 | major | medium | §3.6, §3.3 `media_asset` | Media assets have no bundle representation, size budget, caching or metadata-stripping rule, though they are the largest 3G cost and a personal-data leak vector. |
| SYNC-10 | major | high | §3.7 (versioning) | "Old version kept for one app release cycle" is undefined and unsafe for store apps whose users do not update. |
| SYNC-11 | major | high | §3.7 (auth, public writes) | Public writes "from the public" conflict with the blanket Supabase JWT requirement, and the identity used for rate limiting is undefined. |
| SYNC-12 | minor | high | §3.7 (`Idempotency-Key`) | Idempotency-Key scope, storage, TTL, body-mismatch behaviour and data class of stored responses are unspecified. |
| SYNC-13 | minor | medium | §3.7 (dates, pagination, errors) | Date-only and period values, cursor stability, limit overflow, and field-level validation errors are not covered, and §3.6 bundles are not bound to the §3.7 conventions. |
| SYNC-14 | minor | medium | §3.7 (`aal2`) | "Staff" is undefined for the `aal2` rule, and second-factor recovery and step-up behaviour are missing. |
| SYNC-15 | major | high | §3.5 (contrast) | Required contrast pairs omit `link/surface`, `muted/surface`, status colours, `line` and `cta` against its background, and the doc does not say the check runs in both modes. |
| SYNC-16 | minor | high | §3.5 (`icons.causes`), §3.2 (`causes[].icon`) | Cause icons are declared in two places with no precedence rule, which gives two sources of truth. |
| SYNC-17 | minor | medium | §3.5 (`accent`, `cta`, `brand`) | Colour-role semantics (`accent` vs `cta` vs `brand`, and which one is the primary button) are undefined, so lanes will use them inconsistently. |
| SYNC-18 | minor | high | §4 | Seed has "3 users (one per role)" but §3.3 seeds 4 roles, and the fixtures do not exercise paging, tombstones or the C0 filter. |
| SYNC-19 | minor | medium | §3.6, §3.3 (ordering/clock) | `updated_at`/`generated_at` clock source is unspecified; transaction-start timestamps and clock skew make timestamp-based deltas skip records. |
| SYNC-20 | minor | low | §3.6 (bundle names) | No partitioning by cause or municipality means every client downloads everything; the first-run size budget is not stated. |

## Detailed findings

### SYNC-1 — Newest-first fixed pages invalidate every page on each publish
- **Severity:** blocker · **Confidence:** high
- **Section:** §3.6 "Bundle names: `content-<page>.json` (newest first, 100 items per page)"; §2 "syncs deltas and works offline on 3G".
- **Problem:** The pages are positional windows over a newest-first list. Inserting one item at the head shifts every item down by one position, so every page gains one item at its top and loses one at its bottom. Every `sha256` changes. §3.6 says the app downloads every bundle whose hash changed, so one new post means the app re-downloads the whole content corpus.
- **Failure scenario:** The demo mandate has 2,400 published items in 24 pages of roughly 60 KB each, about 1.4 MB. The communications team publishes 5 posts a day. Each citizen device re-downloads about 1.4 MB per publish, roughly 7 MB a day on prepaid 3G, to receive about 1 KB of new content. Paging also drifts: if a device downloads pages 1–3, loses signal, and resumes after a new publish, pages 4–24 belong to a different generation. Items on the boundary appear twice or not at all, and the per-page hash check passes on each file.
- **Recommendation:** Make bundles stable by content identity, not by list position:
  - Partition append-only by the immutable creation key, which §3.3 already provides as UUIDv7. Examples: `content-2026-11.json` by month of `created_at`, or sealed chunks `content-<first_id>.json` of up to N items in oldest-first order. Only the newest (open) partition changes on a new item.
  - An edit to an old item rewrites only its own partition.
  - Make content-addressed URLs part of the contract (see SYNC-4).
  - State the expected bytes per routine publish as a design budget, for example "≤ 1 partition + manifest".

### SYNC-2 — Whole-bundle replacement and tombstones have no defined merge semantics
- **Severity:** blocker · **Confidence:** high
- **Section:** §3.6 "Every record has `id`, `updated_at`, `deleted` (tombstones kept 90 days for delta sync)" and "downloads only bundles whose `sha256` changed … writes to SQLite"; §2 "syncs deltas".
- **Problem:** The doc describes two incompatible models:
  1. **Snapshot:** a bundle is the authoritative full contents of its key range. The app replaces all local rows for that range, deletion is implied by absence, and tombstones are not needed.
  2. **Delta/upsert:** the app upserts records and relies on `deleted: true` to remove them. This needs a defined "changes since X" source, and no such source exists. There is no delta file, no `since` parameter, and no watermark in the manifest.

  The doc does not say which model the app uses, what "delta" means, or which key range a bundle owns. Under SYNC-1's positional paging, a bundle does not own a stable key range, so snapshot replacement cannot even tell which local rows to delete.
- **Failure scenario:** An item is unpublished because of a court order, or because `flags.electoral_restricted_mode` turns on during the electoral period. The app implements upsert-only, which is the natural reading of "tombstones for delta sync". The tombstone sits in a page the device does not download, because that page's hash did not change after paging moved the item or after the tombstone expired. The device keeps showing the removed content offline with no time limit. For electoral restrictions, this is a legal exposure for the mandate.
- **Recommendation:** Pick one model and write it into the contract.
  - Preferred: **snapshot per stable partition** (from SYNC-1). The app applies each changed partition in one SQLite transaction (`DELETE … WHERE partition = ?; INSERT …`). Deletions propagate by absence, and tombstones become optional.
  - If the team wants record-level deltas, add a `changes-<generation>.json` (or `changes since generation N`) bundle with a monotonic `generation` number in the manifest, and define tombstones only in that feed.
  - Add a **revocation/takedown** requirement either way. A device that comes online must drop removed content before it renders anything. A global "must-remove ids" list in the manifest is cheap.

### SYNC-3 — No tombstone horizon or forced-resync signal (answers §6 Q3)
- **Severity:** major · **Confidence:** high
- **Section:** §3.6 tombstones 90 days; §6 Q3.
- **Problem:** If tombstones are kept (record-delta model), an app last synced more than 90 days ago cannot learn about deletions that happened and expired in between. The doc gives the app no way to detect this. The 90-day constant would be hard-coded in clients and could never change afterwards.
- **Failure scenario:** A citizen installs the app in March, opens it again in August, and the app applies only the hash-changed bundles. Items deleted in April, with tombstones purged in July, stay visible on that device permanently.
- **Recommendation:** Add `tombstones_since` (the oldest tombstone still published) and `generation` to `manifest.json`. Rule: if the client's `last_generation_applied` is older than `tombstones_since`, or `schema_version` major changed, or the client has never synced, the client performs a full resync. It wipes the content tables and applies all bundles in one transaction. The server owns the horizon, so it can change later without an app release. Under the snapshot model from SYNC-2, the same field still serves as an explicit "full resync required" switch.

### SYNC-4 — Publish atomicity and CDN consistency are unspecified
- **Severity:** major · **Confidence:** high
- **Section:** §3.6 manifest (`bundles[]` with `url`, `sha256`); app "fetches `manifest.json` with ETag".
- **Problem:** The doc does not say whether bundle URLs are mutable (`content-1.json` overwritten in place) or content-addressed. It does not give an upload order, cache TTLs, or a rule for how long old bundles are retained. The CDN can cache the manifest and the bundles independently and propagate them at different times.
- **Failure scenarios:**
  - (a) A publisher uploads the manifest first, or uploads in parallel. An edge serves the new manifest but the old cached `content-3.json`. The hash check fails. Without a defined retry policy the app either errors or keeps half-applied state from pages 1–2.
  - (b) An edge serves the new `content-3.json` with the old manifest. The hash fails again.
  - (c) Two edges serve different manifests. The device takes generation 42 from one and then generation 41 from another, and rolls back.
  - (d) A publish job crashes after uploading half the bundles.
- **Recommendation:** Specify the following in the contract:
  - Bundle URLs are content-addressed, for example `content-2026-11.<sha256-prefix>.json`, immutable, with `Cache-Control: public, max-age=31536000, immutable`.
  - The publisher uploads all bundles first and writes the manifest last, as a single object.
  - The manifest has a short `max-age` (for example 60 s) with ETag.
  - Previous-generation bundles are retained for at least the manifest TTL plus the maximum expected sync duration (for example 24 h).
  - The manifest carries a monotonic integer `generation`, and the app ignores any manifest with `generation` ≤ the one already applied.
  - The app downloads and verifies all changed bundles, then commits them in **one** SQLite transaction. On any failure it keeps the previous generation and retries with backoff.
  - `PublishTarget.build` returns `Bundle[]`, but no interface defines the commit and swap step. Add one, for example `PublishTarget.commit(generation)` or an equivalent core step, so that a crashed publish never leaves a manifest pointing at missing files.

### SYNC-5 — `schema_version` evolution and old apps in the wild
- **Severity:** major · **Confidence:** high
- **Section:** §3.6 manifest `schema_version`; §3.7 versioning.
- **Problem:** A single integer gives no way to tell an additive change from a breaking one. The doc does not say what an app does when it sees a version it does not know, or how long the publisher keeps serving the old shape. The citizen app is a store app, and some installs never update.
- **Failure scenario:** Bundle v2 renames `ai_label` to an object, or changes how indicator values are represented. Devices on v1 builds either crash while parsing or silently drop AI disclosure labels. Dropping the labels violates §2 ("every AI-assisted text carries a disclosure label").
- **Recommendation:** Define these rules:
  - (1) Version format is `schema_version: "MAJOR.MINOR"`. Minor changes are additive only, and clients **must** ignore unknown fields.
  - (2) A major change is published side by side under a versioned prefix (`/v1/manifest.json`, `/v2/manifest.json`), and the old major is kept for a stated **time-based** window. The same policy applies to the API (SYNC-10).
  - (3) The manifest carries `min_app_version`. Clients below it show a pt-BR "update required" screen and keep showing already-synced content with a staleness notice; they do not brick.
  - (4) Fields that are required for compliance, such as the AI label and source/reference date, must never be removed or renamed within a major version.

### SYNC-6 — The C0-only publish guard is not implementable as specified
- **Severity:** major · **Confidence:** high
- **Section:** §3.6 "`core-publish` refuses to serialize any column not classed C0"; §3.3 classification "every table and every `pii_`/`phi_`/`piim_`/`enc_` column has a `COMMENT … IS 'class=Cn'`".
- **Problem:** Unprefixed columns carry no class, so the per-column check §3.6 depends on has no data to read. `content_item` and `content_version` also hold drafts, review notes and scheduled items, which are C1, next to published items, which are C0. That is a **row-level** classification problem that column classes cannot express. If the table is classed C1, nothing can be published. If it is classed C0, drafts are one bug away from the CDN. The CI rule "a `pii_` column must not sit in a table classed below C2" also forbids C0 tables from having any personal column. This is reasonable, but it means an author's name or byline needs a defined treatment.
- **Failure scenario:** The publish lane serializes `select * from core.content_item where status = 'published'`. Someone later adds an unprefixed `internal_note` column. It has no class comment, the guard has nothing to check, and the note ships to every device and stays there (see SYNC-2).
- **Recommendation:**
  - Publishing reads **only** from dedicated views, for example `core_api.published_content`. Each view selects an explicit column list and applies the row filter (`status = 'published' and published_at <= now()` and not restricted by `electoral_restricted_mode`).
  - Every column of every publish view carries a `class=C0` comment, and a CI test fails if a publish view uses `select *` or has an unclassed column.
  - The serializer whitelists the fields in `bundle.schema.json` (`additionalProperties: false`).
  - State in §3.3 that only tables are classed by default and that publish views are classed per column.

### SYNC-7 — The AI label text has no home in `tenant.yaml`
- **Severity:** major · **Confidence:** high
- **Section:** §3.6 "label text comes from the instance config"; §3.2 schema ("Unknown keys are rejected everywhere except inside `modules.<id>.settings`").
- **Problem:** §3.2 has no key for the label. Because unknown keys are rejected, a mandate cannot add one without changing the frozen contract. The record field `ai_label: true` is also boolean, which cannot tell "AI-drafted, human-reviewed" from "AI-translated" or "AI-summarised" later without a breaking change.
- **Failure scenario:** The content lane hard-codes "Texto produzido com auxílio de IA" in the app, and the publish lane looks up a config key that does not exist. Two lanes now disagree, and a mandate that wants different wording has to ship a new app release.
- **Recommendation:**
  - Add a key such as `disclosure: { ai_label_text: "…" }` to the tenant schema with a pt-BR default in the framework i18n files.
  - Publish the text through `institutional.json` (or the manifest), not baked into records, so a wording change does not rewrite every content bundle.
  - Change the record field to `ai_label: "assisted" | null`, or an enum list, so that new kinds are a minor version change.
  - State that the app must render the label whenever the field is non-null, even if the text is missing, using a built-in fallback string.

### SYNC-8 — Source and reference date are required for all numbers but specified only for indicators
- **Severity:** major · **Confidence:** medium
- **Section:** §2 "Every number shown to citizens carries source and reference date"; §3.6 "Indicator values carry `source_id`, `source_url`, `reference_date`".
- **Problem:** Numbers also appear in content items (for example "R$ 2 milhões em emendas") and in institutional data. The bundle schema enforces the rule only for `indicators-*`. Offline, the app cannot turn `source_id` into a human-readable source name, because no bundle carries the `data_source` rows. `reference_date` has no defined granularity. Many indicators are monthly or yearly, and the API rule in §3.7 ("ISO 8601 with offset") does not fit a date.
- **Failure scenario:** An indicator card shows "Fonte: ibge-municipios" (a slug) or nothing at all. A content item quoting an amount carries no source, and the schema accepts it.
- **Recommendation:**
  - Add a `sources.json` bundle (or embed `source_name` and `source_url` in each indicator bundle header).
  - Define `reference_date` as `YYYY-MM-DD` or a period object `{ "period": "2026-10", "granularity": "month" }`.
  - Add an optional structured `figures[]` (value, unit, source_id, reference_date) to content records, so the rule is enforceable at least where the editor marks a figure. If figures inside prose stay unenforced, say so explicitly as an editorial-only rule.

### SYNC-9 — Media assets are absent from the read path
- **Severity:** major · **Confidence:** medium
- **Section:** §3.3 `media_asset` table; §3.6 (silent).
- **Problem:** Images are usually the bulk of bytes on 3G, and the doc does not say how they are represented in bundles. Open points include: URL vs inline, sizes and variants, whether the hash covers media, offline caching policy, an eviction budget, and metadata stripping. EXIF can carry GPS coordinates and device identifiers, which are personal data.
- **Failure scenario:** Lanes inline base64 thumbnails, so bundles grow tenfold. Or they reference originals by mutable URL, so 4 MB photos download over cellular and stale images appear after replacement. Or a photo from a community visit ships with GPS EXIF, putting C2 data on the CDN while `core-publish` "refuses non-C0 columns", because the leak is inside a file, not a column.
- **Recommendation:** Records reference media as `{ id, url (content-addressed), sha256, bytes, width, height, mime, alt (pt-BR, required) }` with fixed responsive variants. Media are fetched lazily, with an optional "Wi-Fi only" preference and a stated on-device cache budget. Publishing re-encodes images and strips all metadata, and a CI fixture verifies this. Required `alt` text also serves accessibility.

### SYNC-10 — API deprecation window "one app release cycle" is undefined
- **Severity:** major · **Confidence:** high
- **Section:** §3.7 "old version kept for one app release cycle".
- **Problem:** Store apps have no fixed release cycle, and many users do not update. Gabinete staff apps may be managed, but citizen apps are not. The window is unmeasurable, and the server cannot know which API versions are still in use.
- **Failure scenario:** `/api/v1` is removed four weeks after the v2 app ships. Citizens on old builds submit a contact or denúncia form and get 404 errors. The form loses their text, and the failure is invisible to the gabinete.
- **Recommendation:**
  - Define a time-based minimum, for example "≥ 12 months after the replacing app version is available in both stores", **and** require that usage of the old version is below a threshold.
  - Clients send an `X-App-Version` header (non-identifying).
  - Use `Deprecation` and `Sunset` response headers.
  - Expose a `min_supported_app_version` value, the same one as the manifest field in SYNC-5, so old apps show a forced-update screen instead of failing writes.
  - Old clients must keep unsent public-write drafts locally and not discard them on error.

### SYNC-11 — Anonymous public writes vs the JWT requirement
- **Severity:** major · **Confidence:** high
- **Section:** §3.7 "Auth: Supabase JWT as `Authorization: Bearer`" and "Writes from the public (contact, denúncia, emenda request) require `Idempotency-Key` and pass rate limiting".
- **Problem:** The doc does not say whether citizens have accounts. If public writes need a JWT, it could be the anon key, Supabase anonymous sign-in, or a full account; each has very different privacy and abuse properties. If they do not need one, the auth rule is wrong as written. Rate limiting needs a key. IP addresses are personal data under LGPD, and behind a CDN the client IP is in a forwarded header that must be trusted explicitly. Denúncias may need to be truly anonymous, so binding them to an account identity would defeat the purpose.
- **Failure scenario:** The auth lane enforces Bearer JWT on `/api/v1/*`. The mobile lane ships the anon key as the bearer. Rate limiting keys on `auth.uid()`, which is null or shared for the anon key, so either everyone shares one bucket (DoS by one abuser) or nobody is limited. Alternatively, IPs are logged for rate limiting with no retention rule.
- **Recommendation:** State per endpoint class:
  - (a) public read: no auth;
  - (b) public write: no user JWT, a per-install random token or anonymous session, rate-limited by that token plus a hashed, truncated IP with a short TTL (for example 24 h), optional CAPTCHA or proof-of-work; and explicitly that denúncias are not linked to an identity unless the citizen opts in;
  - (c) staff: JWT plus `aal2`.

  Classify rate-limit state (C2 if it contains IP-derived data) and give it a retention rule.

### SYNC-12 — Idempotency-Key semantics are unspecified
- **Severity:** minor · **Confidence:** high
- **Section:** §3.7 "require `Idempotency-Key`".
- **Problem:** The doc leaves open:
  - the key format;
  - the scope (per route, or per route plus caller);
  - the storage location (which table, and its class);
  - the TTL;
  - the behaviour on reuse with a different body;
  - the behaviour while the first request is still in flight;
  - what is replayed, given that a stored response must not echo personal data.

  Offline-first clients retry submissions after reconnecting, which is exactly when these details matter.
- **Failure scenario:** The app queues a denúncia offline and retries three times after reconnecting. Without a defined in-flight rule, two requests race and create duplicate cases. A stored response that contains the submitted text turns the idempotency table into an unclassified C2/C3 store.
- **Recommendation:**
  - Keys are UUIDv4 or v7 generated by the client when the draft is created, stored with the offline queue entry.
  - Server table `core.idempotency_key(key, route, request_hash, status, response_ref, created_at)`, classed C1, storing only a reference (status plus created resource id), never the body.
  - TTL ≥ the client retry horizon (for example 7 days).
  - Same key with a different body hash returns 422. Same key while the first request is still in flight returns 409 with `Retry-After`.
  - Define the problem `type` URIs for these cases.

### SYNC-13 — Gaps in the date, pagination and error conventions; bundles not bound to them
- **Severity:** minor · **Confidence:** medium
- **Section:** §3.7 dates, pagination, errors; §3.6.
- **Problem:**
  - "ISO 8601 with offset" fits instants only. All-day agenda events, birthdates and indicator periods are calendar values, and adding an offset to them shifts the day across time zones. `tenant.yaml` has `timezone: America/Fortaleza`, but the doc does not say whether the app renders in the instance time zone or the device time zone.
  - Cursor pagination does not say whether the cursor is opaque, which sort order it uses (UUIDv7 `id` is a natural stable key), what happens when `limit` > 100 (clamp or 400), the default limit, or that `next_cursor` is `null` at the end.
  - RFC 9457 errors have no extension for field-level validation errors, which forms need.
  - Money as "integer centavos with `currency`" does not say whether the field is `amount` or `amount_centavos`.
  - The IBGE code type is not given: a 7-digit string or a number.
  - §3.6 does not say that bundles follow these conventions, so the publish lane may choose different ones.
- **Recommendation:**
  - Instants use RFC 3339 with offset. Calendar dates use `YYYY-MM-DD`. Periods use the SYNC-8 object. The UI renders in the instance `timezone`.
  - The cursor is opaque, ordered by `id`, has a default limit of 20, returns 400 above 100, and `next_cursor: null` marks the end.
  - Problem extension `errors: [{ pointer, code }]` with no submitted values echoed back.
  - Money as `{ "amount_centavos": 123456, "currency": "BRL" }`.
  - `municipality_ibge: "2304400"`, a 7-character string.
  - Add a sentence in §3.6: "bundle records follow §3.7 value conventions".

### SYNC-14 — The `aal2` rule for staff is underspecified
- **Severity:** minor · **Confidence:** medium
- **Section:** §3.7 "staff sessions require a second factor claim (`aal2`)".
- **Problem:**
  - "Staff" is not defined. It could mean any `role_assignment`, or only certain roles, and module roles from manifests make the set open-ended.
  - The doc does not say whether RLS (`core.has_role`) also checks `aal`, or whether only the API layer does. If only the API checks it, a staff JWT at `aal1` used directly against PostgREST bypasses the rule.
  - Lost-second-factor recovery and session lifetime and step-up for sensitive (C3) actions are not specified.
- **Recommendation:** Define staff as "any user with ≥ 1 `role_assignment`". Make `core.has_role()` return false unless the JWT `aal` claim is `aal2`, so enforcement lives in the database. Document the recovery path (another `chefe_gabinete` resets the factor, with an audit event).

### SYNC-15 — The contrast pair list is incomplete and mode coverage is not stated
- **Severity:** major · **Confidence:** high
- **Section:** §3.5 "required pairs (`fg/bg`, `fg/surface`, `brand-on/brand`, `cta-on/cta`, `link/bg`, `muted/bg`)".
- **Problem:** Links and muted text routinely sit on `surface` (cards, sheets), and those pairs are not checked. Status colours (`success`/`warning`/`error`/`info`) are used as text, for example in form errors, and as icons, and they are not checked against `bg` or `surface`. WCAG 1.4.11 needs 3:1 for UI component boundaries: `line` against `bg`/`surface` for input borders, and `cta` against `bg` for a button whose fill is its only boundary. `link` also needs ≥ 3:1 against adjacent `fg` if links are not underlined (WCAG 1.4.1 technique G183). The doc does not say the pairs are checked in **both** `light` and `dark`. The doc also lists "4.5:1 text, 3:1 large text and UI" without saying which threshold applies to each pair.
- **Failure scenario:** A mandate theme passes CI. In dark mode, `link` on `surface` is about 2.8:1 and red `error` text on `surface` is about 3.2:1, so validation messages fail AA for low-vision citizens.
- **Recommendation:** Make the schema list `{ fg, bg, min_ratio }` triples and check them in each mode:
  - text 4.5: `fg`, `muted`, `link`, `error`, `success`, `warning`, `info` × `bg`, `surface`; also `brand-on/brand` and `cta-on/cta`;
  - UI 3.0: `line`, `cta`, `brand`, `accent` × `bg`, `surface`; also `link` vs `fg` when links are not underlined.

  Alternatively, require status text to use dedicated `*-fg` tokens. The checker should report each failing pair by name and mode.

### SYNC-16 — Two sources of truth for cause icons
- **Severity:** minor · **Confidence:** high
- **Section:** §3.2 `causes: - { slug, name, icon }`; §3.5 "`icons.causes` maps cause slugs to icon names".
- **Problem:** Both files assign an icon to a cause slug, and the doc gives no precedence rule. Nothing checks that the slugs in `icons.causes` exist in `causes[]`, or that every cause has an icon.
- **Failure scenario:** A mandate edits `tenant.yaml` to change the "saude" icon, and the app still shows the token value, or the other way round, depending on which lane read which file. A new cause added only in `tenant.yaml` has no icon in `causes.json`.
- **Recommendation:** Keep `causes[].icon` in `tenant.yaml` as the single source (causes are content and identity data) and drop `icons.causes` from the tokens. If needed, tokens may define only the icon *set* or style. `causes.json` carries `{ slug, name, icon }` resolved at publish time. Validation fails on an unknown icon name.

### SYNC-17 — Colour-role semantics are undefined
- **Severity:** minor · **Confidence:** medium
- **Section:** §3.5 colour roles.
- **Problem:** The doc does not say what `accent`, `cta` and `brand` each mean. It does not say which one fills the primary button, whether `accent` is ever text, or whether `brand` may be used as a background for large areas. The web and mobile lanes will map them differently, and the contrast pairs depend on that usage.
- **Recommendation:** Add a one-line usage rule per role, for example:
  - `cta` = the single primary action fill per screen;
  - `brand` = header and identity surfaces;
  - `accent` = decorative only, never text and never the only signifier;
  - `link` = inline text links.

  Derive the SYNC-15 pairs from those rules.

### SYNC-18 — Synthetic examples: role count mismatch and missing negative fixtures
- **Severity:** minor · **Confidence:** high
- **Section:** §4 "seed SQL with 3 users (one per role)"; §3.3 seeds 4 roles (`parlamentar`, `chefe_gabinete`, `comunicacao`, `operador`).
- **Problem:** Three users cannot cover four roles one each. The bundle fixture ("one published `manifest.json` with two bundles") also exercises none of the risky behaviours: multiple content partitions, a tombstone, an AI-labelled record, an indicator with source and reference date, or a draft that must **not** appear.
- **Recommendation:** Use 4 users, one per role, plus one staff user with no role to test deny-by-default. The bundle fixture should include at least 2 content partitions, 1 tombstone (or a removal by absence, per SYNC-2), 1 `ai_label` record, 1 indicator bundle, and a test asserting that the C1 draft from the seed is absent. Add a second-generation manifest so lanes can test incremental apply.

### SYNC-19 — Clock source for `updated_at` / `generated_at`
- **Severity:** minor · **Confidence:** medium
- **Section:** §3.6 `generated_at`, `updated_at`; §3.3 ids.
- **Problem:** The doc does not say which clock sets these values: database `now()`, a worker clock, or the app clock. Postgres `now()` is the transaction **start** time. A long transaction that commits after a publish run can therefore carry an `updated_at` earlier than that run's watermark, and a timestamp-based "changed since last publish" query skips it. Multiple workers with skewed clocks make this worse.
- **Recommendation:** Do not use timestamps as sync watermarks. Use the manifest `generation` (SYNC-4) on the client side. On the publish side, either rebuild partitions whole or use a monotonic sequence or commit-order mechanism. State that `updated_at` comes from the database (`clock_timestamp()` in a trigger), is UTC in storage, and is informational only for clients.

### SYNC-20 — No partitioning by cause or municipality; no size budget
- **Severity:** minor · **Confidence:** low
- **Section:** §3.6 bundle names.
- **Problem:** Every device downloads all content, agenda and indicator bundles. A state deputy's indicators across all municipalities (`indicators-<source_id>.json`) may be large, while a citizen cares about one municipality. The doc states no first-run budget.
- **Recommendation:** State a first-run budget, for example "≤ 1 MB compressed excluding media". Allow `indicators-<source_id>-<ibge>.json` partitioning when a source exceeds a size threshold. Per-cause filtering can remain client-side in SQLite, so no change is needed there. Require gzip or brotli on the CDN.

## Open-question answers (lens-relevant)

**Q3 — Is 90 days enough, or should the app fall back to a full resync?**
Yes, the app needs a full-resync fallback, but the trigger must come from the server, not from a client constant. Add `tombstones_since` and a monotonic `generation` to the manifest. The client performs a full, transactional resync when its last applied generation is older than the horizon, when the schema major changes, or on first run (SYNC-3). Better still, adopt snapshot-per-stable-partition (SYNC-1, SYNC-2). Deletions then propagate by absence, tombstones become unnecessary for correctness, and the window question mostly disappears. Separately, add a takedown list to the manifest so legally required removals reach long-offline devices first.

**Q1, Q2, Q4** fall outside this lens. One note on Q1: if per-module schemas are kept, the publish views from SYNC-6 should live in a single exposed schema (`core_api` or `publish`), so `core-publish` never needs access to `mod_*` schemas directly.
