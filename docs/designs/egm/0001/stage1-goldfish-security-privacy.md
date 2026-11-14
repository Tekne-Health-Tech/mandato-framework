# Stage 1 — Goldfish review: security & privacy

Reviewed: `docs/designs/0001-core-contracts.md` (draft 2026-11-14), against `AGENTS.md`.
Lens: security, privacy, LGPD. Reviewer context: only those two files. Anything the doc does not state is treated as a gap.

## Summary

The design has the right ideas: deny-by-default RLS, an append-only audit table, application-side encryption, a fail-closed AI guard and a C0-only publish guard. The problem is that most of these controls sit where they can be bypassed, or depend on labels that nobody checks:

- **Enforcement sits in the wrong layer.** Second-factor checks (`aal2`) and rate limiting live only in the Next.js API (§3.7). Supabase also exposes the database directly through its REST/RPC endpoint (PostgREST) with the same JWT. The doc never says the database checks `aal2`, which schemas are exposed, or what the `anon` role can do (SEC-1).
- **The AI guard trusts a label the caller supplies.** `data_class` is an argument to `ai.generate` (§3.4). Nothing derives it from the data or checks it. Provider `max_data_class` and "local" are also declared by closed-module code. So the C3 rule from ADR-0004 rests on the honesty of the caller (SEC-2).
- **Classification only covers prefixed columns.** The publish guard needs a class on every column, but the CI test only requires one on tables and prefixed columns. `PublishTarget.build` also returns arbitrary `Bundle[]`, not columns (SEC-3).
- **The audit design can be forged and has no retention rule.** `core.audit()` is a security-definer function that may be callable over RPC. Superusers can still change the table, and the doc does not say how an append-only log with `actor_id`/`entity_id` meets LGPD art. 18 deletion and art. 16 retention limits (SEC-4, SEC-6).
- **Encryption has no key design.** There is no key hierarchy, rotation, blind-index or uniqueness strategy, and no binding of ciphertext to its row. `phi_` and `piim_` columns (health data, minors) are not covered by the encryption rule at all (SEC-5).
- **LGPD data-subject rights and retention are absent from the contracts**, as are international-transfer limits for AI providers (SEC-6). They have to be designed in now, because `audit_event`, `user_key`, the tombstones and `ai_provenance` all get frozen here.

I found 2 blockers, 6 majors and 2 minors. None of the findings require secrets, prompts or real data in the public repo. SEC-10 points out one schema slot (connector `auth`/`params`) that could pull secrets into a config repo unless the schema forbids it.

## Findings

| ID | Severity | Confidence | Section | Claim |
| --- | --- | --- | --- | --- |
| SEC-1 | blocker | high | §3.3 RLS, §3.7 Auth/rate limiting | `aal2` and rate limiting are API-only, but Supabase exposes tables and RPC to the same JWT, so both can be bypassed unless the database enforces them and exposure is restricted. |
| SEC-2 | blocker | high | §3.4 fail-closed guard, §6 Q4 | The AI guard trusts a caller-supplied `data_class` and provider-declared `max_data_class`/"local", so mislabelled C3 data reaches an external provider with no error. |
| SEC-3 | major | high | §3.3 Classification, §3.6 publish guard | Class comments are required only on tables and prefixed columns, and `PublishTarget.build` returns free-form bundles, so the "C0-only" publish guard has nothing reliable to check. |
| SEC-4 | major | high | §3.3 Audit | `core.audit()` as a security-definer function can be called over RPC to forge entries. "Revoke update, delete" does not bind the owner or `service_role`, and C3 reads are not audited. |
| SEC-5 | major | high | §3.3 Encryption, `user_key` | Application-side encryption has no key hierarchy, rotation, AAD binding or blind-index design (which breaks lookup and uniqueness), and `phi_`/`piim_` columns are not covered. |
| SEC-6 | major | high | §3.3 Audit, §3.6 tombstones, §3.4 `ai_provenance` | No contract for LGPD art. 18 rights, retention (art. 16) or international transfer (art. 33). An append-only audit with FK identifiers and 90-day tombstones conflicts with deletion unless this is designed now. |
| SEC-7 | major | medium | §3.3 RLS / roles, §3.4 manifest | The `operador`/C3 rule and role assignment are convention only. Nothing stops a module manifest or policy from granting C3 to `operador`, and nobody is said to control writes to `role_assignment`. |
| SEC-8 | major | medium | §3.7 public writes (denúncia) | Rate limiting and `Idempotency-Key` storage for anonymous denúncias will create IP- and key-linked records that can de-anonymise reporters. Retention and hashing of those records are unspecified. |
| SEC-9 | minor | medium | §3.1, §3.4 `Job`, §3.7 Errors | The "no PII" rule covers only error bodies. Job payloads in the Postgres queue, logs and traces can hold C2/C3 plaintext. |
| SEC-10 | minor | medium | §3.2 `connectors[].params`, §3.4 Connector `auth` | The config schema has no secret-by-reference rule, so connector credentials are likely to be committed in YAML. |

