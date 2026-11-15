# Stage 8 response: the five open blockers and the new one

Answer to `stage8-e00-reverification-codex.md` (verified at a3cbe1e).

| Finding | Fix | Test |
| --- | --- | --- |
| Static provider check bypassed by an alias (2, 8) | `scripts/check_ai_boundary.py` reads the Python syntax tree: it follows `import … as` and `from … import … as`, attribute access (`ai.EchoProvider()`), private names (`ai._LOADER_TOKEN`), `__import__` and `importlib`, and imports from any `*.providers` package. The grep script is gone. This remains defense in depth: §7.5 puts the hard boundary in the network, and in-process code is trusted Tekne code (trust model) | `workers/core/tests/test_ai_boundary.py`: one case per bypass, including `from … import EchoProvider as E; E().generate(…)`; negative fixture extended; CI runs both |
| PostgREST pin skipped when `authenticator` does not exist yet (3) | Bootstrap now refuses to finish without `authenticator`, so the pin to `api` cannot be skipped. The test shim creates it, as Supabase does | `run.sh` "PostgREST exposes only api" reads `pgrst.db_schemas=api` from the role settings |
| Pre-existing role keeps direct grants (4) | Bootstrap fails closed: if any contract role holds privileges, ownership or default privileges outside `core`, `audit`, `api` and `mod_*` (or more than `CONNECT` on the database), it raises and lists them. Revoking grants on objects it did not create is left to the operator on purpose | `run.sh` builds a database where `worker_c1` has `USAGE` on `public` and `SELECT` on `public.secrets`; bootstrap must fail naming `public.secrets` |
| `audit.write` accepts `{"patient":"mariasilva"}` (6) | Closed vocabulary. Allowed keys: `fields` (must be columns of the audited table), `ids` (uuids), `from_state`/`to_state` (registered states), `projection` (registered), `count` (number). Actions must be registered too, and `entity` must be an existing table. Terms live in `audit.term`; framework terms are seeded, modules register theirs through `audit.register_term` (migrator only) | `run.sh`: `{"patient":"mariasilva"}`, `{"fields":["mariasilva"]}`, an unregistered state, an unregistered action and a non-table entity are refused; a valid detail passes |
| New: provider failure leaves no provenance | The gateway writes provenance (hash only) before the provider receives anything | `test_contracts.py` "a failing provider call is still recorded" |

`audit.term` is a new C1 table in the `audit` schema (Appendix A updated).
