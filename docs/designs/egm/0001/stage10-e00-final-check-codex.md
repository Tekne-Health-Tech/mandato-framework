<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

1. **Static check alias — closed.** Exact `E = ai.EchoProvider` scenario now reports `references EchoProvider`.

2. **Large-object grants — closed.** Bootstrap checks both ACL grants and ownership through `pg_largeobject_metadata`.

3. **Audit `entity_id` free text — closed.** Exact direct-call scenario using `mariasilva` now fails UUID validation.

4. **AI guard alias — closed.** Same alias path is caught before direct provider invocation.

No new blocker introduced by diff.

Notes: wildcard imports could still evade alias tracking, but careful review should flag them. `pg_trigger_depth()` exception could admit free text from custom trigger code, but such direct misuse should also be review-visible. PostgreSQL suite was not rerun because no server was available; targeted Python test could not use temp files under read-only sandbox, but exact alias reproducer was exercised without filesystem writes.

E0.0 accepted