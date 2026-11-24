# Design 0004 — Instance bootstrap, worker runtime and fetch sidecar (E0.7)

Status: **Draft (v1)** · 2026-11-24 · Builds on designs 0001–0003. Owner: architecture backbone.

## 1. Problem

The framework has a schema, a migrator, staff auth, a demo reset and a connector kit, but no way to stand up a running instance: nothing runs workers, nothing schedules connectors, and the egress boundary of design 0003 §3.4 exists only as policy code. E0.7 delivers `infra/`: one command that builds a **local** instance (everything in Docker Compose, demo tenant) and a **staging** instance (managed Postgres on Supabase plus the same worker stack on a VPS), from `tenant.yaml`, and the network test that the connector release gate needs.

## 2. Constraints

- One instance per mandate (ADR-0002). Staging and production of a mandate are separate instances with separate keys.
- Workers have no internet egress; only the fetch sidecar of the `c1` pool and the AI provider sidecars reach the internet, each only to its allowed hosts (0001 §7.5, 0003 §3.4).
- Secrets never live in the repository or in `tenant.yaml`: KEK, database passwords, hook secret and API keys come from the environment or a secret file mounted at runtime (`*_secret_ref`).
- Creating hosted resources (a Supabase project, a VPS) costs money and binds accounts. The bootstrap **never creates them**: the operator creates them and passes their identifiers; the bootstrap configures what exists. Who owns those accounts is the open decision L3.
- Pinned, digest-addressed images (`image@sha256:…`), each at least 14 days old when chosen; permissive licenses only.

## 3. Layout

```
infra/
  compose/compose.yaml        # local: postgres, api, worker-c1, fetch-c1, scheduler; staging: same minus postgres
  compose/networks.md         # what can reach what (the test in §7 checks it)
  images/worker/Dockerfile    # python:3.12-slim@sha256…, workers/requirements.txt --require-hashes, non-root
  images/api/Dockerfile       # node:22-slim@sha256…, pnpm install --frozen-lockfile --prod, non-root
  bootstrap/instance.mjs      # `mandato instance up|check|down`
```

## 4. Worker runtime (`workers/core/runtime/`)

- **`worker.py`** — the loop of one pool (`--pool c1|c2|c3`, database role `worker_<pool>`):
  1. every 60 s, `core.reclaim_jobs()`;
  2. `core.claim_job(queues, worker_id)` for the queues its enabled modules register (plus `core.connector_run`, `core.takedown` in `c1`); idle sleep 2–10 s with jitter;
  3. runs the job; a job that returns without finishing is finished `failed` with code `unfinished`; an exception is finished with `internal` (type to the log, never values);
  4. `SIGTERM`: stop claiming, let the current job finish up to 25 s, then exit; an unfinished lease is reclaimed later.
  Module workers are found from `tenant.yaml` → enabled modules → `mandato.module.json` `worker` path → the package's `jobs`/`connectors` lists (no free-form import strings). `check_registry` (0003) runs at start; a refusal stops the worker with a clear error.
- **`scheduler.py`** — one process per instance. Every minute it computes, for each `tenant.yaml` connector and each module job that declares a `schedule`, the scheduled minutes since its last check (at most the last 60 minutes, so a long outage does not enqueue a backlog) and inserts `core.job` rows with idempotency key `<source_id>:<minute UTC ISO>`; the `unique (queue, idempotency_key)` constraint makes double scheduling impossible, even with two schedulers. Cron is parsed by a small in-repo parser (5 fields, `*`, lists, ranges, steps; no names, no `L`/`W`/`#`), in the instance timezone from `tenant.yaml`. It runs as `worker_c1` and needs only `insert` on `core.job` (already granted).

## 5. Fetch sidecar (`workers/core/fetch/sidecar.py`)

