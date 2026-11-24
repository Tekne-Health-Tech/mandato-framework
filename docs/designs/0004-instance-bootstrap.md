# Design 0004 — Instance bootstrap, worker runtime and fetch sidecar (E0.7)

Status: **Accepted (v4)** · 2026-11-24 · Builds on designs 0001–0003. Owner: architecture backbone. v2 answers the Codex review `egm/0004/stage1-codex.md`; v3 answers the re-check `egm/0004/stage2-codex.md`; v4 closes the two items of the final check `egm/0004/stage3-codex.md` (stopping rule reached: the implementation review verifies them); §11 maps each finding.

## 1. Problem

The framework has a schema, a migrator, staff auth, a demo reset and a connector kit, but no way to stand up a running instance: nothing runs workers, nothing schedules connectors, and the egress boundary of design 0003 §3.4 exists only as policy code. E0.7 delivers `infra/`: one command that builds a **local** instance (everything in Docker Compose, demo tenant) and a **staging** instance (managed Postgres on Supabase plus the same worker stack on a VPS), from `tenant.yaml`, and the network test that the connector release gate needs.

## 2. Constraints

- One instance per mandate (ADR-0002). Staging and production of a mandate are separate instances with separate keys.
- No container has a general internet route. Every connection that leaves the internal networks goes through one of two gateways that hold a fixed destination allow-list (§3): `egress` (HTTPS to the hosts of enabled connector manifests) and `dbgw` (TCP to the one configured database endpoint, staging only). This holds for local and staging alike; the network test (§9) proves it for both shapes.
- Secrets never live in the repository or in `tenant.yaml`: KEK, database passwords, hook secret and API keys come from the environment or a secret file mounted at runtime (`*_secret_ref`). Worker containers have no secret mount; `JobContext.secret()` raises `secret_unavailable` in the images (secrets are used only by sidecars).
- Creating hosted resources (a Supabase project, a VPS) costs money and binds accounts. The bootstrap **never creates them**: the operator creates them and passes their identifiers; the bootstrap configures what exists. Who owns those accounts is the open decision L3.
- Images: digest-pinned per platform, recorded in a lock file with source and release date, at least 14 days old when chosen, with SBOM and vulnerability scan in CI (§7).

## 3. Topology

```
infra/
  compose/compose.yaml        # generated per instance by `mandato instance up` from tenant.yaml (§8); template + overlays
  compose/networks.md         # what can reach what (the test in §9 checks it)
  images/lock.json            # image, platform, digest, source, release date, licence scope (§7)
  images/worker/Dockerfile    # FROM <lock digest>; workers/requirements.txt --require-hashes; uid 10001
  images/api/Dockerfile       # FROM <lock digest>; pnpm install --frozen-lockfile --prod; uid 10002
  bootstrap/instance.mjs      # `mandato instance up|check|down`
```

Networks (all `internal: true` except `outside`):

| network | members | purpose |
|---|---|---|
| `db` | postgres (local) or `dbgw` (staging), api, scheduler, every worker, every fetch sidecar | database only |
| `fetch_<pool>` | `fetch-<pool>`, `egress` | sidecar → egress gateway |
| `outside` (not internal) | `egress`, `dbgw` | the only members with a route out |

Services: `postgres` (local only), `api`, `scheduler`, `worker-<pool>` for **each pool the instance needs** (§4.3), `fetch-c1` (only c1 has connectors in this lane), `egress`, `dbgw` (staging only). Workers and the API are on `db` only. The sidecar socket lives in a volume `sock_<pool>` mounted only by `worker-<pool>` and `fetch-<pool>`.

