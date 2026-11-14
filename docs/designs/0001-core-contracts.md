# Design 0001 — Core contracts (backlog E0.0)

Status: **v2, revised after the first Elephant-Goldfish review** · 2026-11-14 · Owner: architecture backbone
Review of v1: [`egm/0001/REPORT.md`](egm/0001/REPORT.md). Section 10 maps every blocker and major finding to the change made here.

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

### 4.1 Schemas and access surfaces

| Schema | Owner | Exposed to clients |
| --- | --- | --- |
| `core` | `core_owner` | No |
| `mod_<short>` | `mod_<short>_owner`, one per module | No |
| `api` | `core_owner` | **Only this schema** is exposed through PostgREST, and only `security_invoker = true` views and `SECURITY INVOKER` functions listed in the migration |

- Browsers and apps talk to `/api/v1` (Next.js) for everything. The `api` schema exists for realtime and for the back-office's read-only lists; in 0001 it contains no views. Supabase's default exposed schemas are reconfigured to `api` only, and a CI test asserts it from the project config.
- `core.has_role(role text)` is `SECURITY DEFINER`, `set search_path = core, pg_temp`, and returns true only when the caller holds the role **and** the JWT carries `aal = 'aal2'`. Every RLS policy on C1+ tables goes through it, so a password-only session reads nothing beyond C0.
- "Staff" means any principal with at least one active `role_assignment`. Citizens never get a Supabase account in P1.
- `app_user.id` equals `auth.users.id` (Supabase-generated UUIDv4). It is the only table whose id is not UUIDv7.

### 4.2 Identifiers and conventions

- Ids are UUIDv7, generated **by the application** (`packages/core-domain` and `workers/core`) so they exist before insert and can bind ciphertext (§4.6). `core.uuid7()` is a SQL fallback default implemented in PL/pgSQL (native `uuidv7()` only arrives in Postgres 18).
- Every table has `created_at timestamptz not null default now()` and `updated_at timestamptz not null default now()` maintained by trigger. Publishable tables also have `deleted_at timestamptz` (soft delete).
- `municipality` is keyed by `ibge_code char(7)`.
- `instance` has exactly one row (`check (id = 1)`). `tenant.yaml` wins: boot overwrites the row from the file.

### 4.3 Tables in 0001

Columns beyond the common ones in §4.2. Class in brackets.

| Table [class] | Columns |
| --- | --- |
| `instance` [C0] | `id smallint pk check (id=1)`, `slug text`, `display_name text`, `house_acronym text`, `uf char(2)`, `config_version text`, `framework_version text` |
| `app_user` [C2] | `id uuid pk` (= `auth.users.id`), `pii_name bytea`, `pii_email bytea`, `bi_email bytea unique`, `status text check in ('active','suspended','removed')` [C1] |
| `role` [C1] | `id text pk` (`<module>.<role>`, framework roles have no module prefix), `label text`, `module_id text null` |
| `permission` [C1] | `id text pk` (`<module>.<permission>`), `label text`, `module_id text null` |
| `role_permission` [C1] | `role_id`, `permission_id`, pk both |
| `role_assignment` [C1] | `id uuid pk`, `user_id uuid fk app_user`, `role_id text fk role`, `granted_by uuid fk app_user`, `granted_at timestamptz`, `revoked_at timestamptz null` |
| `audit_event` [C1] | `id uuid pk`, `at timestamptz`, `actor_kind text check in ('user','worker','migration','system')`, `actor_id text`, `action text`, `entity text`, `entity_id text`, `details jsonb` (ids and field names only, never values) |
| `cause` [C0] | `slug text pk`, `name text`, `icon text`, `sort smallint` |
| `content_item` [C1] | `id uuid pk`, `type text check in ('noticia','nota','artigo','balanco','posicionamento','card_dado','video_link')`, `state text` (§6.1), `current_version int`, `published_version int null`, `published_at timestamptz null`, `author_id uuid`, `approver_id uuid null`, `deleted_at` |
| `content_version` [C1] | `content_id uuid`, `n int`, pk both; `title text`, `summary text`, `body_md text`, `created_by uuid`, `ai_provenance_id uuid null`, `figures jsonb` (each number with `value`, `unit`, `source_id`, `source_url`, `reference_date`) |
| `content_cause` [C1] | `content_id`, `cause_slug`, pk both |
| `media_asset` [C1] | `id uuid pk`, `kind text check in ('image','video_link','document')`, `storage_key text`, `sha256 text`, `bytes int`, `width int`, `height int`, `variants jsonb`, `alt_text text`, `exif_stripped boolean not null check (exif_stripped)`, `deleted_at` |
| `content_media` [C1] | `content_id`, `media_id`, `position smallint`, pk (`content_id`, `media_id`) |
| `agenda_event` [C1] | `id uuid pk`, `starts_at timestamptz`, `ends_at timestamptz`, `title text`, `kind text`, `municipality_ibge char(7) null`, `place text`, `visibility text check in ('public','internal')`, `status text check in ('planned','done','cancelled')`, `deleted_at` |
| `municipality` [C0] | `ibge_code char(7) pk`, `name text`, `uf char(2)`, `health_region text null`, `population int null`, `population_ref_date date null` |
| `data_source` [C0] | `source_id text pk`, `name text`, `terms_url text`, `cadence text`, `last_success_at timestamptz null`, `cursor jsonb null` |
| `data_source_run` [C1] | `id uuid pk`, `source_id text fk`, `started_at`, `finished_at`, `status text`, `stats jsonb`, `error text null` |
| `ai_provenance` [C1] | `id uuid pk`, `task text`, `effective_class text`, `provider_id text`, `model text`, `locality text`, `prompt_ref text` (version id or hash, never prompt text), `input_sha256 text`, `tokens_in int`, `tokens_out int`, `at timestamptz`, `reviewed_by uuid null` |
| `job` [C1] | §7.4 |
| `module_registry` [C1] | `module_id text pk`, `short text unique`, `version text`, `enabled boolean`, `installed_at`, `migrated_to text` |
| `publish_generation` [C1] | `generation bigint pk`, `at timestamptz`, `manifest_sha256 text`, `triggered_by text` |

