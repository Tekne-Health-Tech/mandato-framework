# Design 0001 — Core contracts (backlog E0.0)

Status: draft for Elephant-Goldfish review · 2026-11-14 · Owner: architecture backbone

## 1. Problem

Eleven work lanes (web shell, mobile shell, database, auth, content, publish, theme, connectors, workers, demo tenant, closed modules) will be executed in parallel by different agents. Without frozen interfaces, each lane invents its own shapes and the integration cost lands on the critical path. This design fixes six contracts before any lane starts, each with synthetic example data so lanes can work against mocks.

## 2. Constraints (from accepted decisions)

- **One instance per mandate** (ADR-0002): one database per mandate, no `tenant_id` column. Instance identity comes from `tenant.yaml` and a single `instance` row.
- **Stack** (ADR-0003): Expo/React Native (citizen and gabinete variants), Next.js (back-office, public web, API route handlers), Supabase Postgres in `sa-east-1`, Python workers, Postgres-backed queue.
- **Data classes** (ADR-0004): C0 public, C1 internal, C2 personal, C3 sensitive. Column prefixes `pii_`, `phi_`, `piim_`, `enc_`. C3 never reaches an external AI provider.
- **Open core** (ADR-0012): this repository is public AGPL. It must never import closed modules or mandate config. Closed modules plug in only through the extension points defined here. If a closed module needs a new hook, the hook is added here first.
- **Read path is static**: published content becomes versioned JSON bundles on a CDN; the citizen app syncs deltas and works offline on 3G.
- Every number shown to citizens carries source and reference date; every AI-assisted text carries a disclosure label.

## 3. Decisions

### 3.1 Language split of the extension points

The planning docs list all extension points under `packages/core-contracts/src/*.ts`. That is wrong for half of them: ingestion, transcription and AI generation run in Python workers.

| Extension point | Runtime | Contract location |
| --- | --- | --- |
| `registerModule` (manifest) | Language-neutral | `packages/core-contracts/schema/module.schema.json` + TS types generated from it + Python model generated from it |
| `Route`, `Screen` | TypeScript | `packages/core-contracts/src/ui.ts` |
| `PublishTarget` | TypeScript | `packages/core-contracts/src/publish.ts` |
| `ContentEnricher` | Split: TS hook enqueues a job; Python job does the work | `src/content.ts` + `workers/core/contracts/enricher.py` |
| `Connector` | Python | `workers/core/contracts/connector.py` |
| `Job` | Python (enqueued from either side) | `workers/core/contracts/job.py` + `schema/job.schema.json` for the payload envelope |
| `AiProvider` | Python | `workers/core/contracts/ai.py` |

Rule: **all AI calls happen in workers**. The web app only enqueues jobs. This keeps one place where the data-class guard runs.

### 3.2 `tenant.yaml` schema

File: `packages/core-config/schema/tenant.schema.json` (JSON Schema 2020-12). Unknown keys are rejected everywhere except inside `modules.<id>.settings`, which is validated by that module's own `settingsSchema`.

```yaml
schema_version: 1
instance:
  slug: demo                      # [a-z0-9-], used in hostnames and bucket names
  display_name: "Mandato Dep. Exemplo"
  house: { name: "Assembleia Legislativa do Estado Exemplo", acronym: "ALEX", uf: "EX" }
  office: deputado_estadual        # enum: deputado_estadual | deputado_federal | senador | vereador
parliamentarian:
  public_name: "Dep. Exemplo"
  pronoun_style: neutral           # neutral | feminine | masculine (UI copy only)
locale: pt-BR
timezone: America/Fortaleza
causes:                            # drives `theme` rows and icons; colors never encode causes
  - { slug: saude, name: "Saúde", icon: stethoscope }
theme: theme/tokens.json           # path inside the mandate config repo; validated by tokens.schema.json
legal:
  privacy_policy_url: https://example.org/privacidade
  data_controller: "Gabinete do Dep. Exemplo"
  dpo: { name: "Encarregado Exemplo", email: dpo@example.org }
channels:                          # ADR-0006: no WhatsApp Business API
  email: contato@example.org
  telegram_channel: null
  whatsapp_channel_url: null       # manual WhatsApp Channel link only
connectors:
  - { id: ibge-municipios, package: core.connectors.ibge, schedule: "0 6 1 * *", params: { uf: EX } }
modules:
  - { id: core.content, enabled: true }
  - { id: core.agenda, enabled: true }
flags: { electoral_restricted_mode: false }
```

