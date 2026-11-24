# Design 0001 — Core contracts (backlog E0.0)

Status: **Frozen — contract version 0.1.0** · 2026-11-15 · Cross-provider verdict on v4: freeze · Owner: architecture backbone
Reviews: v1 → [`egm/0001/REPORT.md`](egm/0001/REPORT.md) (Elephant-Goldfish method, Claude reviewers); v2 → [`egm/0001/stage4-cross-provider-codex.md`](egm/0001/stage4-cross-provider-codex.md) (Codex); v3 → [`egm/0001/stage5-cross-provider-codex-v3.md`](egm/0001/stage5-cross-provider-codex-v3.md) (Codex); v4 → [`egm/0001/stage6-cross-provider-codex-v4.md`](egm/0001/stage6-cross-provider-codex-v4.md) (Codex, **freeze**). The nine implementation tests listed there are part of the E0.0 done criteria (§11). Section 10 maps every blocker and major finding to its answer.

## 1. Problem

Eleven work lanes (web shell, mobile shell, database, auth, content, publish, theme, connectors, workers, demo tenant, closed modules) will be executed in parallel by different agents. Without frozen interfaces, each lane invents its own shapes and the integration cost lands on the critical path. This design fixes the contracts before any lane starts, each with synthetic example data so lanes can work against mocks.

## 2. Constraints (from accepted decisions)

- **One instance per mandate**: one database per mandate, no `tenant_id` column. Instance identity comes from `tenant.yaml` and a single `instance` row.
- **Stack**: Expo/React Native (citizen and gabinete variants), Next.js (back-office, public web, API route handlers), Supabase Postgres in `sa-east-1`, Python workers, Postgres-backed queue.
- **Data classes** C0 public < C1 internal < C2 personal < C3 sensitive (§3). C3 never reaches an external AI provider.
- **Open core**: this repository is public AGPL. It never imports closed modules or mandate config. Closed modules plug in only through the extension points defined here. If a closed module needs a new hook, the hook is added here first.
- **Read path is static**: published content becomes JSON bundles on a CDN; the citizen app syncs and works offline on 3G.
- Every number shown to citizens carries source and reference date; every AI-assisted text carries a disclosure label.

## 3. Data classes and column prefixes

| Class | Meaning | Storage rule | May be published | May reach an external AI provider |
| --- | --- | --- | --- | --- |
| C0 | Public | Plain | Yes | Yes |
| C1 | Internal | Plain, RLS to role holders | No | Yes, if the routing module allows |
| C2 | Personal | Prefixed columns encrypted by the application | No | Only through a provider the routing module marks as cleared for C2 |
| C3 | Sensitive | Ciphertext only | No | Never |

| Prefix | Meaning | Minimum class | Encrypted by the application |
| --- | --- | --- | --- |
| `pii_` | Personal, non-clinical (name, e-mail, phone) | C2 | Yes |
| `phi_` | Health data | C3 | Yes |
| `piim_` | Data about a minor | C3 | Yes |
| `enc_` | Opaque ciphertext (keys, payloads) | C3 | Already ciphertext |
| `bi_` | Blind index of a `pii_` column (§4.6) | C1 | No (keyed hash) |

Every column, not only prefixed ones, carries `COMMENT ON COLUMN ... IS 'class=Cn'`, and every table carries the class of its most sensitive column. CI fails when a table or column in `core` or `mod_*` has no class, when a prefixed column is below its minimum class, or when a column classed C2+ has no prefix.

## 4. Database contract (`packages/db/migrations/0001_core.sql`)

### 4.1 Schemas, database roles and access surfaces

| Schema | Owner (NOLOGIN) | Exposed to clients |
| --- | --- | --- |
| `core` | `core_owner` | No |
| `audit` | `audit_owner` (holds only `audit.event`, §4.5) | No |
| `mod_<short>` | `mod_<short>_owner`, one per module | No |
| `api` | `core_owner` | **Only this schema** is exposed through PostgREST. In 0001 it is empty. Future objects: `security_invoker = true` views and `SECURITY INVOKER` read-only (`STABLE`) functions, each listed in the migration that creates it. `SECURITY DEFINER` is forbidden in `api`. |

Runtime roles (all `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEROLE`, `NOINHERIT` unless stated):

| Role | Used by | Rights |
| --- | --- | --- |
| `anon`, `authenticated` (Supabase) | PostgREST, realtime | `USAGE` on `api` only. `revoke all` on `core`, `audit`, `mod_*` and `public`. |
| `api_rt` (LOGIN) | Next.js API | Table rights granted per table in the migration. Every request runs in a transaction that sets `request.jwt.claims` from the verified user JWT, so RLS and `core.has_role` see the end user. Public, unauthenticated endpoints use the anonymous claim and reach only the tables a policy opens to it. |
| `worker_c1`, `worker_c2`, `worker_c3` (LOGIN) | Python worker pools, one per data class (§7.5) | A pool's role can read columns up to its class and no higher: `worker_c1` has no `select` on any C2/C3 column, `worker_c2` none on C3. RLS policies name these roles explicitly, by table; they do not use `has_role`, because workers carry no user JWT. |
| `migrator` (LOGIN) | `mandato migrate` at boot only | `SET ROLE` to `core_owner` or one `mod_<short>_owner` per step; never used by request paths. |

- Supabase's `service_role` and the database superuser are used only by the instance bootstrap and the operator runbook, never by the API or workers. CI inspects the migration result: grants per role, `rolbypassrls = false` for every runtime role, no `SECURITY DEFINER` in `api`, and the exposed-schema setting equal to `api`.
- The exact role × table × verb grant matrix is generated from the migrations into `packages/db/grants.md` and checked in CI against two rules: no runtime role reads a column above its class, and nothing is granted that no lane needs. The matrix is an E0.0 deliverable (§11), not prose here.
- Runtime roles run with `statement_timeout = 60s` and `idle_in_transaction_session_timeout = 5min`, so no transaction lives longer than 5 minutes. Key rotation relies on that bound (§4.6).
- `core.has_role(role text)` is `SECURITY DEFINER`, owned by `core_owner`, `set search_path = pg_catalog, core, pg_temp`. It returns true only when the JWT carries `aal = 'aal2'`, the caller's `app_user.status = 'active'`, the role's module is enabled, and an active (`revoked_at is null`) assignment exists. Every RLS policy on C1+ tables goes through it, so a password-only session reads nothing beyond C0.
- "Staff" means any principal with at least one active `role_assignment`. Citizens never get a Supabase account in P1.
- `app_user.id` equals `auth.users.id` (Supabase-generated UUIDv4). It is the only table whose id is not UUIDv7.

### 4.2 Identifiers and conventions

- Ids are UUIDv7, generated **by the application** (`packages/core-domain` and `workers/core`) so they exist before insert and can bind ciphertext (§4.6). `core.uuid7()` is a SQL fallback default implemented in PL/pgSQL (native `uuidv7()` only arrives in Postgres 18).
- The columns of every table, with type, nullability, default, class, keys and delete action, are in **Appendix A**. It is the contract; prose elsewhere only explains it.
- Foreign keys use `on delete restrict` unless Appendix A says otherwise. Nothing is hard-deleted by cascade; users are deactivated (`status = 'removed'`), not deleted, so grant and audit history survive.
- `instance` has exactly one row (`check (id = 1)`). `tenant.yaml` wins: boot overwrites the row from the file.
- Tables deliberately **not** in 0001 (they arrive with the module that needs them): `organization`, `user_key`, contacts and consent, denúncias, meetings.

### 4.3 Classes in the schema

Every column has `COMMENT ON COLUMN … IS 'class=Cn'` exactly as in Appendix A. Content columns are **C1 at rest**, even the ones that become public: publishing is an explicit declassification through fixed projections (§6.2), never "C1 columns that happen to be allowed".

### 4.4 Roles, permissions and RLS