Column classes inside C1/C2 tables follow §3: `pii_*` C2, `bi_*` C1, everything else C1 unless noted; C0 tables are C0 throughout. Fields of `instance`, `cause`, `municipality` and `data_source` are C0. `content_item`/`content_version`/`media_asset`/`agenda_event` columns are C1 at rest and become publishable only through the publish rule in §6.2.

Tables deliberately **not** in 0001 (they arrive with the module that needs them): `organization`, `user_key`, contacts and consent, denúncias, meetings.

### 4.4 Roles, permissions and RLS

- Framework roles: `parlamentar`, `chefe_gabinete`, `comunicacao`, `operador`. Module roles are namespaced `<module>.<role>`.
- Only holders of `chefe_gabinete` may insert or revoke `role_assignment`, through `core.grant_role()` / `core.revoke_role()` (audited). Nobody can grant a role to themselves.
- RLS is enabled and forced on every table; no policy means no access. CI checks: every table has RLS on; no policy on a C3 table or column grants `operador`; no table outside `api` is readable by `anon`.
- Disabling a module (`module_registry.enabled = false`) removes its routes, screens and jobs at the next build or boot, and its roles stop matching in `has_role`. Assignments and data stay until an explicit, audited purge.

### 4.5 Audit

- `core.audit_event` is append-only: `revoke update, delete, truncate` from every role; insert only through `core.audit()` (`SECURITY DEFINER`, `EXECUTE` revoked from `anon` and `authenticated`).
- Row triggers on C1+ tables write `actor_kind` and `actor_id`. Users come from `auth.uid()`; workers and migrations must `set_config('app.actor', '<kind>:<id>', true)` at the start of each transaction, and the trigger raises if neither is present.
- Audit keeps ids and field names, never values. Retention: 5 years, then archive (to be confirmed with the mandate's legal advisers).

### 4.6 Application-level encryption

- Algorithm: XChaCha20-Poly1305 (libsodium). Envelope stored in `bytea`: `version (1 byte) | key_id (16 bytes) | nonce (24 bytes) | ciphertext`.
- AAD: `<schema>.<table>.<column>:<row id>`. This prevents moving ciphertext between rows; it is why ids are generated by the application.
- Keys: one data key per `<table>.<column>`, wrapped by the instance key-encryption key (KEK). The KEK lives in the instance secret store and is loaded only by the API and worker processes, never by browsers or apps. Rotation: new `key_id` for new writes, background re-encryption job, old key retired when no row references it.
- Lookup and uniqueness use blind indexes: `bi_<col> = HMAC-SHA256(index_key, normalize(value))`, with a separate index key per column. Normalization rules (e-mail lowercase and trim, phone E.164) live in `packages/crypto` and are part of the contract.
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
```

`flags` is not part of v1; feature flags are added when the first one has defined behaviour. `connectors[].source_id` must match an installed connector's manifest (§7.3).

## 6. Content and publishing

### 6.1 Content state machine

`draft → in_review → approved → published`, plus `published → in_review` (new version of published item), `* → archived`, and `published → withdrawn`.

- `approved` requires `approver_id <> author_id`.
- The publish job runs on every transition into or out of `published`, and on `withdrawn`.
- What is published is `content_version` number `published_version`, never the current draft.

### 6.2 Publish rule

`core-publish` serializes only **rows** in a publishable state (`published`, `visibility = 'public'`, `deleted_at is null`) and only **columns** in its allow-list per entity, which CI checks against the column classes (no `pii_`, `phi_`, `piim_`, `enc_`, `bi_`, no `author_id`/`approver_id`). Module `PublishTarget`s return records through the same serializer and never raw files; their bundle names are prefixed with the module short name.

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

- **Partitions are stable**: content and agenda by month of `published_at`/`starts_at` (`content-YYYY-MM`, `agenda-YYYY-MM`); `causes`, `institutional`, `municipalities` single; indicators one per `source_id`. A new item changes one partition, not every page.
- **Bundle URLs are content-addressed and immutable** (`b/<sha256>.json`, cached forever). Only `manifest.json` is mutable (short cache, ETag).
- Each bundle is the **full snapshot** of its partition. A record absent from a partition no longer exists there.
- `takedowns[]` keeps the last 365 days of withdrawals so a device can purge a record even before it refetches that partition. `min_generation` is raised whenever a partition is removed entirely.
- Unknown fields are ignored by clients. A breaking bundle change raises `schema_version` and `min_app_version`.

Client algorithm (citizen app):
1. Fetch `manifest.json` with `If-None-Match`. On 304, stop.
2. If `min_app_version` is above the app version, keep showing cached data and show the update banner.
3. If the stored generation is below `min_generation`, drop all cached partitions.
4. Apply `takedowns[]`: delete those ids locally.
5. For each bundle whose `sha256` differs from the stored one: download, verify the hash, replace the partition in SQLite in one transaction.
6. Delete local partitions that are not in the manifest. Store `generation`.

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

Boot (API and workers): validate `tenant.yaml` → load generated registry → `mandato migrate` applies core migrations, then module migrations in dependency order, each under its `mod_<short>_owner` role, forward-only, recorded in `module_registry.migrated_to` → sync `instance`, `cause`, `role`, `permission` rows from config and manifests → start. Any failure stops boot.

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

`core.job` columns: `id uuid pk`, `queue text` (`<short>.<name>`), `data_class text`, `idempotency_key text unique null`, `payload jsonb`, `state text check in ('queued','running','done','failed','dead')`, `attempts smallint`, `max_attempts smallint default 5`, `run_after timestamptz`, `locked_by text null`, `locked_at timestamptz null`, `last_error text null`. Workers take jobs with `select … for update skip locked`.

Payloads carry **references** (ids, storage keys), never C2/C3 plaintext. A CI test rejects payload schemas with `pii_`/`phi_`/`piim_` property names.

```python
class JobContext(Protocol):
    job_id: UUID; data_class: DataClass; actor: str      # "worker:<queue>"
    def tx(self) -> ContextManager[Tx]: ...               # sets app.actor
    def ai(self) -> AiGateway: ...                        # the only way to reach AiProvider
    def secret(self, ref: str) -> str: ...

class Job(Protocol):
    queue: str; data_class: DataClass; concurrency: int
    def run(self, payload: dict, ctx: JobContext) -> JobResult: ...
```

`ContentEnricher.onSave` (TypeScript) returns a `JobRequest { queue, payload, idempotency_key, data_class }` or `null`; the API inserts it into `core.job`.

### 7.5 AI gateway (Python, `workers/core/contracts/ai.py`)

```python
class DataClass(IntEnum): C0 = 0; C1 = 1; C2 = 2; C3 = 3

class Part(TypedDict):
    kind: Literal["text", "image_ref", "audio_ref"]; content: str
    data_class: DataClass      # set by the framework loader from column classes; unknown = C3

class AiProvider(Protocol):
    id: str; locality: Literal["local", "external"]; max_data_class: DataClass
    def generate(self, task: str, parts: list[Part], output_schema: dict) -> AiResult: ...

class ProviderRouter(Protocol):
    def route(self, task: str, effective_class: DataClass) -> AiProvider | None: ...

class AiGateway:  # framework-owned, not an extension point
    def generate(self, task: str, parts: list[Part], output_schema: dict) -> AiResult: ...
```

- `task` is `<module short>.<task>`.
- The gateway computes `effective_class = max(job class, every part's class)`, asks the configured `ProviderRouter`, and **refuses before any network call** when the router returns nothing, when `effective_class > provider.max_data_class`, or when `effective_class == C3` and `provider.locality != "local"`.
- The framework ships `NoneRouter` (always nothing), `NoneProvider` and `EchoProvider` (deterministic, local, for CI and the demo; contains no prompts). Real routers, providers and prompts live in closed modules and are listed in the module's `worker.providers`.
- Every call that reaches a provider writes `core.ai_provenance` with `prompt_ref` and `input_sha256`, never prompt or input text.
- `AiResult`: `{ output: dict, provider_id, model, tokens_in, tokens_out, provenance_id }`.

### 7.6 Web and mobile (TypeScript, `packages/core-contracts/src`)

```ts
export type RoleId = string;                 // e.g. 'chefe_gabinete', 'demo.hello.viewer'
export interface Route { path: string; permission?: string; load: () => Promise<{ default: React.ComponentType }> }
export interface Screen { id: string; variant: 'citizen' | 'gabinete'; permission?: string; load: () => Promise<{ default: React.ComponentType }> }
export interface PublishContext { generation: number; serialize: (entity: string, rows: unknown[]) => PublishedRecord[] }
export interface PublishTarget { id: string; bundles: (ctx: PublishContext) => Promise<{ name: string; records: PublishedRecord[] }[]> }
export interface ContentEnricher { id: string; onSave: (ref: { contentId: string; version: number }) => JobRequest | null }
export interface PublishedRecord { id: string; updated_at: string; [field: string]: unknown }
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
- Public writes (contact, report, request forms) need no JWT. They require `Idempotency-Key` (UUID, scoped to endpoint, kept 24 h as a hash, replay returns the first response, a different body returns 409) and pass rate limiting keyed by an HMAC of the client IP with a daily-rotated key; raw IPs are never stored.
- Errors: RFC 9457 `application/problem+json`; `type` as `urn:mandato:error:<code>`; pt-BR `title`; field errors in `errors[] { field, code, message }`; never echo personal data.
- Pagination: cursor over `(sort key, id)`, opaque base64; `?cursor=&limit=` (max 100); response `{ data, next_cursor }`.
- Dates: instants ISO 8601 with offset; dates `YYYY-MM-DD`; periods `{ start, end }` inclusive dates. Money in integer centavos with `currency: "BRL"`. Municipalities by IBGE code.

## 10. Review findings and how v2 answers them

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

Minor items were applied in place (`settings_schema`, list form of `modules`, `cause` naming, one home for cause icons, `labels.ai_assisted`, figures on all numbers, contrast in both modes, SQL `uuid7()`, IBGE key, single `instance` row, secret refs, `flags` removed, `demo.hello` example, `Screen.tab` removed).

## 11. Definition of done for E0.0 and change control

Artifacts, all in this repository:
- `packages/core-config/schema/tenant.schema.json`, `packages/core-theme/schema/tokens.schema.json`, `packages/core-publish/schema/bundle.schema.json`, `packages/core-contracts/schema/module.schema.json`, `schema/job.schema.json`.
- `packages/db/migrations/0001_core.sql` with RLS policies, comments and the CI checks in §3, §4.4.
- `packages/core-contracts/src/*.ts` and `workers/core/contracts/*.py` as in §7, compiling, with no implementation beyond `NoneRouter`, `NoneProvider` and `EchoProvider`.
- `docs/api-conventions.md` (§9).
- Fixtures in `tenants/demo/`: valid `tenant.yaml`, neutral `theme/tokens.json`, seed with 4 staff users (one per framework role), 6 content items covering every state, 4 agenda events, 3 municipalities; a published `manifest.json` with two partitions, one takedown and one tombstoned record; `demo.hello` module with a route, a screen and a job. Synthetic data only.
- Negative fixtures that CI must reject: a `tenant.yaml` with an unknown key, a token set failing contrast, a migration with an unclassified column, a publish attempt including a `pii_` column.

Done when CI passes on those artifacts and someone other than the executor verifies them against this document. The `tenants/demo/` fixtures belong to the backbone.

Contracts are versioned `0.x` until launch. After freeze, a change goes through a backbone decision recorded in this file's history, bumps the contract's version, and updates fixtures in the same PR.

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