## Detailed findings

### SEC-1 — Database-direct access bypasses `aal2` and rate limiting (blocker, high)

**Where:** §3.3 "RLS" (line 79), §3.7 "Auth" (line 153), "Writes from the public… pass rate limiting" (line 156), §6 Q1 (line 169).

**Problem:** The design says staff sessions require `aal2` and public writes are rate-limited, but only as API conventions for `/api/v1` route handlers. Supabase also serves every exposed schema through its REST and RPC endpoint (PostgREST) to anyone who holds the public anon key and a user JWT. The doc does not say:
- whether `core.has_role()` or the RLS policies check `auth.jwt()->>'aal'`;
- which schemas are exposed to the REST endpoint (`core`? `mod_*`? only `core_api`?);
- what the `anon` and `authenticated` Postgres roles are granted.

`Route.roles` and `Screen.roles` (§3.4) are UI routing hints, and the doc does not say they are not an authorization layer.

**Failure scenarios:**
1. A staff password is phished. The attacker signs in at `aal1` and calls Supabase REST directly. The policies call `has_role('chefe_gabinete')`, which returns true, so the attacker reads C2 data without a second factor.
2. A spammer sends 10,000 inserts per minute straight to the denúncia table through REST using the anon key. The Next.js rate limiter never sees them.

**Recommendation:** Add to §3.3/§3.7:
- `core.has_role(role)` returns true only when `auth.jwt()->>'aal' = 'aal2'` for staff roles. A separate helper covers citizen self-access.
- Expose only `core_api` (views with `security_invoker = true`) through the REST endpoint. Do not expose `core` and `mod_*`.
- `anon` has no table grants. Public writes go only through route handlers that call security-definer functions with fixed `search_path`, and those functions do the rate-limit bookkeeping (see SEC-8).
- State explicitly that `Route.roles`/`Screen.roles` are presentation only.
- Add a CI test that lists the grants for `anon`/`authenticated` and fails on anything not on an allowlist.

### SEC-2 — The AI guard trusts a caller-supplied `data_class` (blocker, high)

**Where:** §3.4 `AiProvider` and "Fail-closed guard" (lines 128–134), §2 "C3 never reaches an external AI provider" (line 13), §6 Q4.

**Problem:** `ai.generate(task, inputs, data_class, schema)` compares a caller-supplied `data_class` with `provider.max_data_class`. Four gaps follow:
1. **The label is not checked.** Nothing ties `data_class` to the data in `inputs`. A closed-module job, or a bug, can pass `C1` with text decrypted from an `enc_` column.
2. **The provider describes itself.** `max_data_class` and "is local" are attributes of a provider object that closed modules implement. The doc does not define "local" (same host? same VPC? `sa-east-1`?).
3. **The guard can be skipped.** `AiProvider.generate` has no `data_class` parameter and is a public method on the provider. Nothing prevents a module from calling `provider.generate(...)` directly and skipping `ai.generate`.
4. **The job label is not linked to the call.** `Job.data_class` is not connected to the class passed to `ai.generate`.

**Failure scenario:** A closed "summarise citizen message" job runs with `data_class=C1` because its author thought of the summary as internal. The input is a decrypted `enc_` field describing a health condition, which is C3. The guard passes and the C3 text goes to an external provider. `ai_provenance` records the call as C1, so the audit trail also misstates what happened.

