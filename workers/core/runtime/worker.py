"""Worker loop of one pool (design 0004 §4.1).

One process per pool, one job at a time. The loop reclaims stale leases every minute, claims the queues its pool
serves, keeps every claimed job's lease alive with a heartbeat thread, and finishes module jobs itself from their
`JobResult`. Framework queues are built-ins that finish their own job (the connector runner does it in its tx2).
SIGTERM stops claiming and lets the running job end; there is no internal hard bound.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import logging
import os
import random
import re
import signal
import socket
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from workers.core.connectors.db import connect

from .registry import CONNECTOR_QUEUE, NOOP_QUEUE, Registry, class_name

log = logging.getLogger("mandato.worker")
CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")


class SecretUnavailable(Exception):
    code = "secret_unavailable"


MAX_MISSED_BEATS = 3   # at the 60 s default, 3 min of a database outage: far inside the 10 min reclaim window


def hard_exit() -> None:   # pragma: no cover - replaced in tests
    """The lease is gone while a handler still runs: another worker may reclaim and rerun the job. A thread cannot be
    stopped from outside, so the process ends at once; its open transaction rolls back (design 0004 §4.1)."""
    # No logging call here: a handler blocked on its lock or a full pipe would hold this thread while the job runs on.
    # One non-blocking write to stderr, best effort, then exit.
    try:
        import fcntl
        fcntl.fcntl(2, fcntl.F_SETFL, fcntl.fcntl(2, fcntl.F_GETFL) | os.O_NONBLOCK)
        os.write(2, b"mandato.worker CRITICAL lease lost while running: exiting so the job cannot run twice\n")
    except Exception:   # noqa: BLE001 - nothing may stop the exit
        pass
    os._exit(70)


class JobHeartbeat(threading.Thread):
    """Refreshes one lease every `interval` s on its own connection. The lease counts as lost, and `on_lost` runs,
    when the database refuses it or when beats keep failing (`MAX_MISSED_BEATS` in a row, reconnecting each time)."""

    def __init__(self, database: str, user: str, token: str, interval: float, on_beat: Callable[[], None] = lambda: None,
                 on_lost: Callable[[], None] = lambda: None, connect_fn: Callable = connect):
        super().__init__(daemon=True)
        self.database, self.user, self.token, self.interval, self.on_beat = database, user, token, interval, on_beat
        self.on_lost, self.connect_fn = on_lost, connect_fn
        self.stop_ev, self.lost = threading.Event(), threading.Event()

    def _lose(self) -> None:
        self.lost.set()
        if not self.stop_ev.is_set():
            self.on_lost()

    def run(self) -> None:
        conn, missed = None, 0
        try:
            while not self.stop_ev.wait(self.interval):
                try:
                    if conn is None:
                        conn = self.connect_fn(self.database, self.user)
                    conn.run("select core.heartbeat_job(:t)", t=self.token)
                    missed = 0
                    self.on_beat()
                except Exception as e:
                    if "invalid lease" in str(e):
                        return self._lose()
                    missed += 1
                    log.warning("heartbeat failed: type=%s missed=%d", type(e).__name__, missed)
                    if conn is not None:
                        try:
                            conn.close()
                        except Exception:
                            pass
                        conn = None
                    if missed >= MAX_MISSED_BEATS:
                        return self._lose()
        finally:
            if conn is not None:
                conn.close()

    def stop(self) -> None:
        self.stop_ev.set()
        self.join(10)


class JobCtx:
    """The `JobContext` a module job receives. Secrets live only in sidecars (design 0004 §2)."""

    def __init__(self, conn, token: str, job_id: str, data_class: str):
        self._conn, self._token, self.job_id, self.data_class = conn, token, job_id, data_class

    def tx(self):
        from workers.core.connectors.db import tx
        return tx(self._conn, self._token)

    def secret(self, ref: str) -> str:
        raise SecretUnavailable()

    def ai(self):
        raise NotImplementedError("ai gateway arrives with E4.1")


def result_code(result: Any) -> tuple[bool, str | None]:
    """Maps a frozen `JobResult(ok, detail)` to finish_job arguments without tightening the contract (design 0004 §4.1)."""
    ok = getattr(result, "ok", None)
    if ok is True:
        return True, None
    if ok is not False:
        return False, "bad_result"
    detail = getattr(result, "detail", None)
    return False, detail if isinstance(detail, str) and CODE_RE.match(detail) else "job_failed"


class Worker:
    def __init__(self, reg: Registry, pool: str, database: str, *, connector_run: Callable | None = None,
                 worker_id: str | None = None, heartbeat_s: float = 60, reclaim_s: float = 60,
                 idle: tuple[float, float] = (2, 10), alive_file: str | None = "/run/mandato/alive",
                 sleep: Callable[[float], None] | None = None, on_lease_lost: Callable[[], None] = hard_exit):
        self.reg, self.pool, self.database = reg, pool, database
        self.user = f"worker_{pool}"
        self.queues = reg.queues(pool)
        self.connector_run = connector_run
        self.worker_id = worker_id or f"{socket.gethostname()}:{os.getpid()}"
        self.heartbeat_s, self.reclaim_s, self.idle = heartbeat_s, reclaim_s, idle
        self.alive_file = alive_file
        self.stopping = threading.Event()
        self.sleep = sleep or self.stopping.wait
        self._last_reclaim = 0.0
        self.conn = None
        self.on_lease_lost = on_lease_lost

    # ---------------------------------------------------------------- liveness (design 0004 §4.1 step 5)
    def touch(self) -> None:
        if self.alive_file:
            try:
                Path(self.alive_file).touch()
            except OSError:
                pass

    def stop(self, *_):
        self.stopping.set()

    # ---------------------------------------------------------------- loop
    def run_forever(self) -> None:
        self.conn = connect(self.database, self.user)
        log.info("worker started: pool=%s queues=%d", self.pool, len(self.queues))
        try:
            while not self.stopping.is_set():
                worked = self.step()
                self.touch()
                if not worked and not self.stopping.is_set():
                    self.sleep(random.uniform(*self.idle))
        finally:
            self.conn.close()
            log.info("worker stopped: pool=%s", self.pool)

    def step(self) -> bool:
        now = time.monotonic()
        if now - self._last_reclaim >= self.reclaim_s:
            self._last_reclaim = now
            try:
                n = self.conn.run("select core.reclaim_jobs()")[0][0]
                if n:
                    log.warning("reclaimed stale leases: n=%d", n)
            except Exception as e:
                log.error("reclaim failed: type=%s", type(e).__name__)
        if self.stopping.is_set():
            return False
        rows = self.conn.run("select job_id::text, queue, payload, lease_token from core.claim_job(:q, :w)",
                             q=self.queues, w=self.worker_id)
        if not rows:
            return False
        job_id, queue, payload, token = rows[0]
        hb = JobHeartbeat(self.database, self.user, token, self.heartbeat_s, on_beat=self.touch, on_lost=self.on_lease_lost)
        hb.start()
        try:
            state = self.dispatch(job_id, queue, payload or {}, token, hb)
        finally:
            hb.stop()
        log.info("job ended: queue=%s state=%s", queue, state)
        return True

    def dispatch(self, job_id: str, queue: str, payload: dict, token: str, hb: JobHeartbeat) -> str:
        if queue == CONNECTOR_QUEUE:
            if self.connector_run is None:   # MANDATO_FETCH unset or unknown: no connector runs (design 0004 §6)
                return self.finish(token, False, "fetch_unconfigured")
            try:
                return self.connector_run(token, job_id, payload, hb)
            except Exception as e:
                log.error("connector job failed: type=%s", type(e).__name__)
                return self.finish(token, False, "internal")
        if queue == NOOP_QUEUE:
            return self.finish(token, True, None)
        job = self.reg.jobs.get(queue)
        if job is None:   # claim_job only returns our queues; this guards a registry change between start and claim
            return self.finish(token, False, "unknown_queue")
        try:
            result = job.run(payload, JobCtx(self.conn, token, job_id, class_name(job.data_class)))
            ok, code = result_code(result)
        except Exception as e:   # type to the log, never values
            log.error("job raised: queue=%s type=%s", queue, type(e).__name__)
            ok, code = False, "internal"
        if hb.lost.is_set():
            log.warning("lease lost while running: queue=%s", queue)
        return self.finish(token, ok, code)

    def finish(self, token: str, ok: bool, code: str | None) -> str:
        try:
            return self.conn.run("select core.finish_job(:t, :o, :e)", t=token, o=ok, e=code)[0][0]
        except Exception as e:
            if "invalid lease" in str(e):
                log.warning("lease_lost at finish")
                return "lease_lost"
            raise


def connector_runner_from_env(reg: Registry, database: str, store_root: str) -> Callable | None:
    """Builds the connector entry point for the c1 pool from MANDATO_FETCH (design 0004 §6)."""
    from workers.core.connectors import raw as R
    from workers.core.connectors.runner import Deps, run
    mode = os.environ.get("MANDATO_FETCH")
    if mode == "sidecar":
        from workers.core.fetch.sidecar import SidecarHttp
        sock = os.environ.get("MANDATO_FETCH_SOCKET", "/run/mandato/fetch.sock")
        factory = lambda lease, recorder: SidecarHttp(sock, lease, recorder)   # noqa: E731
    elif mode == "inprocess":
        factory = None
    else:
        log.error("MANDATO_FETCH is not set to sidecar|inprocess: connector jobs will be refused")
        return None
    deps = Deps(database=database, store=R.FsRawStore(store_root),
                registry={s: v for s, v in reg.connectors.items() if s in reg.enabled_sources},
                tenant_connectors=reg.tenant_connectors, http_factory=factory)

    def connector_run(token, job_id, payload, hb):
        return run(deps, token, job_id, payload, heartbeat=hb)
    return connector_run


def main() -> None:   # pragma: no cover - exercised by the instance tests
    import argparse
    from .registry import load_registry
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", choices=["c1", "c2", "c3"], required=True)
    ap.add_argument("--instance", required=True, help="instance.json rendered by `mandato instance render`")
    ap.add_argument("--tenant-root")
    ap.add_argument("--database", required=True)
    ap.add_argument("--raw-store", default="/var/lib/mandato/raw")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    reg = load_registry(a.instance, a.tenant_root)
    if a.pool not in reg.pools():
        raise SystemExit(f"pool {a.pool} is not needed by this instance")
    run_c = connector_runner_from_env(reg, a.database, a.raw_store) if a.pool == "c1" else None
    w = Worker(reg, a.pool, a.database, connector_run=run_c)
    signal.signal(signal.SIGTERM, w.stop)
    signal.signal(signal.SIGINT, w.stop)
    w.run_forever()


if __name__ == "__main__":
    main()