- A stdlib HTTP server on a Unix socket in a volume shared only with the worker of the same pool (`/run/mandato/fetch.sock`, mode 0660, group `mandato`). No TCP listener.
- Request: `POST /fetch` JSON `{source_id, url, params, headers, run_token}`; the sidecar looks up the manifest of `source_id` from the same module registry the worker loads (read-only image layer), applies `FetchClient` (policy, robots, rate limit, budgets per `run_token`), and answers `{status, headers, body_b64, raw_ref}` after writing the blob to the raw store it shares with the worker. API keys are read by the sidecar from its own secret mount (`/run/secrets/<ref>`); the worker container has no such mount.
- Worker side: `SidecarHttp` implements `Http.get` by calling the socket. The runner picks it when `MANDATO_FETCH=sidecar` (always set in the images); the in-process client is used only when `MANDATO_FETCH=inprocess`, which the images never set.
- `run_token` binds budgets to one run; it is a random value the runner creates per run, not the lease.

## 6. `mandato instance`

```
mandato instance up    <tenantDir> --env local   [--db <name>]
mandato instance up    <tenantDir> --env staging --project-ref <ref> --db-url-secret <ref> --api-url <https url>
mandato instance check <tenantDir> --env local|staging ...
mandato instance down  <tenantDir> --env local        # local only; refuses staging
```

`up` is idempotent and runs, in order, the existing commands: `validate --strict` → `bootstrap` → `migrate` → `keys init` (KEK from env/secret, never generated for staging) → `auth check` (staging only) → `compose up` of the services → `check`. For `--env local` with the demo tenant it then runs `demo reset`. Every step prints what it did; any failure stops with the step name. It never creates a hosted project, account, bucket or DNS record; for staging it prints the checklist of what the operator must have created first (project ref, database URL secret, storage bucket, hook secret, VPS with Docker).

`check` verifies a running instance: migrations recorded and unchanged, keys present for every staff purpose, roles hardened, the worker can claim and finish a `core.noop` job end to end, and the scheduler is enqueuing.

## 7. Network test 9 (`infra/compose/test-network.sh`, CI job `network`)

On the local stack, with a controlled "internet" (two containers on the external network acting as `allowed.test` and `other.test`, with a test CA trusted by the sidecar only):

1. from `worker-c1`: TCP to `allowed.test:443`, to a public IP and DNS resolution of external names all fail;
2. from `worker-c1`: the database and the fetch socket work;
3. from `fetch-c1`: `allowed.test` is reachable through the policy; `other.test` is refused by the policy;
4. `api` cannot reach the fetch socket (no shared volume);
5. no container runs as root; images are digest-pinned.

Passing this test is the release gate of design 0003 §3.4 for enabling connectors in production.

## 8. Staging and L3

The staging path is built and tested against a local Supabase-compatible stack (the shim plus a Postgres container) in CI. Running it against a real Supabase project needs the operator to create that project and its accounts, which waits on decision L3 (whose name the accounts are in). Until then the Dra. Mayra instance stays a local/demo instance with public data only, as already agreed.

## 9. Tests (definition of done; each written to fail first)

- Cron parser: fields, ranges, steps, lists, invalid expressions refused; DST-free timezone `America/Fortaleza`; at most 60 minutes of catch-up.
- Scheduler: two schedulers on one database enqueue each minute once; disabled connector not scheduled.
- Worker loop: claims only its pool's queues; unknown queue left alone; unfinished job → `failed/unfinished`; SIGTERM drains; reclaim runs.
- Sidecar: worker uses the socket; a request for another source's host refused; the API key never appears in the worker's environment, logs or responses; `MANDATO_FETCH` unset → worker refuses to start connectors.
- `instance up --env local` twice on a clean machine: second run changes nothing; `down` refuses staging.
- Network test 9 as in §7.

## 10. Out of scope

Production deployment, DNS, TLS certificates for public endpoints, backups and monitoring (E7.1), AI provider sidecars (E4.1), the object-storage raw store (deployment of staging, after L3).
