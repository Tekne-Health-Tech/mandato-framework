"""Scheduler (design 0004 §5): turns cron schedules into queued jobs, as the least-privilege role `scheduler`.

Each tick handles every enabled schedule in its own short transaction: it reads the last scheduled minute of that
schedule, computes the due minutes since then (at most the last 60), and inserts one job per minute with the key
`sched:<identity>:<minute>` and `on conflict do nothing`. Two schedulers, a restart or a repeated tick therefore
never enqueue a minute twice, and one failing schedule does not roll back another.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import json
import logging
import signal
import threading
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path

from workers.core.connectors.db import connect

from .cron import MAX_CATCH_UP_MIN, due_minutes
from .registry import Registry, Schedule

log = logging.getLogger("mandato.scheduler")


KEY_TIME = "%Y-%m-%dT%H:%MZ"


def minute_key(identity: str, t: datetime) -> str:
    return f"sched:{identity}:{t.astimezone(timezone.utc).strftime(KEY_TIME)}"


def last_minute(conn, s: Schedule) -> datetime | None:
    """The last minute already scheduled, read from the immutable key, never from `run_after`: a retry moves a job's
    `run_after` forward (core.finish_job backoff), which must not hide the minutes in between. The key's timestamp is
    fixed-width UTC, so the greatest key is the latest minute."""
    prefix = f"sched:{s.identity}:"
    key = conn.run("""select max(idempotency_key) from core.job where queue = :q
                      and left(idempotency_key, length(:p)) = :p""", q=s.queue, p=prefix)[0][0]
    if key is None:
        return None
    try:
        return datetime.strptime(key[len(prefix):], KEY_TIME).replace(tzinfo=timezone.utc)
    except ValueError:
        raise ValueError("schedule key") from None


def tick_one(conn, s: Schedule, tz: str, now: datetime) -> tuple[int, int]:
    """Returns (inserted, skipped) for one schedule; one transaction."""
    conn.run("begin")
    try:
        last = last_minute(conn, s)
        skipped = 0
        if last is not None:
            floor = now.astimezone(timezone.utc).replace(second=0, microsecond=0) - timedelta(minutes=MAX_CATCH_UP_MIN - 1)
            gap_start = last.astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1)
            if gap_start < floor:   # a long outage: older due minutes are dropped, counted for alerting (§5.3)
                skipped = len(due_minutes(s.cron, tz, gap_start - timedelta(minutes=1), floor - timedelta(minutes=1),
                                          cap=False))
        inserted = 0
        for t in due_minutes(s.cron, tz, last, now):
            rows = conn.run("""insert into core.job (id, queue, data_class, idempotency_key, payload, run_after)
                               values (core.uuid7(), :q, :c, :k, cast(:p as jsonb), :t)
                               on conflict (queue, idempotency_key) do nothing returning 1""",
                            q=s.queue, c=s.data_class, k=minute_key(s.identity, t), p=json.dumps(s.payload), t=t)
            inserted += len(rows)
        conn.run("commit")
        return inserted, skipped
    except BaseException:
        conn.run("rollback")
        raise


def tick(conn, reg: Registry, now: datetime) -> dict:
    out = {"inserted": 0, "skipped": 0, "failed": 0}
    for s in reg.schedules:
        try:
            i, k = tick_one(conn, s, reg.timezone, now)
            out["inserted"] += i
            out["skipped"] += k
        except Exception as e:
            out["failed"] += 1
            log.error("schedule failed: identity=%s type=%s", s.identity, type(e).__name__)
    if out["skipped"]:
        log.warning("scheduler.skipped n=%d", out["skipped"])
    return out


def run_forever(reg: Registry, database: str, stop: threading.Event, alive_file: str | None = "/run/mandato/alive",
                clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc)) -> None:
    conn = connect(database, "scheduler")
    log.info("scheduler started: schedules=%d timezone=%s", len(reg.schedules), reg.timezone)
    try:
        while not stop.is_set():
            r = tick(conn, reg, clock())
            if r["inserted"] or r["failed"]:
                log.info("tick: inserted=%d failed=%d", r["inserted"], r["failed"])
            if alive_file:
                try:
                    Path(alive_file).touch()
                except OSError:
                    pass
            now = clock()
            stop.wait(60 - now.second - now.microsecond / 1e6 + 1)   # just after the next minute boundary
    finally:
        conn.close()


def main() -> None:   # pragma: no cover - exercised by the instance tests
    import argparse
    from .spec import load_runtime
    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", required=True, help="runtime.json written by `mandato instance up`; no module code runs here")
    ap.add_argument("--database", required=True)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    reg = load_runtime(a.runtime)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    run_forever(reg, a.database, stop)


if __name__ == "__main__":
    main()
