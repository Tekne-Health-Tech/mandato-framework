# Stage 4 — Cross-provider adversarial review (Codex)

Reviewed: `docs/designs/0001-core-contracts.md` v2, with the prior reports in `docs/designs/egm/0001/` as the baseline. This review treats statements of intent as insufficient when the contract still permits two conforming implementations with different security properties.

## B1–B5 status

- **B1: unresolved.** Section 4.3 names columns, but still omits types for many columns, nullability for almost all columns, complete foreign keys, defaults and per-column classes. It is not the data dictionary B1 required.
- **B2: partially resolved.** The exposed-schema choice and `aal2` check are stated, but database grants, execution roles and `BYPASSRLS` constraints are not. The claimed boundary therefore remains implementation-dependent.
- **B3: unresolved.** Shapes now agree, but caller-created `Part` objects and provider-declared locality/classification remain trusted. A closed module can mislabel input or lie about an exfiltrating provider.
- **B4: partially resolved.** Composition and order exist, but the module migration role's negative privileges and migration integrity are absent. Running under a named role alone does not confine it.
- **B5: partially resolved.** Snapshot replacement is coherent, but manifest rollback and unsupported-client takedown behavior remain undefined.

## Findings

### CP-01

- **Severity:** blocker
- **Section and line:** §4.3, lines 64–88; §10, line 344
- **Problem:** B1 is claimed resolved, but §4.3 is not an implementable SQL contract. Many fields have no type (`started_at`, `status`, `payload`, timestamps), almost no field has nullability or default, foreign-key targets/actions are incomplete, and classes are mostly inferred from table-level prose rather than listed per column. Independent DB, auth, publish and fixture lanes can produce incompatible migrations while all claiming conformance.
- **Concrete failure scenario:** DB lane makes `role_assignment.revoked_at` nullable and `granted_by` `ON DELETE CASCADE`; auth mock omits `revoked_at`; audit lane assumes `ON DELETE RESTRICT`. A user deletion removes grant history in one implementation but fails in another, and fixtures do not expose the difference.
- **Smallest fix:** Replace §4.3 shorthand with one row per column containing exact type, class, nullability, default, PK/FK target and delete action. Include common columns rather than incorporating them by prose.

### CP-02

- **Severity:** blocker
- **Section and line:** §3, lines 21–26 and 36; §4.3, line 88; §6.2, line 164
- **Problem:** Data-class contract says C1 may not be published, and every content column is C1 at rest, but publish rule permits allow-listed unprefixed fields without requiring `class=C0`. This is implicit declassification with no contract for who authorizes it or what projection becomes C0. Excluding prefixes and actor ids does not exclude an unprefixed C1 internal note.
- **Concrete failure scenario:** A lane adds `content_version.editorial_note text` classified C1. Another lane adds it to content allow-list because it has no forbidden prefix. Approved content publishes note to immutable CDN bundles even though §3 says C1 cannot be published.
- **Smallest fix:** Define explicit publish projections whose output fields are individually classified C0. CI must reject every allow-list field not C0. If approval declassifies selected C1 source values, specify transition, actor, audit event and fixed source-to-C0 projection; do not say source columns merely “become publishable.”

### CP-03

- **Severity:** blocker
- **Section and line:** §7.5, lines 288–305; §7.4, lines 269–278
- **Problem:** B3 fixes signatures but not trust. `Part` is a caller-constructible `TypedDict`; a module can put decrypted C3 text in a `Part(data_class=C1)`. `locality` and `max_data_class` are attributes implemented by the provider itself. A malicious or buggy external provider can declare `local`, and closed module code can import its provider and call `generate` without `AiGateway`. “Only way” is a comment, not an enforceable boundary. `image_ref` and `audio_ref` also lack a rule preventing provider-side retrieval of C2/C3 objects.
- **Concrete failure scenario:** A module decrypts a health narrative, constructs a C1 text part, and routes it to a provider object that declares `locality="local"` while sending HTTPS to an external API. Gateway permits call and provenance falsely records C1/local.
- **Smallest fix:** Make provider locality and class ceiling operator-owned registry data, not provider attributes; expose only opaque provider handles to modules; enforce egress allow-lists outside provider code; make framework loaders produce opaque classified parts whose class cannot be lowered; prohibit direct provider imports/calls with an executable dependency check; require gateway-controlled fetch and classification for media references.

### CP-04

- **Severity:** major
- **Section and line:** §4.1, lines 42–49; §4.4, line 96; §9, line 334
- **Problem:** Restricting PostgREST to `api` prevents direct URL addressing of `core` and `mod_*`, but does not define database grants or execution roles. `SECURITY INVOKER` functions are not inherently read-only, and an invoker view requires underlying privileges. Contract also never says API/worker roles lack `BYPASSRLS`. Therefore “RLS enforces them again” and “password-only reads nothing beyond C0” are conditional, not guaranteed.
- **Concrete failure scenario:** Deployment grants `authenticated` `USAGE` on `core` and broad table `SELECT` so an `api` invoker view works, then adds an `api` function that returns a C2 row without calling `has_role`. Alternatively Next.js uses `service_role`, bypassing forced RLS after an API authorization bug. Both conform to current prose.
- **Smallest fix:** Add exact default-deny grants: revoke all on `core`/`mod_*` from `anon` and `authenticated`; enumerate allowed `api` objects and verbs; prohibit `SECURITY DEFINER` there; state API/worker runtime roles and that ordinary request paths never use a superuser or `BYPASSRLS`; make CI inspect grants, function security mode and role attributes. With those rules, a Supabase JWT cannot reach non-`api` objects and an `aal1` session cannot read C1+.