**Recommendation:**
- Make the guard compute the class from the data. Each `Part` carries a `data_class`, set by the framework at the point of origin (the DB read helper reads the column class comment, and `packages/crypto` decrypt tags its output at least C2/C3 according to the prefix). The effective class is `max(part.data_class)`. A caller value is allowed only to *raise* it, and a `Part` without a class is treated as C3.
- `ai.generate` asserts `effective_class <= job.data_class`, so a job cannot exceed its declared ceiling.
- Providers are registered with the framework, never called directly. The registry wraps `generate` so that only the guard reaches the network. A CI or import-lint rule forbids calling `provider.generate` outside `workers/core`.
- "Local" becomes an operator-set property in instance config (not provider code), for example `ai.providers.<id>.locality: in_instance | in_country | external`. The C3 rule then reads "C3 only if `locality == in_instance`".
- `ai_provenance` records the computed class, the provider id and the locality, never input text (see SEC-6).

### SEC-3 — Classification does not cover what the publish guard needs (major, high)

**Where:** §3.3 "Classification is enforced" (line 78), §3.6 "core-publish refuses to serialize any column not classed C0" (line 148), §3.4 `PublishTarget.build(ctx) -> Bundle[]`.

**Problem:**
- The CI test requires a class comment only on tables and on `pii_`/`phi_`/`piim_`/`enc_` columns. An unprefixed column (`name`, `email`, `notes`, a `jsonb` `metadata`) has no class of its own, and the doc does not say whether it inherits the table class.
- The publish guard works on "columns". But `PublishTarget.build` is extension code that returns arbitrary `Bundle[]`, so the framework cannot see which column each output field came from.
- Media (`media_asset`) can carry EXIF GPS or author metadata, and the doc does not say whether that is removed before publishing.

**Failure scenario:** A module adds `contact_email text` with no prefix to a C0-classed table, or puts a requester's name in the `jsonb` body of a content version. CI passes because the column has no prefix. A `PublishTarget` serialises the row, the "column guard" has nothing to check, and the personal data goes to the CDN, where offline clients copy it into SQLite and it cannot be recalled (see Q3).

**Recommendation:**
- Require a class comment on **every column** in `core` and `mod_*`, with no inheritance. The CI test fails on any column without one.
- Add a heuristic lint (column names like `*email*`, `*cpf*`, `*phone*`, `*nome*`) that requires a prefix or an explicit waiver.
- Enforce the publish guard in the database. The publisher runs as a dedicated Postgres role whose column-level `GRANT SELECT` is generated from the class comments (C0 only). `PublishContext` gives `PublishTarget` only that connection, so a `build` that reads a non-C0 column fails at query time.
- Validate bundle output against `bundle.schema.json` with `additionalProperties: false`.
- Strip media metadata in the publish pipeline.

### SEC-4 — The audit can be forged and is not tamper-evident (major, high)

**Where:** §3.3 "Audit" (line 80).