Validation runs in CI of the mandate config repo and at instance boot; boot refuses to start on an invalid file.

### 3.3 Core SQL (`packages/db/migrations/0001_core.sql`)

- **Schemas:** framework tables live in schema `core`. Each module gets its own schema `mod_<module_id>` and may only reference `core` tables through foreign keys to `id` columns and the views in `core_api`. This prevents name collisions between independently written modules.
- **Tables in 0001:** `instance`, `app_user`, `role`, `role_assignment`, `user_key`, `audit_event`, `content_item`, `content_version`, `cause`, `media_asset`, `agenda_event`, `municipality`, `organization`, `ai_provenance`, `data_source`, `data_source_run`, `module_registry`. Columns as in the platform data model (03), with `theme` renamed `cause` to avoid clashing with the visual theme.
- **Roles are data:** `core.role` holds role ids. The framework seeds `parlamentar`, `chefe_gabinete`, `comunicacao`, `operador`. Modules add their roles (e.g. `triagem`, `encarregado`) through their manifest. `role_assignment.role` references `core.role`.
- **Classification is enforced:** every table and every `pii_`/`phi_`/`piim_`/`enc_` column has a `COMMENT ... IS 'class=Cn'`. A CI test fails if any table in `core` or `mod_*` lacks a class, or if a `pii_`/`phi_`/`piim_` column sits in a table classed below C2.
- **RLS:** enabled on every table, deny by default. Helper `core.has_role(text) returns boolean` reads `role_assignment` for `auth.uid()`. Policies are written per table in the migration that creates it. The `operador` role has no `select` on C3 tables.
- **Audit:** `core.audit_event` is append-only (`revoke update, delete`; insert only through `core.audit()` security-definer function). Row triggers on C1+ tables write `action`, `entity`, `entity_id`, `actor_id`; never content.
- **Ids:** UUIDv7 generated in the database (`core.uuid7()`), so ordering by id approximates creation time.
- **Encryption:** C2 `pii_` columns and C3 `enc_` columns hold ciphertext produced by the application (`packages/crypto`); the database never sees the keys.

### 3.4 Extension interfaces

Module manifest (language-neutral, validated at boot):

```json
{
  "id": "pro.secretaria",
  "version": "0.1.0",
  "requires_framework": "^0.1",
  "data_classes": ["C1", "C2"],
  "roles": [{ "id": "secretaria", "label": "Secretaria" }],
  "permissions": [{ "id": "minutes.approve", "roles": ["chefe_gabinete"] }],
  "migrations": "migrations/",
  "routes": ["web/routes.ts"],
  "screens": ["mobile/screens.ts"],
  "jobs": ["workers/jobs.py"],
  "settings_schema": "settings.schema.json"
}
```

TypeScript (sketch):

```ts
export interface Route { path: string; roles: RoleId[]; load: () => Promise<RouteModule> }
export interface Screen { id: string; variant: 'citizen' | 'gabinete'; tab?: TabSlot; roles?: RoleId[]; load: () => Promise<ScreenModule> }
export interface PublishTarget { id: string; dependsOn: EntityKind[]; build(ctx: PublishContext): Promise<Bundle[]> }
export interface ContentEnricher { id: string; onSave(item: ContentVersionRef): JobRequest | null }
```

Python (sketch):

```python
class Connector(Protocol):
    manifest: ConnectorManifest          # source_id, terms_url, robots, auth, rate_limit, cadence, data_class, automation
    def discover(self) -> list[Resource]: ...
    def fetch(self, resource: Resource, since: datetime | None) -> RawBatch: ...
    def normalize(self, raw: RawBatch) -> list[Record]: ...
    def validate(self, records: list[Record]) -> ValidationReport: ...
    def upsert(self, records: list[Record], tx: Tx) -> UpsertStats: ...

class Job(Protocol):
    queue: str; data_class: DataClass; concurrency: int
    def run(self, payload: dict, ctx: JobContext) -> JobResult: ...

class AiProvider(Protocol):
    id: str
    max_data_class: DataClass             # highest class this provider may receive
    def generate(self, task: str, inputs: list[Part], output_schema: dict) -> AiResult: ...
```