- Framework roles: `parlamentar`, `chefe_gabinete`, `comunicacao`, `operador`. Module roles are namespaced `<module>.<role>`.
- `role_assignment` has **no** direct `insert`, `update` or `delete` grant for any runtime role. Changes go only through `core.grant_role(target uuid, role text)` and `core.revoke_role(assignment uuid)`:
  - `SECURITY DEFINER`, owned by `core_owner`, `set search_path = pg_catalog, core, pg_temp`, `EXECUTE` granted to `api_rt` only.
  - The grantor is `auth.uid()` from the JWT, never a parameter.
  - They require `aal2`, an active grantor holding `chefe_gabinete`, an active target, an existing role of an enabled module, and `target <> auth.uid()` (nobody grants or revokes their own roles).
  - Each call writes an audit event.
  - Adversarial SQL tests ship with the migration: self-grant, grant by a non-holder, grant with `aal1`, grant to a removed user, and direct `insert` all fail.
- RLS is enabled **and forced** on every table; no policy means no access. CI checks: every table in `core` and `mod_*` has RLS forced; no policy on a C3 column's table grants `operador`; `anon` and `authenticated` hold no privilege outside `api`.
- Disabling a module (`module_registry.enabled = false`) removes its routes, screens and jobs at the next build or boot, and its roles stop matching in `has_role`. Assignments and data stay until an explicit, audited purge.

### 4.5 Audit

- Table `audit.event` lives in its own schema, owned by `audit_owner`, a `NOLOGIN` role that is never used by the API, workers or migrations of other schemas. Nobody else owns or can alter it.
- Writes go only through `audit.write(action, entity, entity_id, details)`, `SECURITY DEFINER` owned by `audit_owner`, `set search_path = pg_catalog, audit, pg_temp`, `EXECUTE` granted to the runtime roles and the owner roles' row triggers. There is no `kind` or actor parameter. `revoke update, delete, truncate` from everyone, plus `before update or delete` and `before truncate` triggers that raise, as defense in depth.
- **Actor identity is derived, not declared.** Inside a `SECURITY DEFINER` function `current_user` is the function owner, so `audit.write` uses `session_user`, the role that logged in, which the function cannot change. It derives the actor from that role:

| `session_user` | `actor_kind` | `actor_id` | If missing |
| --- | --- | --- | --- |
| `api_rt` | `user` | `auth.uid()` from the verified JWT claims, or `anon` for public writes | — |
| `worker_c1/c2/c3` | `worker` | the job bound to the current transaction in `audit.tx_lease` | raise |
| `migrator` | `migration` | the migration bound to the current transaction in `audit.tx_lease` | raise |
| anything else | — | — | raise |