### CP-05

- **Severity:** major
- **Section and line:** §4.4, lines 94–97
- **Problem:** Role administration is described but not specified as an enforceable privilege boundary. No direct-DML revokes are stated for `role_assignment`, and `grant_role`/`revoke_role` ownership, `search_path`, grants, checks and derivation of `granted_by` are absent. “Nobody can grant a role to themselves” has no defined comparison or database constraint.
- **Concrete failure scenario:** Authenticated `chefe_gabinete` calls `grant_role(target := auth.uid(), role := 'parlamentar', granted_by := another_uuid)` or inserts directly under a permissive policy. Function trusts supplied `granted_by`, so self-grant passes and audit attributes it to someone else.
- **Smallest fix:** Revoke direct insert/update/delete on assignments from runtime roles. Define both functions as fixed-`search_path` `SECURITY DEFINER` functions owned by a non-login role; derive grantor from `auth.uid()`; require `aal2`, active caller, active `chefe_gabinete`, active target, enabled role, and `target <> auth.uid()`; expose only `EXECUTE`; add adversarial SQL tests.

### CP-06

- **Severity:** major
- **Section and line:** §4.5, lines 101–103
- **Problem:** `REVOKE UPDATE, DELETE, TRUNCATE FROM every role` cannot make a PostgreSQL table append-only against its owner; owners retain inherent privileges and can alter or disable triggers. The contract gives `core_owner` ownership of `core`, while `core.audit()` is also `SECURITY DEFINER`, leaving one highly privileged identity able to insert, rewrite and erase evidence. Five-year archive/delete path is not reconciled with append-only enforcement.
- **Concrete failure scenario:** Compromised API path executes as `core_owner`, deletes incriminating `audit_event` rows, then inserts plausible replacements through `core.audit()`. All stated revokes remain true because owner privileges are not ordinary grants.
- **Smallest fix:** Put `audit_event` under a dedicated non-login owner not used by API, workers or migrations; give a separate audit-writer function only `INSERT`; add rejecting update/delete/truncate triggers as defense in depth; define one separately controlled archival role and audited retention procedure.

### CP-07

- **Severity:** major
- **Section and line:** §4.5, line 102; §7.4, lines 269–278
- **Problem:** `app.actor` is a freely settable custom GUC. Any session capable of writing C1+ can set an arbitrary `worker:`, `migration:` or `system:` value. Trigger requiring presence prevents anonymous attribution but does not establish identity.
- **Concrete failure scenario:** Compromised module worker runs `set_config('app.actor', 'system:retention', true)`, alters records and produces valid-looking audit events attributed to retention rather than compromised module.
- **Smallest fix:** Do not accept raw caller-set actor text. Set actor through a fixed-`search_path` privileged function that derives permitted kind/id from `current_user`, authenticated job lease and transaction context; bind each runtime DB role to allowed actor kinds; have trigger record `session_user`/`current_user` independently.

### CP-08

- **Severity:** major
- **Section and line:** §4.6, lines 107–110
- **Problem:** Ciphertext envelope names a `key_id`, but no authenticated key registry or wrapped-key format exists. Wrap algorithm, wrap nonce, wrap AAD, key status, unique key-id constraint, instance binding and crash-safe retirement are unspecified. Rotation can retire a key after a stale scan while concurrent rows still reference it. Nonce generation requirements are also absent.
- **Concrete failure scenario:** Rotation job scans zero remaining old-key rows, while a concurrent API transaction writes one old-key ciphertext. Job retires wrapped key; committed row becomes permanently undecryptable. Another lane stores wrapped DEKs without authenticated metadata, allowing key-id substitution.
- **Smallest fix:** Define key-registry fields and states, authenticated DEK wrapping algorithm/AAD including instance and `<table>.<column>`, CSPRNG nonce generation, unique key ids, transactional write cutover, repeatable reference scan after old-writer shutdown, and deletion only after verified zero references plus backup policy.

### CP-09

- **Severity:** major
- **Section and line:** §4.6, line 110
- **Problem:** Blind-index key lifecycle is missing. A single unique `bi_email` cannot preserve lookup and uniqueness while index key rotates. Normalization is also too weak and not versioned; `lowercase and trim` leaves Unicode/IDNA and normalization-form divergence to each language implementation.
- **Concrete failure scenario:** Rotation changes index key. Existing rows retain old HMAC while new rows use new HMAC, allowing duplicate e-mail registration and making lookups miss half of users. TypeScript and Python normalize composed and decomposed Unicode differently, creating further duplicates.
- **Smallest fix:** Version normalization and blind-index keys; define byte-level normalization test vectors shared by TS/Python; support dual-write/dual-query during rotation with versioned index columns or rows; preserve uniqueness through a locked migration and retire old index only after full verification.