**Fail-closed guard (framework):** `ai.generate(task, inputs, data_class, schema)` refuses before any network call when `data_class > provider.max_data_class`, when `data_class == C3` and the provider is not local, or when no provider is configured. The framework ships only `NoneProvider` (always refuses) and the guard; routing tables, prompts and real providers live in closed modules. Every successful call writes `core.ai_provenance`.

### 3.5 Design tokens (`packages/core-theme/schema/tokens.schema.json`)

- Color roles: `brand`, `brand-on`, `accent`, `link`, `cta`, `cta-on`, `bg`, `surface`, `fg`, `muted`, `line`, `success`, `warning`, `error`, `info`; each in `light` and `dark`.
- Typography: `display` (at most one downloaded font), `body` (system stack allowed), size scale.
- `radius`, `spacing` scales; `icons.causes` maps cause slugs to icon names.
- **Contrast is part of the contract:** the schema lists required pairs (`fg/bg`, `fg/surface`, `brand-on/brand`, `cta-on/cta`, `link/bg`, `muted/bg`) and the checker fails below WCAG AA (4.5:1 text, 3:1 large text and UI). The framework ships a neutral default theme that passes.

### 3.6 Published bundles (`packages/core-publish/schema/bundle.schema.json`)

- One `manifest.json` per instance on the CDN: `schema_version`, `instance.slug`, `generated_at`, and `bundles[]` with `name`, `url`, `sha256`, `count`, `updated_at`.
- Bundle names: `content-<page>.json` (newest first, 100 items per page), `agenda.json`, `causes.json`, `indicators-<source_id>.json`, `institutional.json`.
- Every record has `id`, `updated_at`, `deleted` (tombstones kept 90 days for delta sync). Indicator values carry `source_id`, `source_url`, `reference_date`. AI-assisted content carries `ai_label: true` and the label text comes from the instance config.
- The app fetches `manifest.json` with ETag, downloads only bundles whose `sha256` changed, verifies the hash and writes to SQLite. Bundles hold C0 data only; `core-publish` refuses to serialize any column not classed C0.

### 3.7 API conventions (`docs/api-conventions.md`)

- REST + JSON under `/api/v1`; breaking changes go to `/api/v2`, old version kept for one app release cycle.
- Auth: Supabase JWT as `Authorization: Bearer`; staff sessions require a second factor claim (`aal2`).
- Errors: RFC 9457 `application/problem+json` with a stable `type` URI and a pt-BR `title`; never echo personal data in errors.
- Pagination: cursor-based (`?cursor=&limit=`, max 100), response `{ data, next_cursor }`.
- Writes from the public (contact, denúncia, emenda request) require `Idempotency-Key` and pass rate limiting.
- Dates ISO 8601 with offset; money in integer centavos with `currency: "BRL"`; municipality by IBGE code.

## 4. Synthetic examples shipped with the contracts

`tenants/demo/`: a valid `tenant.yaml` for "Dep. Exemplo" in the fictitious state "EX"; `theme/tokens.json` neutral theme; seed SQL with 3 users (one per role), 5 content items in different states, 4 agenda events, 3 municipalities; one published `manifest.json` with two bundles; one connector manifest; one module manifest (`demo.hello`) that registers a route, a screen and a job. No real names, documents or contacts.

## 5. Out of scope

Pro-module schemas (secretaria, captura, denúncias), the AI routing table and prompts, state connectors, and the gabinete app screens. They are designed later against these contracts.

## 6. Open questions for review

1. Is per-module Postgres schema (`mod_<id>`) worth the friction with Supabase's API exposure, versus prefixed tables in one schema?
2. Should `Connector` also exist in TypeScript for lightweight federal APIs, or is Python-only acceptable?
3. Is the 90-day tombstone window enough for citizens who open the app rarely, or should the app fall back to a full resync when its last sync is older than the window?
4. Is the fail-closed guard enough without also classifying each `Part` of the input individually?
