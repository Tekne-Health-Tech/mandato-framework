# Stage 5 — Cross-provider adversarial review of v3 (Codex)

| Finding | Status | Reason |
| --- | --- | --- |
| CP-01 | partly | Appendix A supplies most types and constraints, but still incorporates common columns by prose instead of per-table rows and labels `core.data_source` C0 despite its C1 `cursor`, so the dictionary is not internally exact. |
| CP-02 | closed | §6.2 now fixes source expressions and C0 outputs, rejects C2+ sources, binds content to the published version, and makes the permissioned, audited state change the declassification act. |
| CP-03 | partly | Opaque loaders and operator-owned provider metadata close the normal gateway path, but an aggregate hostname allow-list cannot stop same-process module code from bypassing the gateway to another allowed external provider. |
| CP-04 | partly | Runtime role attributes and default revokes are stated, but exact `api_rt`/`worker_rt` table-and-verb grants remain deferred to migrations and worker RLS is neither reconciled with the universal `has_role` rule nor bound to a job lease. |
| CP-05 | closed | Direct assignment DML is revoked and the fixed-search-path functions derive the grantor, enforce AAL2, active actors, enabled roles and no self-change, with adversarial cases required. |
| CP-06 | closed | Audit storage now has a separate non-login owner, insert-only entry point, rejecting mutation triggers and a separately controlled archival path. |
| CP-07 | partly | Caller-set `app.actor` is ignored, but `audit.write` would see `current_user = audit_owner` under `SECURITY DEFINER`, still accepts `kind`, and treats a reusable backend PID as an authenticated job lease. |
| CP-08 | partly | Registry states, authenticated AAD and write cutover exist, but the wrapped-DEK nonce/envelope is unspecified, the scan relies on an undefined maximum transaction duration, and KEK rotation/recovery is absent. |
| CP-09 | closed | Versioned normalization and index keys, dual write, locked backfill, lookup switch, uniqueness on both columns and shared byte vectors define a safe transition. |
| CP-10 | partly | Module-role negative privileges and migration hashes are defined, but `core.migration_log` is merely called append-only while `migrator` can assume its owning `core_owner` role; no owner/grant/trigger boundary makes history immutable. |
| CP-11 | partly | Targets now return projection requests and core constructs records, but §6.2 projections conflict with the universal record shape and refer to an `institutional` entity absent from Appendix A. |
| CP-12 | partly | Existing clients reject lower generations and apply takedowns before the version gate, but fresh installs can accept replayed signed manifests and signature canonicalization/key rotation are undefined. |
| CP-13 | closed | The store retains only classified digests, status and a minimal receipt for 24 hours; responses never replay submitted personal data. |
| CP-14 | closed | Trusted-header IP derivation, IPv6 prefixing, layered quotas, concurrency and body limits, challenge escalation, attachment quarantine and uniform responses close the stated abuse gaps. |

## New findings

### NEW-1

- **Severity:** blocker
- **Section:** §4.5, §7.4
- **Problem:** The replacement actor derivation is not an identity boundary: PostgreSQL changes `current_user` to the function owner inside a `SECURITY DEFINER` function, `kind` remains caller input, and `locked_pid` identifies a reusable database backend rather than a unique authenticated lease.
- **Failure scenario:** Worker A claims job X and releases a pooled connection; worker B later receives the same backend PID and mutates C1+ data, so the trigger attributes B's write to X while `db_role` records `audit_owner`; two running jobs on one backend also make the lookup ambiguous.
- **Smallest fix:** Remove `kind` from the API, record a separately captured/validated invoker role, issue an unguessable per-claim lease token, bind that token to exactly one running job and transaction through a privileged function, and make missing or ambiguous binding fail closed.

### NEW-2

- **Severity:** major
- **Section:** §6.2, §6.3, Appendix A
- **Problem:** Fixed projections do not produce the record contract they must satisfy: `causes` and `municipalities` have no `id`, their projection excludes timestamps despite every record requiring `updated_at`, and `institutional` has no source table or dictionary entry.
- **Failure scenario:** Publish lane aliases natural keys and synthesizes timestamps while mobile lane expects literal `id`/`updated_at`, or another lane invents an institutional source; all claim conformance but bundle validation and offline replacement disagree.
- **Smallest fix:** Define exact output aliases and timestamp source for every projection, add the matching JSON Schema, and remove `institutional` until a source entity is contracted (or add its full dictionary now).

### NEW-3

- **Severity:** blocker
- **Section:** §5, §6.3
- **Problem:** “Canonical JSON” does not identify a byte-level canonicalization, signature encoding or key id, and the single build-time public key has no overlap/revocation protocol; stored generation protects only devices that already observed a newer manifest.
- **Failure scenario:** Publisher and app serialize numbers or Unicode differently and reject a valid manifest; after signing-key rotation an offline app rejects every manifest; a fresh install accepts an old but validly signed manifest replayed by a stale or hostile CDN.
- **Smallest fix:** Name one canonicalization profile such as RFC 8785 plus signature encoding, carry `key_id`, support an overlap keyring and signed key transition, and define a trusted freshness/bootstrap rule for first install.

### NEW-4

- **Severity:** blocker
- **Section:** §7.5
- **Problem:** Proxy policy is generated from the union of provider hostnames, while provider identity and class ceiling are enforced only in-process; same-process module code can use another HTTP client and reach any allowed external hostname without the gateway's provider/class check.
- **Failure scenario:** C2 job code bypasses `AiGateway` and posts decrypted data directly to a hostname allowed only for a C0/C1 provider; proxy permits the host and provenance records nothing.
- **Smallest fix:** Deny raw worker egress and bind proxy authorization to an unforgeable per-provider workload identity with provider-specific host and class policy, or isolate each provider adapter behind its own proxy identity/process; keep import lint only as defense in depth.

Verdict: revise