### CP-10

- **Severity:** major
- **Section and line:** §7.2, lines 233–241; §10, line 347
- **Problem:** B4 names a per-module migration role but never specifies its negative privileges. PostgreSQL roles may inherit privileges, use a writable `public` schema, create functions, or receive default grants. Migration checksums and immutable applied history are also absent, so a changed migration can run differently across instances.
- **Concrete failure scenario:** `mod_hello_owner` inherits a role with `CREATE` on `core` or `public` and installs a `SECURITY DEFINER` helper that reads core tables. Another deployment receives modified migration bytes under same module version; environments now have different policy state.
- **Smallest fix:** State `NOLOGIN NOINHERIT NOBYPASSRLS`, revoke public-schema create and all core privileges except enumerated `REFERENCES`/API use, set migration `search_path`, reject forbidden DDL, and record immutable `(module_id, migration_id, sha256, applied_at)` rows with checksum mismatch aborting boot.

### CP-11

- **Severity:** major
- **Section and line:** §6.2, line 164; §7.6, lines 315–319
- **Problem:** `PublishTarget` can return arbitrary structural `PublishedRecord` objects; TypeScript does not force use of `ctx.serialize`. Generic prose also mixes entity-specific row predicates (`state`, `visibility`, `deleted_at`) that do not coexist on every table. Runtime has no specified proof that module records came from a classified column or eligible row.
- **Concrete failure scenario:** Module target returns `{id, updated_at, contact_email}` directly, cast as `PublishedRecord[]`, for a draft module row without `visibility`. Bundle writer accepts it because target already returned the final shape.
- **Smallest fix:** Make targets return entity/query references, not final records, or make `PublishedRecord` an opaque value constructible only by core serializer. Define exact per-entity eligibility predicates and joins, including `content_version.n = content_item.published_version`; validate every output field and row again at bundle write time.

### CP-12

- **Severity:** major
- **Section and line:** §6.3, lines 188–197; §10, line 348
- **Problem:** B5 lacks rollback protection and has ambiguous behavior when `min_app_version` is too high. Client algorithm does not reject a manifest generation lower than stored generation. Step 2 says keep cached data, but does not explicitly require takedowns before stopping. A stale or replayed manifest can therefore resurrect withdrawn content, and an unsupported app can retain it indefinitely.
- **Concrete failure scenario:** CDN serves older `manifest.json` after withdrawal. Device accepts lower generation, downloads old content-addressed bundle and restores withdrawn record. Separately, old app sees update banner and stops before applying `takedowns[]`, leaving legally withdrawn content visible.
- **Smallest fix:** Reject `generation < stored_generation`; define manifest publication ordering and no-store/short-cache behavior; always apply authenticated takedowns before any version gate; state whether unsupported clients may sync compatible deletion metadata; raise `min_generation` before expiring a takedown if any supported offline client could still need it.

### CP-13

- **Severity:** major
- **Section and line:** §9, line 335
- **Problem:** M14 gives idempotency hash retention but not classification or storage of body digest and first response. Replaying first response to anyone presenting same anonymous key makes that key a bearer credential; responses can contain C2/C3 data or a report identifier. Rate-limit HMAC records have no explicit TTL, and hashed IPs remain pseudonymous personal data vulnerable to dictionary enumeration if daily keys are retained.
- **Concrete failure scenario:** Browser extension or referrer leak exposes `Idempotency-Key`; attacker replays it and receives original response containing case id or submitted personal data. Rate-limit rows remain indefinitely and become a long-term activity trail keyed to household IP.
- **Smallest fix:** Store only request digest plus minimal non-sensitive replay result, or encrypt sensitive response under a separate short-lived key; never echo submitted personal data; set explicit 24-hour deletion for all idempotency material and short TTL for rate counters; destroy rotated HMAC keys; classify both stores and include them in retention/erasure policy.

### CP-14

- **Severity:** major
- **Section and line:** §9, line 335
- **Problem:** IP-only rate limiting is neither a complete abuse boundary nor a stable identity rule. Contract does not define trusted proxy source, canonical IPv4/IPv6 representation, IPv6 prefix handling, endpoint/global scopes, payload limits or attachment controls. Attackers rotate IPv6 addresses or bot IPs; NAT users can deny service to each other.
- **Concrete failure scenario:** Bot uses a fresh IPv6 privacy address for every request and submits thousands of large reports with unique idempotency keys. Each IP HMAC is new, so limiter passes; queue and storage exhaust. One abusive user behind carrier NAT can also block all legitimate users sharing that address.
- **Smallest fix:** Define canonical client IP from trusted proxy headers only; rate-limit IPv6 by an operator-selected prefix; combine per-IP-prefix, endpoint, global concurrency and payload-size quotas; add cheap proof/challenge escalation after threshold; quarantine attachments; return uniform responses that do not reveal whether a person or case exists.

Verdict: revise
