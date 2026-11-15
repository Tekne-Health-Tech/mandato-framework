<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

1. **Not closed — static provider checks bypassable by alias.** Ordinary assignment alias passes HEAD:

```python
import workers.core.contracts.ai as ai
E = ai.EchoProvider
E().generate("mod.task", [], {})
```

`check_ai_boundary.py` returns no findings. No `getattr`, built strings, or `exec`.

2. **Closed — PostgREST pin skipped without authenticator.** Bootstrap now raises before commit when `authenticator` is absent; transaction rolls back.

3. **Not closed — pre-existing role keeps direct grants.** Check omits large-object ACLs. Scenario: create large object containing secret data, then `GRANT SELECT ON LARGE OBJECT <oid> TO worker_c1`. Migration commits and grant remains because [0001_core.sql](packages/db/migrations/0001_core.sql:794) checks relation, schema, function, database, ownership, and default ACLs—but not `pg_largeobject_metadata.lomacl`. `worker_c1` can still read object.

4. **Not closed — `audit.write` accepts personal values.** This succeeds for `api_rt` and stores plaintext `mariasilva`:

```sql
select audit.write(
  'export',
  'core.content_item',
  'mariasilva',
  '{}'
);
```

`export` is registered; entity exists; [entity-ID validation](packages/db/migrations/0001_core.sql:536) accepts arbitrary identifier-like text.

5. **Not closed — AI guard bypass via alias.** Same ordinary assignment alias directly invokes provider without `AiGateway`; static check reports nothing. Under §7.5 this remains defense-in-depth, but it is not an obfuscated-code-only residual.

6. **Closed — provenance written after provider call.** [AiGateway.generate](workers/core/contracts/ai.py:141) writes provenance before `provider.generate`; failing-provider test confirms record exists.

Notes:

- No new blocker introduced by this diff.
- Passed: 39 Node tests, 20 Python tests, TypeScript compile, positive/negative AI checks, `git diff --check`.
- DB suite not rerun: no PostgreSQL server available.

E0.0 not accepted