**`egress`** — an in-repo stdlib Python HTTP `CONNECT` proxy (`workers/core/egress/proxy.py`, same worker image, its own container and uid). It accepts `CONNECT host:443` only for hosts in the union of `hosts` of the enabled connector manifests (computed at start from the same registry), resolves the name itself, refuses unless every address is public (`policy.is_public`), and connects to the checked address. It has no other function; it never sees plaintext (TLS is end to end from the sidecar, which still pins SNI and verifies the certificate). A compromised sidecar can therefore reach only allow-listed hosts on 443 at public addresses; there is no DNS server reachable from `fetch_<pool>` (Docker's embedded resolver answers only service names on internal networks, and the test checks that external names do not resolve).

**`dbgw`** (staging) — an in-repo stdlib TCP relay (`workers/core/egress/dbgw.py`) that forwards its single listener to the one database endpoint given at `up` (`host:port` from the database URL, resolved and checked public at start and on every new connection). Workers, API and scheduler reach Postgres only through it; TLS to Postgres stays end to end (`sslmode=verify-full`, server name = the Supabase host). No other destination exists in its code path.

Ingress for the API (the Supabase auth hook calls it) and the API's own outbound calls to Supabase Auth are deployment concerns of E7.1; in this lane the API is on `db` only and the staging hook is exercised against the local shim.

## 4. Worker runtime (`workers/core/runtime/`)

### 4.1 Loop (`worker.py`, one process per pool: `--pool c1|c2|c3`, database role `worker_<pool>`)

1. Every 60 s: `core.reclaim_jobs()`.
2. `core.claim_job(queues, worker_id)` for the registered queues of its pool (§4.3); idle sleep 2–10 s with jitter. One job at a time per process.
3. On claim, the loop starts a **heartbeat thread** that calls `core.heartbeat_job(lease)` every 60 s for as long as the job runs, for every job (the connector runner's own heartbeat is removed; it uses this one). Reclaim threshold stays 10 min.
4. **Finalization is owned by the loop for module jobs.** A module `Job.run` returns the frozen `JobResult(ok, detail)`; the loop calls `core.finish_job(lease, ok, code)`: `code` is null when `ok`; otherwise it is `detail` when `detail` already has the code shape `^[a-z][a-z0-9_]{0,40}$`, and `job_failed` when it does not (free text such as the demo's `"olá"` stays valid under the frozen contract; only its length goes to the log, never its value). An exception becomes `internal` (type to the log, never values). The framework's own queues (`core.connector_run`, `core.takedown`, `core.noop`) are **not** `Job` objects: the loop dispatches them to built-in functions that finish the job themselves (the connector runner calls `finish_job` inside its tx2, design 0003), so the `JobResult` contract is unchanged. If any `finish_job` raises `job: invalid lease` the loop logs `lease_lost` and moves on. Resulting states are those of `finish_job`: `done`, or `queued` with backoff, or `dead` (terminal codes or attempts exhausted). There is no `failed` state from the loop.
5. Liveness: after each loop iteration (claim attempt, idle sleep or job end, and every heartbeat) the process touches `/run/mandato/alive` (tmpfs); the compose healthcheck fails if it is older than 3 min. The scheduler does the same after each tick.
6. `SIGTERM`: stop claiming; the running job continues with its heartbeat until it returns; then exit 0. There is no internal hard bound: the orchestrator's grace period is the bound (`stop_grace_period: 15m` in compose). A job still running when the grace ends is killed and handled as below. On `SIGKILL` or crash, Postgres rolls back the open transaction when the connection drops; the lease goes stale and is reclaimed; the next run of a connector closes its orphaned `running` run (0003 §13). Handlers must therefore be safe to re-run after a crash (already true for connectors; required of module jobs by the job contract).

### 4.2 Registry

Module workers are found from `tenant.yaml` → enabled modules → `mandato.module.json` `worker` path → the package's `jobs` and `connectors` lists (as frozen in contract 0.2.0 and exported by the demo module) (no free-form import strings). `check_registry` (0003) runs at start; a refusal stops the worker with a clear error. The trust boundary is the worker process: every enabled module's code runs in it, so modules are trusted at code-review level, not isolated from each other at runtime (§6 limits the sidecar to the job the process currently holds).

### 4.3 Pools

The set of pools an instance needs is the set of `data_class` values of its registered jobs and connectors, mapped by `audit.pool_classes` (c1: C0/C1; c2: C2; c3: C3). `instance up` generates one `worker-<pool>` service for each needed pool and none for others; `validate --strict` refuses a tenant whose modules need a pool the instance profile disables. Only `c1` gets a fetch sidecar in this lane; a c2/c3 module that declares a connector is refused (C2/C3 sources wait for the AI/E4 lanes).

## 5. Scheduler (`scheduler.py`, role `scheduler`)

### 5.1 Declarations

- **Connectors**: `tenant.yaml` `connectors[]` gains `enabled: boolean` (default `true`). Schedule identity: `conn:<source_id>`; queue `core.connector_run`; class from the manifest; payload `{source_id}`.
- **Module jobs**: `mandato.module.json` gains `schedules: [{id, queue, cron, payload}]` — `id` `^[a-z][a-z0-9_]{1,40}$` unique in the module, `queue` one of the module's own queues (`<short>.<name>`), `cron` as §5.2, no `data_class` field: the class is taken from the registered `Job` of that queue (`check_registry` refuses a schedule whose queue has no registered job, so a scheduled job can never be unclaimable or mis-pooled), `payload` a constant object without secret-like keys (the `noSecrets` rule of the tenant schema). Identity: `mod:<short>.<id>`. `tenant.yaml` gains `schedules: {<short>.<id>: {enabled: false}}` to switch one off. Validators (`validate --strict`, JS) and the Python registry enforce both; fixtures in the demo tenant cover both.
- Idempotency key of a scheduled job: `sched:<identity>:<minute UTC, ISO 8601, e.g. 2026-11-24T09:00Z>`.

### 5.2 Cron and time

Five fields; `*`, numbers, lists, ranges, steps on `*` or a range; Sunday is 0 or 7; no names, no `L`/`W`/`#`/`@`. Day-of-month and day-of-week combine as in Vixie cron (either matches when both are restricted). Evaluation walks **UTC minutes** and converts each to wall-clock in the instance timezone: in a DST gap the skipped wall-clock times do not fire; in a DST fold a wall-clock time fires at both instants (two UTC minutes, two keys). The timezone must load in `zoneinfo` (`validate --strict` checks it; the schema regex alone is not enough).

### 5.3 Tick (every 60 s)

For each enabled identity, in its own short transaction:
1. `last := max(run_after)` of jobs with that queue and `left(idempotency_key, length(:prefix)) = :prefix`, where `prefix = 'sched:<identity>:'` (exact comparison, no `LIKE` wildcards).
2. Due minutes in `(last, now]`, capped at the last 60 minutes; when `last` is null (new or long-pruned schedule) only the current minute is considered, so a new schedule starts firing from its next due minute; older due minutes are skipped and counted in the `scheduler.skipped` log line (operators alert on it; monitoring is E7.1).
3. `insert into core.job (…, run_after = <minute>, idempotency_key = …) on conflict (queue, idempotency_key) do nothing` per minute.
Two schedulers, a restart or a re-tick insert nothing twice; a failed identity does not roll back another.

### 5.4 Role

New role `scheduler` (login, no other membership): `insert` on `core.job` with policy `state = 'queued' and lease_hash is null and left(idempotency_key, 6) = 'sched:'`; `select (queue, idempotency_key, run_after)` on `core.job` with a policy limited to `left(idempotency_key, 6) = 'sched:'`; nothing else (no `claim_job`, no module schema). `core.job` is not audited row by row (0001), so no lease is needed. The grants matrix and `run.sh` assert it.

## 6. Fetch sidecar (`workers/core/fetch/sidecar.py`)

- A stdlib HTTP server on a Unix socket in `sock_c1` (`/run/mandato/fetch.sock`, mode 0660, group shared by the two uids). No TCP listener. Its only outbound routes: `db` and `fetch_c1` → `egress`.
- Request: `POST /fetch` JSON `{lease, url, params, headers}`. **The capability is the job lease the worker holds**, not anything the worker names. The sidecar (database role `fetch_c1`) calls `core.fetch_grant(lease)`, a security-definer function that returns `(job_id, source_id)` only when the lease matches a `running` job of queue `core.connector_run` whose `locked_at` is within the reclaim threshold, and the source is provisioned and enabled; otherwise it raises. The sidecar then loads that source's manifest from its own registry copy and applies `FetchClient` (policy, robots, rate limit per source, budgets per `job_id` held in the sidecar). A worker can therefore fetch only for the connector job it currently holds; a lease from another container is unknown to it.
- API keys: the sidecar reads `/run/secrets/<auth_secret_ref>`, where `auth_secret_ref` must match `^[a-z][a-z0-9_]{1,60}$` and appear in the instance's configured secret list; the file is opened with `O_NOFOLLOW` under a directory fd of `/run/secrets` (no traversal, no symlinks).
- Response: `{status, headers, body_b64}`. The sidecar writes nothing to the database or the raw store: the worker records the response exactly as the in-process client does (`Recorder`, under its own lease as `worker_c1`), so the audit model is unchanged. Role `fetch_c1` (login): execute `core.fetch_grant` only; `fetch_grant` is owned by `core_owner` and refuses any `session_user` other than `fetch_c1`. Response headers pass through an allow-list (`content-type`, `etag`, `last-modified`, `content-length`); the auth header is never echoed by the framework.
- **Guarantee, narrowed**: the secret never appears in the worker's environment, mounts, framework logs, or framework-generated response fields. An upstream that echoes the credential in its own body is outside what any proxy can prove; the connector review checks sources for it, and such a source must use a structured parser in the sidecar (later lane), not raw bodies.
- Worker side: `SidecarHttp` implements `Http.get` over the socket. The runner uses it when `MANDATO_FETCH=sidecar` (set in the images); `inprocess` is for tests only; unset → the worker refuses to start connector jobs.

## 7. Images and supply chain

- `infra/images/lock.json`: for each base image, `name`, `platform` (`linux/amd64`, `linux/arm64`), the per-platform `digest`, `source` (registry URL), `released` (date), `licence_scope`. Dockerfiles take `FROM name@digest` only; CI job `images` checks every `FROM` is in the lock, every entry is at least 14 days older than the commit that added it, and fails on tags.
- SBOM (`syft`, Apache-2.0) and vulnerability scan (`grype`, Apache-2.0) run in CI on the built images, both pinned by version and checksum; a critical/high CVE with a fix available fails the job; accepted exceptions live in `infra/images/vuln-exceptions.yaml` with expiry dates.
- **Licence scope** (owner decision, see the AGENTS.md amendment in this lane): AGENTS.md rule 2 forbids third-party GPL/LGPL/AGPL code copied into or linked with the framework. No Linux base image is free of GPL programs (busybox, coreutils, glibc is LGPL; the kernel itself is GPL), and the framework neither copies nor links them: they are separate programs in the runtime image. v3 therefore proposes amending rule 2 to state its scope explicitly: it governs repository code and declared dependencies; OS packages of the pinned base images are allowed as separate works, inventoried by the SBOM, with no framework code linking against GPL libraries (Python and Node runtimes themselves are PSF/MIT). Until the owner approves the amendment, images are built and tested in CI but not published.
- GitHub Actions in `ci.yml` are pinned to commit SHAs in this lane.

## 8. `mandato instance`

```
mandato instance up    <tenantDir> --env local   [--db <name>] [--reset-demo]
mandato instance up    <tenantDir> --env staging --project-ref <ref> --db-url-secret <ref> --confirm <ref>
mandato instance check <tenantDir> --env local|staging [--probe] ...
mandato instance down  <tenantDir> --env local        # local only; refuses staging
```

**Preflight (read-only, before any write):** `validate --strict`; resolve secrets; for staging, check `--confirm` equals `--project-ref`, check the database URL names that project (`db.<ref>.supabase.co` or pooler user `postgres.<ref>`), connect read-only and read `core.instance` if it exists: its `slug` must equal `tenant.yaml` `slug`; if the `env` column exists its value must equal `--env`; if it does not exist yet (a database migrated before `0005`, which today means only local/demo databases, since no staging instance exists before this lane), `--env local` proceeds and `--env staging` is refused; a database with no `core` schema at all is a first install; for staging, the read-only part of `auth check` (hook configured, secret matches, TOTP-only) also runs here. Any mismatch stops before writing.

**Then, in order:** `bootstrap` → `migrate` (migration `0005_core.sql` adds `core.instance.env text not null check (env in ('local','staging','production'))`, filled by `migrate` from `--env` when the migration is applied, i.e. on the first `up` of a new database or the first `up` after upgrading a pre-0005 local one; refused on change by a trigger; `slug` already exists. `bootstrap` creates roles only and never reads or writes `core.instance`) → `keys init` (KEK from env/secret, never generated for staging) → generate compose for the needed pools → `compose up` → `check`. Local demo reset runs only when the database was created in this `up` or with `--reset-demo`; so a second `up` with the same inputs changes nothing (the test compares a schema+data checksum before and after).

**`check`** is read-only: migrations recorded and unchanged, `core.instance` matches, keys present for every staff purpose, roles hardened, every generated service is `healthy` in `docker compose ps` (the liveness file of §4.1, which an idle worker refreshes too). `--probe` additionally enqueues one `core.noop` job keyed `probe:<uuid>` for each pool and waits for `done`; probe rows are ordinary finished jobs, removed by the normal job retention.

## 9. Network test (`infra/compose/test-network.sh`, CI job `network`)

Runs the generated stack in two shapes: **local** (postgres in compose) and **staging-equivalent** (postgres moved to the `outside` side as a stand-in managed database, reached only via `dbgw`). A controlled internet: containers `allowed.test` and `other.test` on `outside`, a test CA trusted by the sidecar only, and an `outside` resolver that knows both names.

1. From each `worker-<pool>`, `api` and `scheduler`: raw TCP to `allowed.test:443`, to `other.test:443` and to a literal outside IP fails; external names do not resolve.
2. From each worker: the database works; `worker-c1` reaches its socket; no worker sees another pool's socket or any `/run/secrets`.
3. From `fetch-c1`: raw TCP to `allowed.test:443` and `other.test:443` fails (only `egress` and `db` are reachable); `CONNECT other.test:443` through `egress` is refused; `POST /fetch` for an allowed URL works with a valid lease and is refused with no lease, a stale lease, or a lease of a non-connector job.
4. `api` cannot reach any socket (no shared volume).
5. Staging shape: workers reach the database only through `dbgw`; `dbgw` forwards nothing but the database endpoint.
6. No container runs as root; every image is in `lock.json`.

Passing this test is the release gate of design 0003 §3.4 for enabling connectors in production.

## 10. Tests (definition of done; each written to fail first)

- Cron: fields, ranges, steps, lists, Sunday 7, invalid expressions refused, dom/dow either-rule; DST gap and fold with `America/Sao_Paulo` 2018 dates and `America/New_York`; `America/Fortaleza`; 60-minute cap; unknown zone refused.
- Scheduler: two schedulers on one database enqueue each minute once (`on conflict do nothing`); a disabled connector or schedule is not enqueued; `scheduler` role cannot claim, cannot read non-`sched:` jobs, cannot insert non-`sched:` jobs.
- Worker loop: claims only its pool's queues; unknown queue left alone; heartbeat keeps a 12-minute job from being reclaimed; result → `queued` with backoff / `dead` exactly as `finish_job`; bad result code → `bad_result`; exception → `internal`; SIGTERM lets a running job finish and exits 0; SIGKILL mid-transaction leaves no rows and the job is reclaimed.
- Sidecar: `fetch_grant` refuses missing, stale and non-connector leases; budgets per job; secret ref traversal and symlink refused; header allow-list; the secret is absent from the worker's env, mounts, logs and framework response fields; `MANDATO_FETCH` unset → connector jobs refused.
- `egress`: refuses non-allow-listed hosts, non-443 ports, private/metadata addresses (`169.254.169.254`, RFC 1918, 100.64/10).
- `instance up --env local` twice: second run changes nothing; preflight refuses a staging URL of another project, a missing `--confirm`, and a database whose `core.instance` differs; `down` refuses staging; `check` writes nothing.
- Images job: tag `FROM` fails; digest not in lock fails; entry younger than 14 days fails.
- Network test as in §9.

## 11. Answers to the stage-1 review (`egm/0004/stage1-codex.md`)

| # | finding | answer |
|---|---|---|
| 1 | sidecar egress not network-enforced | §3: sidecar has no route out; only `egress` (CONNECT allow-list, public-address check) reaches HTTPS; §9.3 tests raw TCP/DNS bypass |
| 2 | staging DB path vs no egress | §3: `dbgw` single-destination relay; staging-equivalent shape in §9.5 |
| 3 | confused deputy | §6: capability = held job lease, verified by `core.fetch_grant`; source derived from the job; budgets per job; secret ref pattern + allow-list + `O_NOFOLLOW` |
| 4 | "never in responses" unprovable | §6: guarantee narrowed to env, mounts, logs and framework fields; echoing sources need a structured parser |
| 5 | no schedule contract | §5.1: `enabled` on connectors; module `schedules[]`; tenant overrides; identities and keys defined |
| 6 | scheduler correctness/privilege | §5.2–5.4: `on conflict do nothing`, per-identity transactions, Vixie dom/dow, DST gap/fold rules, zoneinfo validation, dedicated `scheduler` role |
| 7 | no generic heartbeat; `failed` state | §4.1: loop heartbeats every job; loop owns finalization; states as `finish_job` |
| 8 | 25 s bound | §4.1: hard bound removed; orchestrator grace; SIGKILL/rollback/reclaim tested |
| 9 | only worker-c1 | §4.3: one worker per needed pool; c2/c3 connectors refused in this lane; §9.2 cross-pool checks |
| 10 | bootstrap idempotency/wrong target | §8: read-only preflight with project/DB identity binding and `core.instance`; `--confirm`; demo reset only on creation or explicit; `check` read-only, `--probe` opt-in |
| 11 | image supply chain | §7: lock file with per-platform digests and dates, CI gate, SBOM + scan, actions pinned by SHA; licence scope proposed as an AGENTS.md amendment for the owner (v3) |
| s2-5 | `JOBS` vs `jobs`; schedule class | v3 §4.2 lowercase as frozen; §5.1 class taken from the registered job |
| s2-6 | null `last`; `LIKE` wildcards | v3 §5.3 null → current minute only; exact `left()` prefix |
| s2-7 | `FINISHED` not in contract | v3 §4.1: framework queues are built-ins outside the `Job` protocol; contract unchanged |
| s2-10 | `core.instance` has no `tenant_id`/`env`; auth check after writes | v3 §8: bind on existing `slug` + new `env` column (0005); read-only auth check moved into preflight |
| s2-11 | licence position not an approved exception | v3 §7: AGENTS.md amendment put to the owner; no image published before |
| N1 | `fetch_c1` cannot bind leases | v3 §6: sidecar writes nothing; worker records under its own lease |
| s3-10 | `env` read before 0005 exists | v4 §8: absent column tolerated for local only, staging refused; `migrate` fills `env` from `--env`; `bootstrap` never touches `core.instance` |
| s3-new | detail code shape tightens `JobResult` | v4 §4.1: non-code detail maps to `job_failed`; contract unchanged |
| N2 | idle instance fails `check` | v3 §4.1/§8: liveness file refreshed while idle; `check` reads compose health |

Non-blocking: the 60-minute cap's skipped runs are logged (§5.3) for alerting in E7.1.

## 12. Out of scope

Production deployment, DNS, ingress and TLS certificates for public endpoints, the API's outbound calls to Supabase Auth on staging, backups and monitoring (E7.1), AI provider sidecars (E4.1), the object-storage raw store (deployment of staging, after L3).

## 13. Implementation notes (E0.7, 2026-11-24)

Where the code differs from the text above, or where the text is not yet met. Nothing here relaxes a constraint of §2.

- **What is verified:** `packages/db/test/run.sh` (roles `scheduler` and `fetch_c1`, `core.fetch_grant` with held, forged, malformed, stale and non-connector leases, `worker_c1` refused) and `test_runtime_pg` (worker loop and scheduler against Postgres); `test_cron`; `test_sidecar_egress` (sidecar refusals, per-job budgets, header allow-list, socket round trip, `egress` allow-list and address checks on the wire, `dbgw` fixed destination); `infra/compose/test-network.sh` in the **local** shape, including one connector run worker → sidecar → `egress` → origin → table; `instance up --env local` twice with an unchanged schema, data, keys, migration log and role passwords.
- **API not in the generated compose.** The API needs outbound access to the auth provider's JWKS, which needs its own egress rule (staging). Until then the API runs outside the instance compose, and §9 items 1 and 4 are checked for workers and the scheduler only.
- **Staging is not exercised.** `instance up` refuses any env other than `local`. The staging preflight, `dbgw` in compose and the staging-equivalent shape of §9 (item 5) wait for Tekne's infrastructure accounts (decision L3: Tekne holds and operates them, with guaranteed handover). `dbgw` itself is unit-tested.
- **Network test, item 3:** the stale, missing and non-connector leases are tested at the database (`run.sh`); the network test sends a forged lease end to end.
- **`instance register`** runs inside the tools image; local `validate` is not `--strict` (the demo tenant has no staging secrets).
- **CI:** job `images` (`scripts/check_images.py` also refuses an action not pinned by commit SHA and a workflow service image without a digest; builds both images; checks non-root users) and job `network` (builds the images, runs the network test). The database job's Postgres service uses the locked digest.
- **Supply chain:** CI job `supply-chain` builds both images, writes an SPDX SBOM per image (`syft`, uploaded as an artifact) and fails on a critical/high finding with a fix (`grype --only-fixed --fail-on high`) unless listed in `infra/images/vuln-exceptions.json` (JSON, not YAML, so the gate needs no parser) with an expiry within 90 days. Image publication waits on the AGENTS.md licence-scope amendment (§7).
- **Code review (EGM stage 4):** the scheduler and the fetch sidecar now run from `runtime.json` (data only, re-validated by `runtime/spec.py`) and mount no tenant code; the scheduler's watermark is the key's minute; the sidecar re-checks the lease before every request and serializes each job's requests; a lost heartbeat ends the worker process; `up` runs a read-only identity preflight before any write and runs images by content id; `check` verifies every migration hash; every container is read-only with no capabilities. Findings and tests: `docs/lanes/wave-2-code-review-response.md`.
- **Until the staging shape passes (§9 item 5), no connector is enabled outside a local instance.**
