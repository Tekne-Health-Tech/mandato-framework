# Stage 7 response: what changed for each verification finding

Answer to `stage7-e00-verification-codex.md` (verified at 0aaad8b). Every blocker now has a test that failed on 0aaad8b and passes now. Rows marked "deferred" belong to a later lane and are part of that lane's definition of done.

## Blockers

| Finding | Fix | Test (failed before, passes now) |
| --- | --- | --- |
| (a) Projections not checked against Appendix A | The database decides. `run.sh` creates `projection_check`, granted `SELECT` only on columns whose class comment is C0/C1 and that carry no C2+ prefix, then runs `EXPLAIN` of every projection under that role. The executor's permission check rejects any other column and any whole-row reference. The JS regex stays only as an early lint, and its tests say so | `run.sh` "projection … reads only C0/C1 columns"; negative fixtures `projection-pii` and `projection-whole-row` (`to_jsonb(app_user)`) fail with "permission denied for table app_user" |
| (a) No static provider checks in CI (§7.5) | `scripts/check-ai-boundary.sh`: no provider SDK or network client outside `providers/`, no `ClassifiedPart(` or loader token, no direct provider or gateway instantiation. CI runs it on the tree and on a negative fixture that must fail | CI step "AI boundary"; fixture `tests/fixtures/negative/ai-boundary` (3 violations reported) |
| (b) PostgREST not fail-closed (§4.1) | `revoke all on schema public from public, anon, authenticated`; when the `authenticator` role exists, `pgrst.db_schemas = 'api'` | `run.sh` "anon/authenticated see no schema but api" (was 2) |
| (b) Pre-existing roles keep dangerous attributes (§4.1) | Every contract role is `ALTER`ed to its attributes whether or not it existed, and its memberships are revoked | `run.sh` pre-creates `worker_c1` with `BYPASSRLS CREATEDB CREATEROLE` and `pg_read_all_data`; "loses dangerous attributes", "loses foreign memberships" |
| (b) Anonymous `api_rt` reaches wrapped C2 keys (§4.1, §4.6) | `api_rt` policy now also requires `core.is_staff()` (active staff with `aal2`); `worker_c2` keeps its own policy | "anonymous api_rt reads no data key", "aal1 api_rt reads no data key", "aal2 staff reads only the C2 data key" |
| (b) `audit.write` accepts personal values (§4.5) | `audit.details_ok`: every key must be an identifier and every string value an identifier or a uuid (Appendix A: "ids and field names only"); action, entity and entity_id must be identifiers | "audit details refuse free text (an e-mail)", "… personal data hidden in a key", "… accept ids and field names" |
| (b) Signed key revocation ignored (§6.3) | `evaluateManifest` applies `keyring_update` (revoke, add `next`) only when signed by a `current` key and returns the keyring the device must store; revocation is final | `manifest.test.js` rotation sequence, "signed by a next key is refused", "revocation is final" |
| (b) AI guard does not control the real call (§7.5) | `AiGateway` is now a framework class: router, guard, registered providers, provenance with a hash only. Modules get parts only from `text_part` / `column_part`. Isolation stays the hard boundary, as the design says | `test_contracts.py` "guard runs before the provider" (provider never called), "provenance with hash only", "raw objects are not parts" |
| (b) Schema allows a "local" C3 provider with external egress (§7.5) | A `local` provider's egress must be a private host: `localhost`, `*.internal`, `*.local`, `*.lan` or an RFC 1918 address. Same rule in `tenant.schema.json` and in `check()` | `contracts.test.js` "rejects a local provider with external egress"; `test_contracts.py` same case |
| (c) Negative projection tests the name, not the class | See the first row: the proof is now the database | as above |
| (c) "Revoked key" test bypassed the signed rotation | Replaced by the signed rotation tests | as above |

## Should-fix and note

| Finding | Status |
| --- | --- |
| Audit misses C1 tables | fixed: `role`, `permission`, `data_source`, `data_source_run`, `ai_provenance` audited. Not audited row by row, on purpose: `core.job` (lease churn; work is audited under the job's lease), `core.idempotency` and `core.rate_counter` (hashes and counters, deleted within 24 h). Test: "a worker cannot update a C1 table without a bound lease" |
| Composite keys recorded as null | fixed: `entity_id` is the primary key, joined with `\|`. Test: "composite keys are recorded as entity_id" |
| Audit retention and `tx_lease` purge | deferred to the operations lane (archiver job, 5-year export with hash, lease purge) |
| `data_source.created_at/updated_at` classed C0 | fixed to C1 per Appendix A |
| Manifest vector invalid against its schema | fixed (`note_unicode` removed); test "the shared manifest vector is valid against the manifest schema" |
| Demo semantically incomplete | partly fixed: semantic checks for keys, modules, providers and connectors, and `demo.hello` settings validated against its `settings_schema`. `core.content`, `core.agenda` and the `ibge-municipios` connector are delivered by their lanes |
| Module may claim framework roles or permissions | fixed: `checkModule` requires `<module id>.` prefixes; fixture `module-authority-collision.json` |
| Demo module migration not applied in CI | fixed: `run.sh` applies it as `mod_hello_owner`; RLS and classification checks now cover `mod_*` |
| Grant matrix proves reproduction, not least privilege | partly fixed: unneeded `EXECUTE` on trigger functions removed. The diff of `grants.md` remains a reviewed change; a frozen allow-list arrives with the first lane that needs a new grant |
| RFC 8785 vector self-certified | fixed: hand-written vector from RFC 8785 §3.2.2–3.2.3 (key order by UTF-16 units, numbers, escapes) |
| Opacity test imports the loader token | fixed: tests use the public loaders; the static check forbids the token outside the contracts |
| Demo tenant "valid" proves syntax only | fixed with the semantic checks above |
| Note: `NoneProvider`, `apps/*`, `packages/core-domain` missing | `NoneProvider` added. `apps/web`, `apps/mobile` and `packages/core-domain` are created by their lanes (§11 layout lists the target tree) |
