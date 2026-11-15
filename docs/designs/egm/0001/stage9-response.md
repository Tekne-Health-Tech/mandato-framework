# Stage 9 response: the closing check

Answer to `stage9-e00-closing-check-codex.md` (checked at fddbcca). Items 2 (PostgREST pin) and 6 (provenance order) were closed there.

| Item | Fix | Test |
| --- | --- | --- |
| 1, 5: `E = ai.EchoProvider; E()` passes the static check | Any attribute reference to a `*Provider` or `AiGateway` is reported where the name is taken, not only where it is called | `test_ai_boundary.py` case "assignment alias" |
| 3: large-object ACLs not checked | Bootstrap also refuses grants on, or ownership of, large objects held by contract roles | `run.sh` "bootstrap refuses a contract role with a large-object grant" |
| 4: `audit.write('export','core.content_item','mariasilva','{}')` | A direct caller may name a row only by uuid. Text or composite keys are accepted only from `audit.row_trigger`, which derives them from the row's primary key | `run.sh` "audit entity_id from a direct caller must be a uuid" |

Residual risk, as §7.5 states it: Python code inside a worker can always reach an object by deliberate indirection (`getattr` with built strings, `exec`). The static check catches ordinary code; the network isolation and per-class database roles are the boundary.