- **Leases bind to a transaction, not a connection.** `core.claim_job()` (§7.4) generates a 128-bit random lease token, stores only its SHA-256 in `job.lease_hash`, and returns the token to the worker. At the start of every transaction the worker calls `audit.bind_lease(token)`. That function is `SECURITY DEFINER` owned by `audit_owner`. It checks that the token matches exactly one `running` job whose queue belongs to the caller's pool, then inserts `(pg_current_xact_id(), job_id)` into `audit.tx_lease`, a table no other role can read or write. `audit.write` looks up `pg_current_xact_id()`. The transaction id is never reused while that transaction is open, so pooled connections and shared backends cannot inherit another job's identity. No binding, or more than one, means the write fails. `mandato migrate` binds each migration the same way through `audit.bind_migration()`.
- Row triggers on C1+ tables call `audit.write` with ids and field names, never values.
- Retention: 5 years (to be confirmed with the mandate's legal advisers). Archival runs only as `audit_archiver`, a separate `NOLOGIN` role used through one audited procedure that copies a closed year to write-once storage, verifies the copy's hash and only then deletes that year. The procedure itself writes an audit event that is never archived with the year it removes.

### 4.6 Application-level encryption

- **Ciphertext envelope** (`bytea`): `version (1 byte = 0x01) | key_id (16 bytes) | nonce (24 bytes, CSPRNG) | ciphertext+tag`. Algorithm: XChaCha20-Poly1305-IETF (libsodium). AAD: `<instance slug>|<schema>.<table>.<column>|<row id>`, which prevents moving ciphertext between rows or instances; it is why ids are generated by the application.
- **Key registry** `core.data_key` (Appendix A): one data key (DEK) per `<table>.<column>` and version. Each DEK is stored wrapped by the instance KEK with XChaCha20-Poly1305, AAD `<instance slug>|dek|<purpose>|<key_id>`, so a wrapped key cannot be substituted under another id or purpose. States: `active` (one per purpose, enforced by a partial unique index), `decrypt_only`, `retired`.
- **KEK**: versioned (`kek_id`) in the instance secret store, loaded only by the API and worker processes, never by browsers, apps or the database. A wrapped DEK uses the same envelope as data (`version | kek_id | nonce (24 bytes, CSPRNG) | ciphertext+tag`). KEK rotation is crash-safe: (1) store the new KEK version in the secret store alongside the old one; (2) rewrap every DEK in one transaction, recording `kek_id` in each envelope; (3) only after commit and a check that every DEK unwraps with the new KEK, mark the old version disabled in the secret store; processes keep both versions loaded until then. Each new KEK version gets a fresh offline recovery copy before step 3. **Recovery:** at instance creation, the KEK is also exported once, encrypted to the public keys of two named people of the mandate (age, 2-of-2 not required, either can restore), and stored offline by the mandate. Without one of these copies, encrypted data cannot be recovered after the loss of the secret store.
- **Rotation**:
  1. Create a new `active` DEK; the old one becomes `decrypt_only` in the same transaction.
  2. Wait until every API and worker process has reloaded the registry; processes reload on each transaction and refuse to encrypt with a non-`active` key.
  3. A re-encryption job rewrites rows in batches.
  4. A verification scan runs twice, the second at least 10 minutes after the first (twice the 5-minute transaction bound in §4.1), and must find zero references to the old `key_id`.
  5. Only then does the key become `retired`. Wrapped bytes are kept until the backup retention window has passed, so restores still decrypt.
- **Blind indexes**: `bi_<col> = version (1 byte) | HMAC-SHA256(index_key[version], normalize_v[version](value))`.
  - The index key and the normalization version travel together. Rotation uses dual write (`bi_<col>` and `bi_<col>_next`, both unique), a backfill under a lock on new registrations, a switch of lookups, then removal of the old column.
  - Normalization v1:
    - E-mail: trim, Unicode NFKC, then the Unicode default lowercase mapping (identical in JavaScript `toLowerCase` and Python `lower`; full case folding is not used because JavaScript lacks it). Domains must be ASCII; internationalized domains are accepted only in their `xn--` form, and anything else is rejected. (Implementation 0.1.1 narrowed the original IDNA rule to keep both languages byte-identical.)
    - Phone: E.164; numbers without `+` are read as Brazilian (10–11 national digits, or 12–13 starting with 55).
  - Shared byte-level test vectors in `packages/crypto/vectors/normalize-v1.json` must pass in both TypeScript and Python.
- RLS predicates never use `pii_` values.

## 5. `tenant.yaml` schema (`packages/core-config/schema/tenant.schema.json`)

JSON Schema 2020-12. Unknown keys are rejected everywhere except inside `modules[].settings`, validated by that module's `settings_schema`. Secrets never appear inline: any credential is a `*_secret_ref` pointing to the instance secret store.

```yaml
schema_version: 1
instance:
  slug: demo                      # ^[a-z][a-z0-9-]{1,30}$
  display_name: "Mandato Dep. Exemplo"
  house: { name: "Assembleia Legislativa do Estado Exemplo", acronym: "ALEX", uf: "EX" }
  office: deputado_estadual        # deputado_estadual | deputado_federal | senador | vereador
parliamentarian:
  public_name: "Dep. Exemplo"
  pronoun_style: neutral           # neutral | feminine | masculine (UI copy only)
locale: pt-BR
timezone: America/Fortaleza        # also the timezone of every cron expression
causes:                            # becomes `core.cause` rows; colors never encode causes
  - { slug: saude, name: "Saúde", icon: stethoscope }
theme: theme/tokens.json           # path in the config repo; validated by tokens.schema.json
labels:
  ai_assisted: "Texto produzido com apoio de IA e revisado pela equipe."
legal:
  privacy_policy_url: https://example.org/privacidade
  data_controller: "Gabinete do Dep. Exemplo"
  dpo: { name: "Encarregado Exemplo", email: dpo@example.org }
channels:                          # no WhatsApp Business API
  email: contato@example.org
  telegram_channel: null
  whatsapp_channel_url: null       # manual WhatsApp Channel link only
connectors:
  - { source_id: ibge-municipios, schedule: "0 6 1 * *", params: { uf: EX } }
modules:                           # a list; order does not matter
  - { id: core.content }
  - { id: core.agenda }
  - { id: demo.hello, settings: { greeting: "Olá" } }
publish_keys:                      # manifest verification keyring compiled into the app (§6.3)
  - { key_id: "2026-11", role: current, public_key: "ed25519:MCowBQYDK2VwAyEA…" }
ai:                                # operator-owned (§7.5); reviewed with the data controller
  providers:
    - { id: echo, locality: local, max_data_class: C3, egress: [] }
```

`flags` is not part of v1; feature flags are added when the first one has defined behaviour. `connectors[].source_id` must match an installed connector's manifest (§7.3).

## 6. Content and publishing

### 6.1 Content state machine

`draft → in_review → approved → published`, plus `published → in_review` (new version of published item), `* → archived`, and `published → withdrawn`.

- `approved` requires `approver_id <> author_id`.
- The publish job runs on every transition into or out of `published`, and on `withdrawn`.
- What is published is `content_version` number `published_version`, never the current draft.

### 6.2 Publish rule: fixed projections

Publishing is a **declassification** from C1 to C0, so it happens only through projections fixed in `packages/core-publish/projections/*.json`. Each projection names:
- the source entity;
- the row predicate;
- the joins;
- every output field with its source expression and `class: C0`.

CI rejects a projection whose output field is not C0, whose source column is C2+, or which reads a column not listed in Appendix A.

| Projection | Row predicate | Output fields |
| --- | --- | --- |
| `content` | `content_item.state = 'published' and deleted_at is null`, joined to `content_version` with `n = content_item.published_version` | `id`, `updated_at`, `type`, `published_at`, `title`, `summary`, `body_md`, `figures`, `causes[]`, `media[]`, `ai_label` |
| `agenda` | `visibility = 'public' and status <> 'cancelled' and deleted_at is null` | `id`, `updated_at`, `starts_at`, `ends_at`, `title`, `kind`, `municipality_ibge`, `place` |
| `causes` | all rows | `id` ← `slug`, `updated_at`, `name`, `icon`, `sort` |
| `municipalities` | all rows | `id` ← `ibge_code`, `updated_at`, `name`, `uf`, `health_region`, `population`, `population_ref_date` |

Every projection has a JSON Schema in `packages/core-publish/projections/<name>.schema.json` that requires `id` (string) and `updated_at` (RFC 3339) and lists every other output field. Institutional pages are not a projection in v1; they arrive with the content type that defines them.

- The declassification act is the transition to `published` (content) or to `visibility = 'public'` (agenda). It requires the `core.content.publish` permission, a different approver than the author for content, and it writes an audit event naming the projection version.
- The bundle writer validates every record again against the projection's JSON Schema before upload, and refuses unknown fields.
- Module publish targets cannot build records (§7.6). They hand over projection names and ids; the core runs the projection.
- The core runs projections as `worker_c1`, so the database refuses any C2+ column even if a projection were mislabelled. `media[]` comes from `core.publish_media(content_id)` (security invoker). `tenants/demo/published/` is built this way by `scripts/publish-demo.sh` and CI checks that it is reproducible.

### 6.3 Manifest and bundles (`packages/core-publish/schema/bundle.schema.json`)

```json
{
  "schema_version": 1,
  "instance": "demo",
  "generation": 42,
  "min_generation": 30,
  "min_app_version": "1.0.0",
  "generated_at": "2026-11-14T18:00:00-03:00",
  "bundles": [
    { "name": "content-2026-11", "url": "b/3f9a…e1.json", "sha256": "3f9a…e1", "bytes": 18234, "count": 12 },
    { "name": "agenda-2026-11", "url": "b/91c0…77.json", "sha256": "91c0…77", "bytes": 2210, "count": 4 },
    { "name": "causes", "url": "b/…", "sha256": "…", "bytes": 512, "count": 5 }
  ],
  "takedowns": [{ "kind": "content", "id": "0193…", "at": "2026-11-10T09:00:00-03:00" }]
}
```

- **Partitions are stable**: content and agenda by month of `published_at`/`starts_at` (`content-YYYY-MM`, `agenda-YYYY-MM`); `causes` and `municipalities` single; indicators one per `source_id`. A new item changes one partition, not every page.
- **Bundle URLs are content-addressed and immutable** (`b/<sha256>.json`, cached forever). Only `manifest.json` is mutable: `Cache-Control: max-age=60`, ETag. The publisher uploads all bundles first and the manifest last.
- **The manifest is signed.**
  - **Format:** `manifest.json` carries `sig: { key_id, alg: "Ed25519", value }`, where `value` is base64url without padding. The signature covers the manifest without `sig`, canonicalized with **RFC 8785 (JCS)**. Shared test vectors in `packages/core-publish/vectors/` must pass in the publisher (TypeScript) and in the app.
  - **Keyring:** the app build embeds a keyring of up to two public keys, `current` and `next`, taken from `tenant.yaml` `publish_keys[]`. A manifest signed by either key is accepted.
  - **Rotation:** ship a build containing the new key as `next`, wait until that build reaches `min_app_version`, then start signing with it. A signed manifest may also carry `keyring_update`, signed by a current key, that adds a new `next` key or revokes one. Devices that are offline through two rotations need an app update.
  - **Freshness:** the manifest carries `expires_at`, at most 7 days after `generated_at`, and the publisher re-signs at least daily. The app ignores expired manifests and keeps showing cached data. The build also embeds `min_generation_at_build`, so a fresh install rejects anything older than the build.
  - A manifest that fails verification is ignored.
- Each bundle is the **full snapshot** of its partition. A record absent from a partition no longer exists there.
- `takedowns[]` keeps the last 365 days of withdrawals so a device can purge a record even before it refetches that partition. `min_generation` is raised whenever a partition is removed entirely.
- Unknown fields are ignored by clients. A breaking bundle change raises `schema_version` and `min_app_version`.

Client algorithm (citizen app):
1. Fetch `manifest.json` with `If-None-Match`. On 304, stop.
2. Verify the signature. If `generation` is lower than the stored generation, ignore the manifest (rollback or stale cache).
3. Apply `takedowns[]`: delete those ids locally. This step runs **before any version check**, so even an unsupported app removes withdrawn content.
4. If `min_app_version` is above the app version, stop here, keep showing the remaining cached data and show the update banner.
5. If the stored generation is below `min_generation`, drop all cached partitions.
6. For each bundle whose `sha256` differs from the stored one: download, verify the hash, replace the partition in SQLite in one transaction.
7. Delete local partitions that are not in the manifest. Store `generation`.

A takedown leaves `takedowns[]` after 365 days only if `min_generation` has first been raised past the generation that withdrew it, which forces any device older than that to resync from scratch.

Records: every record has `id` and `updated_at`. Numbers carry `source_id`, `source_url`, `reference_date` (content figures and indicators alike). AI-assisted records carry `ai_label: true`; the text comes from `labels.ai_assisted`. Media are referenced as `{ url, width, height, sha256, bytes }` with a 300 KB budget per image variant used in lists; EXIF and GPS are stripped at upload (`media_asset.exif_stripped` must be true).

## 7. Extension contracts

### 7.1 Module identity and manifest

- Module id: `^[a-z][a-z0-9_]{0,30}\.[a-z][a-z0-9_]{0,30}$` (`<vendor>.<name>`; the framework's own modules use `core.`). Each module also declares `short` (`^[a-z][a-z0-9]{1,15}$`, unique per instance), used for the schema `mod_<short>`, its DB role, bundle prefixes and queue names.
- Each module package ships `mandato.module.json`, validated by `packages/core-contracts/schema/module.schema.json`:

```json
{
  "id": "demo.hello",
  "short": "hello",
  "version": "0.1.0",
  "requires_framework": "^0.1.0",
  "requires_modules": [],
  "data_classes": ["C0", "C1"],
  "roles": [{ "id": "demo.hello.viewer", "label": "Visualizador" }],
  "permissions": [{ "id": "demo.hello.read", "roles": ["demo.hello.viewer", "chefe_gabinete"] }],
  "migrations": "db/migrations",
  "web": "web/index.ts",
  "mobile": "mobile/index.ts",
  "worker": "worker/hello",
  "settings_schema": "settings.schema.json",
  "retention": [{ "table": "greeting_log", "days": 365 }],
  "data_subject": null
}
```

- `web` exports `routes: Route[]`, and optionally `publishTargets: PublishTarget[]` and `contentEnrichers: ContentEnricher[]`. `mobile` exports `screens: Screen[]`. `worker` is a Python package exposing `jobs`, `connectors` and `providers` lists (§7.3–7.5). Any of them may be absent.
- `data_subject`: modules that store C2+ data name a worker hook implementing `export(subject_ref)` and `erase(subject_ref)` for data-subject requests. Required when `data_classes` contains C2 or C3.

### 7.2 Composition (build time) and boot

Store apps cannot load code at runtime, so modules are composed **at build time, in the instance's build workspace**, never in this repository:

1. `mandato compose` (CLI shipped by the framework) reads `tenant.yaml` `modules[]`, resolves each id to an installed package's `mandato.module.json`, checks `requires_framework` and `requires_modules`, and writes `generated/modules.web.ts`, `generated/modules.mobile.ts` and `generated/modules.py` with static imports.
2. The web, mobile and worker builds import only the generated files.
3. This repository's own builds compose only `core.*` and `demo.*` modules.

Boot (API and workers): validate `tenant.yaml` → load generated registry → `mandato migrate` → sync `instance`, `cause`, `role`, `permission` rows from config and manifests → start. Any failure stops boot.

`mandato bootstrap` (superuser) applies every core migration not yet recorded, each in one transaction that also records it, and creates module owner roles and schemas. A core migration is never edited after it ships; a change is a new `NNNN_core.sql`. `mandato migrate` connects as `migrator`, records the core migrations, then applies module migrations in dependency order. `migrator` is a member of no core or audit owner role, so a module migration that leaves its owner role (`set_config('role', …)`, `RESET ROLE`) gains nothing in `core` or `audit`; `audit.record_migration()` accepts only the migration bound to the current transaction. Each file runs through `EXECUTE`, never as a psql script. Residual until per-module migration logins exist (deployment lane): `migrator` is a member of every module owner role, so a hostile module migration could reach another module's schema.
- Each module step runs after `SET ROLE mod_<short>_owner` with `set search_path = mod_<short>, pg_temp`.
- Module owner roles are `NOLOGIN NOINHERIT NOBYPASSRLS`. They hold `CREATE` only on their own schema and `REFERENCES` on the `core` columns listed in Appendix A as referenceable (`id` columns). They have no `CREATE` on `public`, `core` or `api`.
- A module migration may not create `SECURITY DEFINER` functions, event triggers, extensions or roles. The migrator parses each file and rejects these statements before running it.
- Every applied file is recorded in `audit.migration_log (module_id, migration_id, sha256, applied_at)` through `audit.record_migration()`. The table is owned by `audit_owner`, has raising update/delete/truncate triggers, and no role that `migrator` can assume owns it, so history cannot be rewritten by a migration. On boot, a recorded migration whose file hash differs aborts boot. Migrations are forward-only.

Licensing of combined builds (closed modules statically bundled with the AGPL framework) relies on Tekne being the sole copyright holder of the framework: Tekne licenses the framework to each contracting mandate on terms that cover the combination, alongside the public AGPL. This is recorded for alignment with legal advisers; it does not change this contract.

### 7.3 Connectors (Python, `workers/core/contracts/connector.py`)

```python
class ConnectorManifest(TypedDict):
    source_id: str            # same id in tenant.yaml, data_source, bundles and figures
    name: str; terms_url: str; robots: str
    auth: Literal["none", "api_key", "oauth"]; auth_secret_ref: str | None
    rate_limit_per_min: int; data_class: DataClass; natural_key: list[str]

class Connector(Protocol):
    manifest: ConnectorManifest
    def discover(self, ctx: JobContext) -> list[Resource]: ...
    def fetch(self, resource: Resource, cursor: dict | None, ctx: JobContext) -> RawBatch: ...
    def normalize(self, raw: RawBatch) -> list[Record]: ...
    def validate(self, records: list[Record]) -> ValidationReport: ...
    def upsert(self, records: list[Record], tx: Tx) -> UpsertStats: ...   # idempotent on natural_key
```

Synchronous. The runner owns the transaction, stores the returned cursor in `data_source.cursor`, writes `data_source_run`, and refuses records when `validate` reports errors. Connectors are found through the `worker` package's `connectors` list, never by free-form import strings.

### 7.4 Jobs and the queue (`job` table, `schema/job.schema.json`)

`core.job` columns are in Appendix A. Workers take work only through `core.claim_job(queues text[])`, which uses `select … for update skip locked` limited to the queues of the caller's pool, sets `state = 'running'`, `locked_by` and `locked_at`, stores the SHA-256 of a fresh 128-bit lease token in `lease_hash`, and returns the job with the token. Every transaction of that job starts with `audit.bind_lease(token)` (§4.5). Jobs classed C0 or C1 run in the `c1` pool.

Payloads carry **references** (ids, storage keys), never C2/C3 plaintext. A CI test rejects payload schemas with `pii_`/`phi_`/`piim_` property names.

```python
class JobContext(Protocol):
    job_id: UUID; data_class: DataClass                 # actor is derived by the database (§4.5)
    def tx(self) -> ContextManager[Tx]: ...
    def load_part(self, table: str, column: str, row_id: UUID) -> ClassifiedPart: ...
    def ai(self) -> AiGateway: ...
    def secret(self, ref: str) -> str: ...

class Job(Protocol):
    queue: str; data_class: DataClass; concurrency: int
    def run(self, payload: dict, ctx: JobContext) -> JobResult: ...
```

`ContentEnricher.onSave` (TypeScript) returns a `JobRequest { queue, payload, idempotency_key, data_class }` or `null`; the API inserts it into `core.job`.

### 7.5 AI gateway (Python, `workers/core/contracts/ai.py`)

**Trust model.** Closed modules are code that Tekne writes and reviews. They run in the same worker process as the framework, so the framework cannot defend against malicious module code in-process. It defends against mistakes in code, and it puts the hard boundary where code cannot move it: the network and the operator's configuration.

```python
class DataClass(IntEnum): C0 = 0; C1 = 1; C2 = 2; C3 = 3

class ClassifiedPart:                 # opaque; only the framework constructs it
    kind: Literal["text", "image", "audio"]
    data_class: DataClass             # read-only

# Loaders that produce parts (the only constructors):
#   ctx.load_part(table, column, row_id)   class = Appendix A class of the column (unknown = C3)
#   ctx.text_part(text)                     class = the job's data_class (never lower)
#   ctx.blob_part(storage_key)              class = class recorded with the blob; the gateway fetches it
# A part's class can be raised (part.at_least(C3)), never lowered.

class AiProvider(Protocol):           # implemented in closed modules
    id: str
    def generate(self, task: str, parts: list[ClassifiedPart], output_schema: dict) -> AiResult: ...

class ProviderRouter(Protocol):       # implemented in closed modules
    def route(self, task: str, effective_class: DataClass) -> str | None: ...   # returns a provider id

class AiGateway:                      # framework-owned, not an extension point
    def generate(self, task: str, job_class: DataClass, parts: list[ClassifiedPart], output_schema: dict) -> AiResult: ...
```

- **Locality and class ceiling are operator data, not provider attributes.** `tenant.yaml` → `ai.providers[]` lists each provider id with `locality` (`local` | `external`), `max_data_class` and `egress` (the hostnames it may reach), set by the operator per instance. A `local` provider may list only private egress hosts (`localhost`, `*.internal`, `*.local`, `*.lan`, RFC 1918 addresses); the schema and the guard both refuse anything else. A provider not listed there cannot be used. The `ai` block is the one part of `tenant.yaml` that the operator controls and that is reviewed with the mandate's data controller.
- The gateway computes `effective_class = max(job class, every part's class)`, asks the router for a provider id, looks that id up in the operator list, and **refuses before any network call** when:
  - the router returns nothing;
  - the id is not in the operator list;
  - `effective_class` is above that entry's `max_data_class`;
  - `effective_class == C3` and the entry is not `local`.
- **Isolation is the hard boundary, not code.**
  - **Workers have no internet egress at all.** Worker containers can reach only the database, object storage and the provider sidecars of their pool.
  - **Every provider runs as its own sidecar process,** with its own network identity, and only that sidecar may reach its `egress` hosts. Provider adapter code from closed modules runs inside the sidecar, not in the worker. The sidecar enforces its own `max_data_class` from the operator list on every request and records provenance.
  - **There is one worker pool per data class** (`c1`, `c2`, `c3`). Each pool has its own database role, which cannot read columns above that class (§4.1). Each pool's network reaches only the sidecars cleared for that class: the C3 pool reaches only `local` sidecars, and the C2 pool only sidecars with `max_data_class ≥ C2`. A job runs in the pool of its `data_class`.
  - **Residual risk, stated plainly:** code in a C2 pool could still mislabel C2 data and send it to a sidecar cleared for C2. That is allowed anyway. Code in the C1 pool cannot read C2 data, because the database refuses. So mislabeling inside the process can no longer move data above the ceiling that the operator set.
- **Static checks are defense in depth.** CI fails when a module imports a provider SDK (`anthropic`, `openai`, `google.genai`, `httpx`/`requests` toward non-local hosts) outside its `providers` package, or when module code instantiates a provider directly. Parts can only be built through the loaders above.
- `task` is `<module short>.<task>`.
- The framework ships `NoneRouter` (always nothing) and `EchoProvider` (deterministic, local, for CI and the demo; contains no prompts). Real routers, providers and prompts live in closed modules and are listed in the module's `worker.providers`.
- Every call that reaches a provider writes `core.ai_provenance` with `prompt_ref` and `input_sha256`, never prompt or input text.
- `AiResult`: `{ output: dict, provider_id, model, tokens_in, tokens_out, provenance_id }`.

### 7.6 Web and mobile (TypeScript, `packages/core-contracts/src`)

```ts
export type RoleId = string;                 // e.g. 'chefe_gabinete', 'demo.hello.viewer'
export interface Route { path: string; permission?: string; load: () => Promise<{ default: React.ComponentType }> }
export interface Screen { id: string; variant: 'citizen' | 'gabinete'; permission?: string; load: () => Promise<{ default: React.ComponentType }> }
export interface PublishContext { generation: number }
export interface BundleRequest { name: string; projection: string; ids: string[] }   // projection from packages/core-publish/projections
export interface PublishTarget { id: string; bundles: (ctx: PublishContext) => Promise<BundleRequest[]> }
export interface ContentEnricher { id: string; onSave: (ref: { contentId: string; version: number }) => JobRequest | null }
declare const published: unique symbol;
export type PublishedRecord = { readonly [published]: true; id: string; updated_at: string }   // constructed only by core-publish
export interface JobRequest { queue: string; payload: Record<string, unknown>; idempotency_key?: string; data_class: 'C0' | 'C1' | 'C2' | 'C3' }
```

Routes and screens are guarded by **permission**, not role, so a mandate can rearrange roles without code changes.

## 8. Design tokens (`packages/core-theme/schema/tokens.schema.json`)

- Color roles, each in `light` and `dark`: `brand` (identity surfaces: header, app bar), `brand-on`, `accent` (highlights, never text on light backgrounds), `link`, `cta` (primary action buttons), `cta-on`, `bg`, `surface`, `fg`, `muted`, `line`, `success`, `warning`, `error`, `info`.
- Typography: `display` (at most one downloaded font), `body` (system stack allowed), size scale. `radius` and `spacing` scales.
- Cause icons live in `tenant.yaml` only.
- Contrast is part of the contract, checked in **both** modes: `fg/bg`, `fg/surface`, `muted/bg`, `muted/surface`, `link/bg`, `link/surface`, `brand-on/brand`, `cta-on/cta` at ≥ 4.5:1; `line/bg` and status colors on `bg` at ≥ 3:1. The framework's neutral default theme passes.

## 9. API conventions (`docs/api-conventions.md`)

- REST + JSON under `/api/v1`. A breaking change ships as `/api/v2`; `/api/v1` stays until every supported app version (≥ `min_app_version`) uses v2, and at least 90 days.
- Staff auth: Supabase JWT as `Authorization: Bearer`, `aal2` required; the API also checks permissions, and RLS enforces them again.
- **Public writes** (contact, report, request forms) need no JWT.
  - **Responses** are uniform and minimal: `202 { receipt_id }`. They never echo submitted data and never reveal whether a person or case already exists.
  - **Idempotency:** `Idempotency-Key` is required (UUID, scoped to the endpoint). The store `core.idempotency` (Appendix A, C1) keeps `sha256(endpoint|key)`, `sha256(body)`, the status and the `receipt_id` only. Rows are deleted after 24 h. A replay with the same body returns the same receipt; a different body returns 409.
  - **Client IP:** taken only from the hosting platform's trusted client-IP header, never from client-supplied headers. IPv4 is used as a full address. IPv6 is truncated to its /64 prefix.
  - **Rate limiting** is keyed by `HMAC(daily_key, canonical IP or prefix)`. Counters live 1 h. Daily keys are destroyed after 48 h, so old counters cannot be linked back to an address. Raw IPs are never stored.
  - **Quotas** apply per key and endpoint, globally per endpoint, and on concurrency. Bodies are limited to 16 KB. Attachments are a module concern: they are quarantined and scanned before any staff member can open them.
  - **Challenge:** above a threshold, the API demands a privacy-preserving challenge (no tracking cookies) before accepting more.
- Errors: RFC 9457 `application/problem+json`; `type` as `urn:mandato:error:<code>`; pt-BR `title`; field errors in `errors[] { field, code, message }`; never echo personal data.
- Pagination: cursor over `(sort key, id)`, opaque base64; `?cursor=&limit=` (max 100); response `{ data, next_cursor }`.
- Dates: instants ISO 8601 with offset; dates `YYYY-MM-DD`; periods `{ start, end }` inclusive dates. Money in integer centavos with `currency: "BRL"`. Municipalities by IBGE code.

## 10. Review findings and where they are answered

| Finding (v1 review) | Change |
| --- | --- |
| B1 columns not in repo | §4.3 data dictionary; `organization` and `user_key` removed from 0001 (YAGNI) |
| B2 access surfaces, `aal2`, RLS | §4.1: only `api` exposed, `has_role` requires `aal2`, identity mapping |
| B3 AI guard not buildable | §7.5: ordered `DataClass`, `locality`, per-part class, `ProviderRouter`, `EchoProvider`, namespaced task, provenance without text |
| B4 composition and migrations | §7.1–7.2: manifest exports, build-time `mandato compose`, boot and migration order; licensing note |
| B5 mixed sync models | §6.3: stable partitions, snapshot replace, immutable URLs, `generation`, `min_generation`, `takedowns[]`, client algorithm |
| M1, M2 classification | §3 table of classes and prefixes, class on every column, §6.2 row + column rule |
| M3 roles | §4.4 namespaced roles, `permission` tables, grant rules, CI checks, disable behaviour |
| M4 module id → schema | §7.1 id grammar and `short` |
| M5 audit | §4.5 actor kinds, `app.actor`, revokes |
| M6 encryption | §4.6 envelope, AAD, keys, rotation, blind indexes |
| M7 LGPD lifecycle | §7.1 `retention` and `data_subject`; §4.5 audit retention; §9 idempotency and rate-limit keys |
| M8 job envelope | §7.4 queue table, references only, `JobContext` |
| M9 types to mock | §7.4–7.6 field-level types |
| M10 connectors | §7.3 single `source_id`, sync, cursor, natural key, discovery by list |
| M11 content states | §6.1 |
| M12 evolution | §6.3 unknown fields ignored, `min_app_version`; §9 v1 sunset; §11 versioning |
| M13 media | §6.3 media reference and budget |
| M14 public writes | §9 |
| M15 freeze process | §11 |


| Finding (v2 cross-provider review) | Change in v3 |
| --- | --- |
| CP-01 data dictionary incomplete | Appendix A: type, nullability, default, class, keys and delete action for every column |
| CP-02 implicit declassification | §6.2 fixed projections with C0 output fields; declassification is the audited publish transition |
| CP-03 guard trusts caller and provider | §7.5 opaque parts built only by loaders; locality and ceiling are operator data; egress proxy and C3 worker pool; static import checks; explicit trust model |
| CP-04 grants and runtime roles | §4.1 runtime roles, `NOBYPASSRLS`, per-request JWT claims, revokes, CI on grants |
| CP-05 role administration | §4.4 no direct DML; `grant_role`/`revoke_role` specification and adversarial tests |
| CP-06 audit owner can rewrite | §4.5 separate `audit` schema and `audit_owner`, raising triggers, separate archiver |
| CP-07 settable actor | §4.5 actor derived from `session_user`, JWT and a per-transaction lease |
| CP-08 key registry and rotation | §4.6 `core.data_key`, authenticated wrapping, states, rotation steps |
| CP-09 blind-index lifecycle | §4.6 versioned index and normalization, dual write, shared test vectors |
| CP-10 migration role and integrity | §7.2 role attributes, forbidden statements, `core.migration_log` with hashes |
| CP-11 targets can build records | §6.2 and §7.6 targets return projection requests; `PublishedRecord` is opaque |
| CP-12 rollback and takedowns | §6.3 signed manifest, generation must not decrease, takedowns before version gate, expiry rule |
| CP-13 idempotency store | §9 minimal receipt, hashed keys, 24 h deletion, no echo |
| CP-14 rate limiting | §9 trusted IP header, IPv6 /64, layered quotas, body limit, challenge, uniform responses |

| Finding (v3 cross-provider review) | Change in v4 |
| --- | --- |
| NEW-1 actor under `SECURITY DEFINER` | §4.5 `session_user`, no `kind` parameter, per-transaction lease bound by token in `audit.tx_lease` |
| NEW-2 projections vs record shape | §6.2 `id` aliases, `updated_at` in every projection, one JSON Schema per projection, `institutional` removed |
| NEW-3 manifest signature | §6.3 RFC 8785, `sig.key_id`, keyring with `current`/`next`, signed `keyring_update`, `expires_at`, `min_generation_at_build` |
| NEW-4 shared egress | §7.5 no worker egress, one sidecar per provider with its own egress, one worker pool and DB role per class |
| CP-01 partly | Appendix A repeats common columns per table; `data_source` classed C1 |
| CP-03 partly | NEW-4 |
| CP-04 partly | §4.1 class-bound worker roles, grant matrix as a CI-checked E0.0 artifact, transaction time bounds |
| CP-07 partly | NEW-1 |
| CP-08 partly | §4.6 wrapped-DEK envelope, KEK versioning, rotation and offline recovery copy; scan pause tied to the 5-minute bound |
| CP-10 partly | §7.2 `audit.migration_log` owned by `audit_owner` |
| CP-11 partly | NEW-2 |
| CP-12 partly | NEW-3 |

Minor items were applied in place (`settings_schema`, list form of `modules`, `cause` naming, one home for cause icons, `labels.ai_assisted`, figures on all numbers, contrast in both modes, SQL `uuid7()`, IBGE key, single `instance` row, secret refs, `flags` removed, `demo.hello` example, `Screen.tab` removed).

## 11. Definition of done for E0.0 and change control

Artifacts, all in this repository:
- `packages/core-config/schema/tenant.schema.json`, `packages/core-theme/schema/tokens.schema.json`, `packages/core-publish/schema/bundle.schema.json`, `packages/core-contracts/schema/module.schema.json`, `schema/job.schema.json`.
- `packages/db/migrations/0001_core.sql` with RLS policies, comments and the CI checks in §3, §4.4.
- `packages/core-contracts/src/*.ts` and `workers/core/contracts/*.py` as in §7, compiling, with no implementation beyond `NoneRouter`, `NoneProvider` and `EchoProvider`.
- `docs/api-conventions.md` (§9).
- `packages/db/grants.md` (generated grant matrix), `packages/core-publish/projections/*.json` with their schemas, and the shared test vectors in `packages/crypto/vectors/` and `packages/core-publish/vectors/`.
- The nine implementation tests in `egm/0001/stage6-cross-provider-codex-v4.md`; where each one runs, or which lane owns it, is in `egm/0001/implementation-tests.md`.
- The answers to the independent verification of the implementation (`egm/0001/stage7-e00-verification-codex.md`) in `egm/0001/stage7-response.md`.
- The answers to the re-verification (`egm/0001/stage8-e00-reverification-codex.md`) in `egm/0001/stage8-response.md`.
- Adversarial SQL tests: self-grant, `aal1` reads, cross-pool column reads, audit writes without a lease, reuse of a lease after commit, and rewriting `audit.migration_log`.
- Fixtures in `tenants/demo/`: valid `tenant.yaml`, neutral `theme/tokens.json`, seed with 4 staff users (one per framework role), 6 content items covering every state, 4 agenda events, 3 municipalities; a published `manifest.json` with two partitions, one takedown and one tombstoned record; `demo.hello` module with a route, a screen and a job. Synthetic data only.
- Negative fixtures that CI must reject: a `tenant.yaml` with an unknown key, a token set failing contrast, a migration with an unclassified column, a publish attempt including a `pii_` column.

Done when CI passes on those artifacts and someone other than the executor verifies them against this document.

**Stopping rule for design review.** After v4, one last cross-provider pass checks only the security items (§4.1, §4.5, §4.6, §6.3, §7.5). Blockers found there are fixed in the design. Anything else becomes an executable test of the E0.0 implementation instead of another design round, because a failing test settles these questions faster than more prose. The `tenants/demo/` fixtures belong to the backbone.

Contracts are versioned `0.x` until launch. After freeze, a change goes through a backbone decision recorded in this file's history, bumps the contract's version, and updates fixtures in the same PR.

**Change history after freeze.**
- **0.1.1** (2026-11-23, design 0002, `0003_core.sql`): `core.is_aal2()` accepts `aal2` only with a `totp` entry in `amr` (a narrowing: every caller accepted now was accepted before). `grant_role` and `revoke_role` also require `core.recent_totp('15 minutes')`. New table `core.staff_invitation` (Appendix A), permission `core.staff.manage`, audit actions `invite`, `cancel_invite`, `activate`, `bootstrap_chief`, `set_status`. New definer functions: `recent_totp`, `invitation_open`, `create_invitation`, `cancel_invitation`, `create_bootstrap_invitation` (migrator), `activate_invitation`, `my_invitation`, `set_user_status`, `index_key`, `staff_keys` (api_rt with aal2, and migrator), `add_staff_key` (migrator). New policies `self_read` on `app_user` and `role_assignment` (own row, aal2). Staff-key purposes are `core.app_user.pii_name|pii_email`, `core.staff_invitation.pii_name|pii_email` and `bi:email:v1` (one index key for both e-mail columns, so an invitation and its user match).

Repository layout created by E0.0:

```
apps/web  apps/mobile                     (shells, later lanes)
packages/core-config  core-theme  core-publish  core-contracts  core-domain  crypto  db
workers/core/contracts
tenants/demo
docs/api-conventions.md  docs/designs/
```

## 12. Out of scope

Closed-module schemas, AI routing tables and prompts, state connectors, and the gabinete app screens. They are designed later against these contracts.

## Appendix A — Data dictionary for `0001_core.sql`

Legend: **Null** `N` = `not null`, `Y` = nullable. **Class** is the `class=` comment. FK actions are `on delete restrict` unless shown. `ref` marks the `core` columns that module owner roles may `REFERENCES` (§7.2).

**Common columns, present on every table below except `audit.*`, `core.idempotency` and `core.rate_counter`; they are also repeated in each table for exactness:**

| Column | Type | Null | Default | Class |
| --- | --- | --- | --- | --- |
| `created_at` | `timestamptz` | N | `now()` | C1 |
| `updated_at` | `timestamptz` | N | `now()`, set by trigger | C1 |

In C0 tables these two columns are C0.

### Identity and access

`core.instance` (C0)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `smallint` | N | `1` | C0 | PK, `check (id = 1)` |
| `slug` | `text` | N | | C0 | `check (slug ~ '^[a-z][a-z0-9-]{1,30}$')` |
| `display_name` | `text` | N | | C0 | |
| `house_acronym` | `text` | N | | C0 | |
| `uf` | `char(2)` | N | | C0 | |
| `config_version` | `text` | N | | C0 | |
| `framework_version` | `text` | N | | C0 | |
| `created_at` | `timestamptz` | N | `now()` | C0 | |
| `updated_at` | `timestamptz` | N | `now()` | C0 | set by trigger |

`core.app_user` (C2)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK, ref; equals `auth.users.id` (no FK across schemas) |
| `pii_name` | `bytea` | N | | C2 | envelope §4.6 |
| `pii_email` | `bytea` | N | | C2 | envelope §4.6 |
| `bi_email` | `bytea` | N | | C1 | unique |
| `bi_email_next` | `bytea` | Y | | C1 | unique; used only during rotation |
| `status` | `text` | N | `'active'` | C1 | `check in ('active','suspended','removed')` |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.role` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `text` | N | | C1 | PK, ref |
| `label` | `text` | N | | C1 | |
| `module_id` | `text` | Y | | C1 | FK `module_registry.module_id`; null for framework roles |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.permission` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `text` | N | | C1 | PK |
| `label` | `text` | N | | C1 | |
| `module_id` | `text` | Y | | C1 | FK `module_registry.module_id` |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.role_permission` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `role_id` | `text` | N | | C1 | PK part, FK `role.id` on delete cascade |
| `permission_id` | `text` | N | | C1 | PK part, FK `permission.id` on delete cascade |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.role_assignment` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK |
| `user_id` | `uuid` | N | | C1 | FK `app_user.id` |
| `role_id` | `text` | N | | C1 | FK `role.id` |
| `granted_by` | `uuid` | N | | C1 | FK `app_user.id`; set from `auth.uid()` |
| `granted_at` | `timestamptz` | N | `now()` | C1 | |
| `revoked_by` | `uuid` | Y | | C1 | FK `app_user.id` |
| `revoked_at` | `timestamptz` | Y | | C1 | partial unique (`user_id`, `role_id`) where `revoked_at is null` |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.staff_invitation` (C2; contract 0.1.1, `0003_core.sql`, design 0002 §6)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | `core.uuid7()` | C1 | PK; generated by the API or the operator CLI so the ciphertext's AAD binds it |
| `pii_name` | `bytea` | N | | C2 | envelope, purpose `core.staff_invitation.pii_name` |
| `pii_email` | `bytea` | N | | C2 | envelope, purpose `core.staff_invitation.pii_email` |
| `bi_email` | `bytea` | N | | C1 | key `bi:email:v1`, shared with `app_user.bi_email`; partial unique where open |
| `bootstrap` | `boolean` | N | `false` | C1 | partial unique (`bootstrap`) where bootstrap and open |
| `invited_by` | `uuid` | Y | | C1 | FK `app_user.id`; null exactly when `bootstrap` |
| `expires_at` | `timestamptz` | N | | C1 | 7 days after creation |
| `used_at` | `timestamptz` | Y | | C1 | set with `used_by` |
| `used_by` | `uuid` | Y | | C1 | FK `app_user.id` |
| `cancelled_at` | `timestamptz` | Y | | C1 | never set together with `used_at` |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`audit.event` (C1, append-only, §4.5)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | `core.uuid7()` | C1 | PK |
| `at` | `timestamptz` | N | `now()` | C1 | |
| `db_role` | `text` | N | `session_user` | C1 | the login role, never the definer |
| `actor_kind` | `text` | N | | C1 | `check in ('user','worker','migration','system')` |
| `actor_id` | `text` | N | | C1 | user uuid, job id or migration id |
| `action` | `text` | N | | C1 | |
| `entity` | `text` | N | | C1 | `<schema>.<table>` |
| `entity_id` | `text` | Y | | C1 | |
| `details` | `jsonb` | N | `'{}'` | C1 | ids and field names only |

`audit.tx_lease` (C1, owned by `audit_owner`, no grants to any other role)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `txid` | `xid8` | N | `pg_current_xact_id()` | C1 | PK |
| `kind` | `text` | N | | C1 | `check in ('worker','migration')` |
| `ref` | `text` | N | | C1 | job id or `<module_id>:<migration_id>` |
| `bound_at` | `timestamptz` | N | `now()` | C1 | rows older than 1 h are purged |

### Content and agenda

`core.cause` (C0)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `slug` | `text` | N | | C0 | PK, ref |
| `name` | `text` | N | | C0 | |
| `icon` | `text` | N | | C0 | |
| `sort` | `smallint` | N | `0` | C0 | |
| `created_at` | `timestamptz` | N | `now()` | C0 | |
| `updated_at` | `timestamptz` | N | `now()` | C0 | set by trigger |

`core.content_item` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK, ref |
| `type` | `text` | N | | C1 | `check in ('noticia','nota','artigo','balanco','posicionamento','card_dado','video_link')` |
| `state` | `text` | N | `'draft'` | C1 | `check in ('draft','in_review','approved','published','withdrawn','archived')` |
| `current_version` | `int` | N | `1` | C1 | |
| `published_version` | `int` | Y | | C1 | FK (`id`, `published_version`) → `content_version` (`content_id`, `n`) |
| `published_at` | `timestamptz` | Y | | C1 | |
| `author_id` | `uuid` | N | | C1 | FK `app_user.id` |
| `approver_id` | `uuid` | Y | | C1 | FK `app_user.id`; `check (approver_id is distinct from author_id)` |
| `deleted_at` | `timestamptz` | Y | | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.content_version` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `content_id` | `uuid` | N | | C1 | PK part, FK `content_item.id` |
| `n` | `int` | N | | C1 | PK part |
| `title` | `text` | N | | C1 | |
| `summary` | `text` | N | `''` | C1 | |
| `body_md` | `text` | N | `''` | C1 | |
| `figures` | `jsonb` | N | `'[]'` | C1 | each `{ value, unit, source_id, source_url, reference_date }` |
| `created_by` | `uuid` | N | | C1 | FK `app_user.id` |
| `ai_provenance_id` | `uuid` | Y | | C1 | FK `ai_provenance.id` |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.content_cause` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `content_id` | `uuid` | N | | C1 | PK part, FK `content_item.id` on delete cascade |
| `cause_slug` | `text` | N | | C1 | PK part, FK `cause.slug` |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.media_asset` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK, ref |
| `kind` | `text` | N | | C1 | `check in ('image','video_link','document')` |
| `storage_key` | `text` | N | | C1 | unique |
| `sha256` | `text` | N | | C1 | |
| `bytes` | `int` | N | | C1 | |
| `width` | `int` | Y | | C1 | |
| `height` | `int` | Y | | C1 | |
| `variants` | `jsonb` | N | `'[]'` | C1 | each `{ storage_key, width, height, bytes, sha256 }` |
| `alt_text` | `text` | N | `''` | C1 | |
| `exif_stripped` | `boolean` | N | | C1 | `check (exif_stripped)` |
| `deleted_at` | `timestamptz` | Y | | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.content_media` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `content_id` | `uuid` | N | | C1 | PK part, FK `content_item.id` on delete cascade |
| `media_id` | `uuid` | N | | C1 | PK part, FK `media_asset.id` |
| `position` | `smallint` | N | `0` | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.agenda_event` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK, ref |
| `starts_at` | `timestamptz` | N | | C1 | |
| `ends_at` | `timestamptz` | Y | | C1 | `check (ends_at is null or ends_at >= starts_at)` |
| `title` | `text` | N | | C1 | |
| `kind` | `text` | N | | C1 | |
| `municipality_ibge` | `char(7)` | Y | | C1 | FK `municipality.ibge_code` |
| `place` | `text` | N | `''` | C1 | |
| `visibility` | `text` | N | `'internal'` | C1 | `check in ('public','internal')` |
| `status` | `text` | N | `'planned'` | C1 | `check in ('planned','done','cancelled')` |
| `deleted_at` | `timestamptz` | Y | | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.municipality` (C0)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `ibge_code` | `char(7)` | N | | C0 | PK, ref |
| `name` | `text` | N | | C0 | |
| `uf` | `char(2)` | N | | C0 | |
| `health_region` | `text` | Y | | C0 | |
| `population` | `int` | Y | | C0 | |
| `population_ref_date` | `date` | Y | | C0 | `check ((population is null) = (population_ref_date is null))` |
| `created_at` | `timestamptz` | N | `now()` | C0 | |
| `updated_at` | `timestamptz` | N | `now()` | C0 | set by trigger |

### Data sources, AI and operations

`core.data_source` (C1: the table holds the C1 `cursor`; every other column is C0 and published through no projection)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `source_id` | `text` | N | | C0 | PK, ref |
| `name` | `text` | N | | C0 | |
| `terms_url` | `text` | N | | C0 | |
| `cadence` | `text` | N | | C0 | cron, instance timezone |
| `last_success_at` | `timestamptz` | Y | | C0 | |
| `cursor` | `jsonb` | Y | | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`audit.term` (C1: closed vocabulary for audit actions, states and projection names; framework terms seeded by 0001, module terms registered by `migrator` through `audit.register_term`)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `term` | `text` | N | | C1 | PK part, identifier |
| `kind` | `text` | N | | C1 | PK part, `action` \| `state` \| `projection` |
| `module_id` | `text` | N | | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |

`core.data_source_run` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK |
| `source_id` | `text` | N | | C1 | FK `data_source.source_id` |
| `started_at` | `timestamptz` | N | `now()` | C1 | |
| `finished_at` | `timestamptz` | Y | | C1 | |
| `status` | `text` | N | `'running'` | C1 | `check in ('running','ok','failed','rejected')` |
| `stats` | `jsonb` | N | `'{}'` | C1 | |
| `error` | `text` | Y | | C1 | no record contents |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.ai_provenance` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK, ref |
| `task` | `text` | N | | C1 | `<module short>.<task>` |
| `effective_class` | `text` | N | | C1 | `check in ('C0','C1','C2','C3')` |
| `provider_id` | `text` | N | | C1 | from `tenant.yaml` `ai.providers[]` |
| `locality` | `text` | N | | C1 | copied from the operator list, not from the provider |
| `model` | `text` | N | | C1 | |
| `prompt_ref` | `text` | N | | C1 | version id or hash, never text |
| `input_sha256` | `text` | N | | C1 | |
| `tokens_in` | `int` | N | `0` | C1 | |
| `tokens_out` | `int` | N | `0` | C1 | |
| `job_id` | `uuid` | Y | | C1 | FK `job.id` |
| `reviewed_by` | `uuid` | Y | | C1 | FK `app_user.id` |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.job` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `id` | `uuid` | N | | C1 | PK |
| `queue` | `text` | N | | C1 | `<short>.<name>` |
| `data_class` | `text` | N | | C1 | `check in ('C0','C1','C2','C3')` |
| `idempotency_key` | `text` | Y | | C1 | unique with `queue` |
| `payload` | `jsonb` | N | `'{}'` | C1 | references only (§7.4) |
| `state` | `text` | N | `'queued'` | C1 | `check in ('queued','running','done','failed','dead')` |
| `attempts` | `smallint` | N | `0` | C1 | |
| `max_attempts` | `smallint` | N | `5` | C1 | |
| `run_after` | `timestamptz` | N | `now()` | C1 | index with `state`, `queue` |
| `locked_by` | `text` | Y | | C1 | worker instance id |
| `locked_at` | `timestamptz` | Y | | C1 | |
| `lease_hash` | `bytea` | Y | | C1 | SHA-256 of the lease token; set only by `core.claim_job()` |
| `last_error` | `text` | Y | | C1 | no payload contents |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.module_registry` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `module_id` | `text` | N | | C1 | PK |
| `short` | `text` | N | | C1 | unique |
| `version` | `text` | N | | C1 | |
| `enabled` | `boolean` | N | `true` | C1 | |
| `installed_at` | `timestamptz` | N | `now()` | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`audit.migration_log` (C1, append-only, owned by `audit_owner`)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `module_id` | `text` | N | | C1 | PK part (`core` for the framework) |
| `migration_id` | `text` | N | | C1 | PK part, file name |
| `sha256` | `text` | N | | C1 | |
| `applied_at` | `timestamptz` | N | `now()` | C1 | |

`core.data_key` (C3)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `key_id` | `uuid` | N | | C1 | PK |
| `purpose` | `text` | N | | C1 | `<schema>.<table>.<column>` or `bi:<schema>.<table>.<column>` |
| `data_class` | `text` | N | | C1 | `check in ('C2','C3')`: class of the data the key protects; RLS lets a reader see only keys up to its own class (added in implementation, 0.1.1) |
| `version` | `int` | N | | C1 | unique with `purpose` |
| `enc_wrapped_key` | `bytea` | N | | C3 | wrapped by the KEK (§4.6) |
| `state` | `text` | N | `'active'` | C1 | `check in ('active','decrypt_only','retired')`; partial unique on `purpose` where `state = 'active'` |
| `retired_at` | `timestamptz` | Y | | C1 | |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.publish_generation` (C1)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `generation` | `bigint` | N | | C1 | PK, strictly increasing |
| `at` | `timestamptz` | N | `now()` | C1 | |
| `manifest_sha256` | `text` | N | | C1 | |
| `min_generation` | `bigint` | N | | C1 | |
| `triggered_by` | `text` | N | | C1 | audit actor |
| `created_at` | `timestamptz` | N | `now()` | C1 | |
| `updated_at` | `timestamptz` | N | `now()` | C1 | set by trigger |

`core.idempotency` (C1, rows deleted after 24 h)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `key_hash` | `bytea` | N | | C1 | PK, `sha256(endpoint|key)` |
| `body_sha256` | `bytea` | N | | C1 | |
| `status` | `smallint` | N | | C1 | |
| `receipt_id` | `uuid` | N | | C1 | |
| `expires_at` | `timestamptz` | N | `now() + interval '24 hours'` | C1 | |

`core.rate_counter` (C1, `unlogged`, rows deleted after 1 h)

| Column | Type | Null | Default | Class | Key / notes |
| --- | --- | --- | --- | --- | --- |
| `key` | `bytea` | N | | C1 | PK part, `HMAC(daily_key, IP or /64)` |
| `endpoint` | `text` | N | | C1 | PK part |
| `window_start` | `timestamptz` | N | | C1 | PK part |
| `count` | `int` | N | `0` | C1 | |