**Problems:**
1. **Forgery over RPC.** `core.audit()` is security-definer. If its schema is exposed or `EXECUTE` is not revoked from `public`/`anon`/`authenticated` (Postgres grants `EXECUTE` to `PUBLIC` by default), any user can call it over RPC. If it takes `actor_id` as a parameter, the forged entries can name someone else.
2. **Privileged roles can still change rows.** `revoke update, delete` does not bind the table owner, the migration role or `service_role`, which bypasses RLS. A compromised worker key, which needs `service_role`-like access to decrypt and process, can rewrite history.
3. **No read audit.** Triggers fire only on writes, but for C3 data the question that matters is who *read* it.
4. **Unchecked module definers.** Module migrations (closed code) can create their own security-definer functions or `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, and nothing checks for this.

**Failure scenario:** An insider with an `authenticated` session calls `/rpc/audit` with a fake `actor_id` to cover their tracks or blame a colleague. Separately, a leaked worker credential issues `DELETE FROM core.audit_event WHERE actor_id = …`.

**Recommendation:**
- `core.audit()` takes no actor parameter. It reads `auth.uid()` (or a `request.jwt` claim, or a worker identity set through `SET LOCAL`) and is created with `SET search_path = pg_catalog, core`.
- `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`. Only trigger functions, owned by a dedicated `audit_writer` role, may call it.
- `audit_event` is owned by a role nobody logs in as. Workers use a dedicated role, not `service_role`.
- Add a hash chain (`prev_hash`, `hash`) or ship to external write-once storage, so tampering can at least be detected.
- Add a read-audit path for C3. The C3 read API goes through security-definer functions or `core_api` views that call `core.audit('read', …)`.
- Extend the CI classification test: every table in `core`/`mod_*` has RLS enabled and forced, every C1+ table has the audit trigger, and every security-definer function sets `search_path` and appears on a reviewed allowlist.

### SEC-5 — Application-side encryption has no key or query design (major, high)

**Where:** §3.3 "Encryption" (line 82), `user_key` table (line 76), §2 prefixes (line 13).

**Problems:**
- The rule covers only "C2 `pii_` columns and C3 `enc_` columns". `phi_` (health, which is sensitive under LGPD art. 5 II) and `piim_` (minors, art. 14) are not mentioned, so a lane may store them in plaintext.
- `user_key` appears with no stated purpose. It could be per-user data keys, per-subject keys for crypto-shredding, or end-user public keys.
- Undefined: where the key-encryption key lives (a KMS? environment variables of the Next.js and worker processes?), which processes hold it, how keys rotate and how old ciphertext is re-encrypted.
- With randomised encryption, the design breaks **equality lookup** ("does this citizen's e-mail already exist?"), **unique constraints**, **deduplication across connectors**, and **any RLS predicate on a `pii_` value** (for example "citizen can read rows where `pii_email` = their e-mail").
- Without AAD (associated data such as table, column and row id), an attacker with database write access can swap ciphertexts between rows. Each copied value then decrypts as valid data on the wrong record.

**Failure scenario:** The contact lane builds "find citizen by e-mail" by decrypting every row in the app, or quietly switches to deterministic encryption with no key separation. The dedup lane meanwhile adds a plaintext `email_normalized` column "for uniqueness", which defeats the encryption, and the CI test passes because the name has no `pii_` prefix.

**Recommendation:** Freeze the following in the `packages/crypto` contract:
- Envelope encryption: a KEK in a KMS outside the database, and DEKs per class, or per data subject if crypto-shredding is wanted (see SEC-6).
- An algorithm and ciphertext format that carries a key version.
- AAD = `table|column|row_id`.
- Searchable fields get a companion `pii_<name>_bidx` column holding a keyed HMAC under a separate key. Uniqueness and lookups use the blind index. Name the residual risk: equality is leaked.
- State that RLS never predicates on encrypted values. Ownership goes through `app_user.id`.
- Extend the encryption rule to `phi_` and `piim_`, and have CI check the prefix-to-class-to-encrypted mapping.
- Define `user_key`.
- State which runtimes may hold which keys. For example, the web runtime holds C2 keys only and C3 decryption happens only in workers.

### SEC-6 — LGPD rights, retention and transfer are not in the contracts (major, high)

**Where:** §3.3 Audit (line 80), `app_user`/`user_key` (line 76), §3.6 tombstones (line 147), §3.4 `ai_provenance` (line 134), §3.2 `legal` (lines 55–58).

**Problem:** The contracts freeze several stores of personal data, but nothing defines retention, legal basis or how data-subject rights (LGPD art. 18) are carried out. These rights are confirmation of processing, access, correction, anonymisation/blocking/deletion, portability, information about sharing, and revocation of consent.

Specific conflicts:
- **Audit.** `audit_event.actor_id`/`entity_id` are personal data, because they link to `app_user` and citizen records. An FK either blocks deletion of the subject or cascade-deletes the audit trail, and an append-only design cannot do either cleanly.
- **Tombstones.** These are the only deletion signal to offline clients, and they expire after 90 days (see Q3). CDN caches and old `manifest.json` versions may keep deleted bundles.
- **AI provenance.** `ai_provenance` contents are not specified. If it stores inputs or outputs, it copies C2/C3 data outside the encrypted columns.
- **Transfer abroad.** The guard does not consider international transfer (art. 33). Supabase is pinned to `sa-east-1`, but an external AI provider may process C1/C2 data abroad, and the guard allows that as long as the class is within `max_data_class`.

**Failure scenario:** A citizen asks for deletion. The team deletes the `app_user` row. The FK from `audit_event` either fails the delete or, with `ON DELETE CASCADE`, wipes the audit trail. The citizen's name in a previously published note stays on rarely-synced devices forever, and copies stay in `ai_provenance`.

**Recommendation:** Add a §3.x "Personal data lifecycle" to the contracts:
- `audit_event` stores `actor_id`/`entity_id` with **no FK**. Subjects are anonymised by crypto-shredding their per-subject key, or by replacing ids with a keyed pseudonym whose key can be destroyed. Retention is set per class (for example C1+ audit kept N years, then purged by a framework job that is itself audited). The purge is the only allowed delete path, run by a dedicated role.
- Every C2+ table declares `retention` and `legal_basis` (in the class comment or a registry table), and CI checks that they are present.
- A framework `Job` contract `dsr.export(subject)` / `dsr.erase(subject)`. Each module must implement a hook for its own schema, and the manifest must declare it whenever `data_classes` includes C2/C3.
- `ai_provenance` stores task id, provider id, locality, computed class, input hash and timestamp, never content.
- The provider config declares a region and transfer basis, and the guard refuses C2+ to a provider without a declared transfer basis.
- Answer Q3 as below. Add a CDN purge on tombstone.

### SEC-7 — The `operador`/C3 rule and role assignment are convention only (major, medium)

**Where:** §3.3 "Roles are data" (line 77), "RLS… `operador` has no `select` on C3 tables" (line 79), §3.4 manifest `roles`/`permissions` (lines 94–95).

**Problem:**
- "Policies are written per table in the migration that creates it" means every module author has to remember the `operador` exclusion. There is no central check, and no definition of which roles *may* see C3.
- Manifests can declare `permissions` with any role list. The doc does not say a manifest cannot grant `operador` a C3 permission, or that a module cannot reuse a core role id.
- Nothing says who may insert into `role_assignment` or `role`, whether that is audited, or whether a user can self-assign.
- `has_role` is not specified as `STABLE`, `SECURITY DEFINER`, `SET search_path` or `REVOKE`d from `anon`. Under RLS on `role_assignment`, a non-definer `has_role` either recurses or reads nothing. A definer without a fixed `search_path` can be hijacked.
- A user with both `operador` and another role is not addressed. A policy written as "not operador" fails differently from "is X".

**Failure scenario:** A closed module creates a C3 table with the policy `using (core.has_role('operador') or core.has_role('triagem'))` because operators "do triage". CI is silent. Or a `chefe_gabinete` account with insert rights on `role_assignment` grants itself the module's `encarregado` role. Nothing in the contract forbids it and nothing alerts on it.

**Recommendation:**
- Specify `core.has_role(role text)` as `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core`, checking `aal2` (SEC-1), with `EXECUTE` revoked from `anon`.
- Writes to `role_assignment` go only through `core.assign_role()`. That function requires an explicit admin permission, forbids self-assignment, is audited, and supports `valid_until`.
- Add a CI test that parses `pg_policies` for every table classed C3 and fails if any policy expression mentions `operador` or a generic predicate such as `auth.uid() is not null`.
- Manifest validation rejects module roles that shadow core role ids, and permissions on C3 that list `operador`.
- Define C3 access positively (an allowlist per table) and document that negative role rules are not supported.

### SEC-8 — Anonymous denúncia vs rate limiting and idempotency (major, medium)

**Where:** §3.7 "Writes from the public (contact, denúncia, emenda request) require `Idempotency-Key` and pass rate limiting" (line 156).

**Problem:** Rate limiting needs a client identifier. In practice that is the IP, a device id or the JWT `sub` of a Supabase anonymous sign-in. Idempotency needs a stored key-to-response map. The doc does not say:
- where these records are kept or for how long;
- whether they are linked to the submitted row;
- whether platform access logs (Next.js host, CDN, Supabase API gateway) record IPs for the denúncia endpoint;
- whether the `Idempotency-Key` can be correlated with a device.

Denúncia content is likely C3, and a reporter's identity is the most sensitive fact in the system.

**Failure scenario:** A denúncia names a local official. Months later, the idempotency table (`key`, `ip`, `created_at`, `response.id`) and the hosting access logs allow the submission to be matched to an IP and then to a person through a legal request or a leak. The design promised anonymity it could not deliver.

**Recommendation:** Add an "anonymous write" contract:
- The rate-limit key is `HMAC(daily_rotating_secret, ip_/24 or ip_/48)`, kept in memory or with a TTL of at most 24 hours, and never written to the submission row.
- Idempotency records store only `hash(key)` and the response status, never the created id or the IP, with a TTL of at most 24 hours.
- Denúncia endpoints are excluded from request logging (or logged with the IP truncated).
- No anonymous Supabase sign-in for denúncia (the `sub` is stable). Use proof-of-work or a privacy-preserving challenge instead of a fingerprinting CAPTCHA.
- The UI tells the reporter what is and is not kept.
- The pro module that implements denúncia is out of scope (§5), but these guarantees belong to the framework route layer, so they must be part of this contract.

### SEC-9 — The "no PII" rule only covers error bodies (minor, medium)

**Where:** §3.7 "never echo personal data in errors" (line 154), §3.1 "web app only enqueues jobs" (line 34), §3.4 `Job.run(payload: dict…)` and `schema/job.schema.json` (line 31).

**Problem:** The Postgres-backed queue persists job payloads, and nothing says what a payload may contain. Logs, traces and crash reports from Next.js and the Python workers are not covered either.

**Failure scenario:** The web app decrypts a citizen message and enqueues `{ "text": "<plaintext>" }` for an AI job. The queue table now holds C3 plaintext outside any `enc_` column, readable by whoever can read the queue and kept for as long as job history is kept. A worker exception logs the payload to the error tracker.

**Recommendation:**
- `job.schema.json` allows only ids, enums and C0/C1 scalars. C2/C3 values are passed by reference and the worker decrypts them.
- Add a framework logging rule (a redaction filter in both runtimes, fed by the column prefixes) and a retention limit on finished jobs.

### SEC-10 — Secrets in configuration (minor, medium)

**Where:** §3.2 `connectors[].params` (line 64), §3.4 `ConnectorManifest.auth` (line 117).

**Problem:** No rule says where connector credentials or AI provider keys live. The schema allows free-form `params`. Lanes will put tokens in `tenant.yaml` (committed to the mandate config repo) or in `tenants/demo/` as "examples", and the latter is this public repo.

**Failure scenario:** The demo connector manifest ships with `params: { api_key: "…" }`, copied from a real setup. gitleaks may or may not catch a non-standard token format.

**Recommendation:**
- `tenant.schema.json` allows secrets only as references (`{ secret_ref: "env:IBGE_TOKEN" }`) and rejects property names that match `/(key|token|secret|password)/i` with literal values.
- `ConnectorManifest.auth` declares the *kind* of credential, never the value.
- Demo fixtures use only connectors that need no auth.

## Answers to §6 open questions (in this lens)

**Q1 — per-module schema `mod_<id>` vs prefixed tables.** From a security view, keep per-module schemas. Supabase exposure friction is a *feature* here: expose only `core_api` (and per-module API views, if needed) to the REST endpoint, never `core` or `mod_*` (SEC-1). Separate schemas also make it easy to grant a module's migration role rights only on its own schema, and to scope the CI checks for RLS, classes and audit triggers (SEC-3, SEC-4). Prefixed tables in one exposed schema would put every module's raw tables on the public API surface.

**Q2 — TypeScript `Connector`.** Python-only is preferable. A second connector runtime adds a second place where `data_class`, `terms_url`/robots handling and upserts must be enforced correctly. If a TS connector is ever allowed, restrict it by contract to sources whose manifest `data_class` is C0, with no AI calls.

**Q3 — 90-day tombstone window.** Not enough on privacy grounds. The tombstone is the only way a retraction or LGPD deletion reaches an offline device. A client whose `last_sync` is older than the window (or older than the oldest tombstone in the manifest) **must** do a full resync that replaces its local SQLite. Add `tombstones_since` to `manifest.json` so the client can detect this, and purge the CDN cache on deletion. Otherwise deleted content, including content removed for a data-subject request, stays on devices with no end date.

**Q4 — is the guard enough without per-`Part` classification?** No. Per-`Part` classification, set by the framework at the point of origin and not by the caller, is what makes the guard enforceable. See SEC-2: compute the effective class as the maximum over Parts, treat an unclassified Part as C3, cap it at `Job.data_class`, prevent direct `provider.generate` calls, and take provider locality from operator config rather than provider code.
