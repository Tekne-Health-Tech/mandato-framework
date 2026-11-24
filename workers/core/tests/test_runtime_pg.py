"""Worker loop and scheduler against Postgres (design 0004 §10). Runs when TEST_DB is set.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import os
import signal
import subprocess
import sys
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB = os.environ.get("TEST_DB")
ROOT = Path(__file__).resolve().parents[3]
RT = Path(__file__).resolve().parent / "fixtures" / "rt_tenant"
UTC = timezone.utc


@unittest.skipUnless(DB or os.environ.get("MANDATO_REQUIRE_DB"), "database part: TEST_DB")
class RuntimePg(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DB:
            raise AssertionError("MANDATO_REQUIRE_DB is set but TEST_DB is not")
        from workers.core.connectors.db import connect
        from workers.core.runtime.registry import load_registry
        cls.connect = staticmethod(connect)
        cls.reg = load_registry(RT / "instance.json", RT)
        cls.su = connect(DB, "postgres")

    @classmethod
    def tearDownClass(cls):
        cls.su.close()

    def setUp(self):
        self.su.run("update core.job set state = 'done', lease_hash = null where state in ('queued', 'running')")

    def enq(self, queue, payload="{}", data_class="C1", run_after=None):
        return self.su.run(
            """insert into core.job (id, queue, data_class, payload, run_after) values (core.uuid7(), :q, :c, cast(:p as jsonb),
               coalesce(cast(:t as timestamptz), now())) returning id::text""", q=queue, c=data_class, p=payload, t=run_after)[0][0]

    def job(self, jid):
        return self.su.run("select state, last_error, attempts from core.job where id = cast(:i as uuid)", i=jid)[0]

    def worker(self, **kw):
        from workers.core.runtime.worker import Worker
        w = Worker(self.reg, "c1", DB, alive_file=None, heartbeat_s=kw.pop("heartbeat_s", 60), **kw)
        w.conn = self.connect(DB, "worker_c1")
        self.addCleanup(w.conn.close)
        return w

    # ------------------------------------------------------------ registry
    def test_registry_pools_queues_and_schedules(self):
        self.assertEqual(self.reg.pools(), ["c1", "c2"])
        self.assertIn("rt.ok", self.reg.queues("c1"))
        self.assertNotIn("rt.c2", self.reg.queues("c1"))
        self.assertEqual(self.reg.queues("c2"), ["core.noop", "rt.c2"])
        self.assertNotIn("core.takedown", self.reg.queues("c1"))
        self.assertEqual([s.identity for s in self.reg.schedules], ["mod:rt.every_minute"])

    # ------------------------------------------------------------ worker loop
    def test_outcomes_follow_finish_job(self):
        w = self.worker()
        cases = {"rt.ok": ("done", None), "rt.fail_text": ("queued", "job_failed"), "rt.fail_code": ("queued", "upstream_down"),
                 "rt.raises": ("queued", "internal"), "rt.none_result": ("queued", "bad_result"),
                 "rt.secret": ("queued", "internal"), "core.noop": ("done", None)}
        for q, (state, err) in cases.items():
            jid = self.enq(q)
            self.assertTrue(w.step(), q)
            self.assertEqual(self.job(jid)[:2], [state, err], q)

    def test_claims_only_its_pool_and_queues(self):
        w = self.worker()
        c2 = self.enq("rt.c2", data_class="C2")
        other = self.enq("zz.unknown")
        self.assertFalse(w.step())
        self.assertEqual(self.job(c2)[0], "queued")
        self.assertEqual(self.job(other)[0], "queued")

    def test_connector_job_without_fetch_mode_is_refused(self):
        w = self.worker(connector_run=None)
        jid = self.enq("core.connector_run", '{"source_id": "ibge-municipios"}')
        w.step()
        self.assertEqual(self.job(jid)[:2], ["queued", "fetch_unconfigured"])

    def test_heartbeat_keeps_a_long_job_from_reclaim(self):
        w = self.worker(heartbeat_s=0.2)
        jid = self.enq("rt.sleep", '{"s": 1.5}')
        t = threading.Thread(target=w.step)
        t.start()
        time.sleep(0.5)
        self.su.run("update core.job set locked_at = now() - interval '12 minutes' where id = cast(:i as uuid)", i=jid)
        time.sleep(0.5)   # at least one heartbeat after the backdating
        rc = self.connect(DB, "worker_c1")
        try:
            self.assertEqual(rc.run("select core.reclaim_jobs()")[0][0], 0)
        finally:
            rc.close()
        t.join(5)
        self.assertEqual(self.job(jid)[0], "done")

    def test_reclaim_runs_from_the_loop(self):
        w = self.worker()
        jid = self.enq("rt.ok")
        self.su.run("update core.job set state = 'running', locked_at = now() - interval '20 minutes', lease_hash = '\\x00'"
                    " where id = cast(:i as uuid)", i=jid)
        w.step()   # first step reclaims, then claims the requeued job and runs it
        self.assertEqual(self.job(jid)[0], "done")

    def _spawn(self):
        env = {**os.environ, "PYTHONPATH": str(ROOT)}
        p = subprocess.Popen([sys.executable, "-m", "workers.core.runtime.worker", "--pool", "c1",
                              "--instance", str(RT / "instance.json"), "--tenant-root", str(RT), "--database", DB],
                             cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        self.addCleanup(lambda: (p.poll() is None and p.kill(), p.wait(5)))   # never leave a worker behind
        return p

    def _wait_state(self, jid, state, timeout=10, error=None):
        end = time.time() + timeout
        while time.time() < end:
            j = self.job(jid)
            if j[0] == state and (error is None or j[1] == error):
                return True
            time.sleep(0.1)
        return False

    def test_sigterm_lets_the_running_job_finish(self):
        jid = self.enq("rt.sleep", '{"s": 2}')
        p = self._spawn()
        self.assertTrue(self._wait_state(jid, "running"))
        p.send_signal(signal.SIGTERM)
        self.assertEqual(p.wait(15), 0)
        self.assertEqual(self.job(jid)[0], "done")
        out = p.stdout.read().decode()
        p.stdout.close()
        self.assertIn("worker stopped", out)

    def test_sigkill_mid_transaction_leaves_nothing_and_is_reclaimed(self):
        codigo = f"rt-{time.time_ns()}"
        jid = self.enq("rt.tx_sleep", f'{{"codigo": "{codigo}", "s": 30}}')
        p = self._spawn()
        self.assertTrue(self._wait_state(jid, "running"))
        time.sleep(1)
        p.kill()
        p.wait(5)
        time.sleep(0.5)   # the server notices the dropped connection and rolls back
        self.assertEqual(self.su.run("select count(*) from mod_hello.exemplo_item where codigo = :c", c=codigo)[0][0], 0)
        self.su.run("update core.job set locked_at = now() - interval '20 minutes' where id = cast(:i as uuid)", i=jid)
        rc = self.connect(DB, "worker_c1")
        try:
            self.assertEqual(rc.run("select core.reclaim_jobs()")[0][0], 1)
        finally:
            rc.close()
        self.assertEqual(self.job(jid)[:2], ["queued", "lease_expired"])
        p.stdout.close()

    def test_the_raised_value_never_reaches_the_log(self):
        jid = self.enq("rt.raises")
        p = self._spawn()
        try:
            self.assertTrue(self._wait_state(jid, "queued", 10, error="internal"))
        finally:
            p.send_signal(signal.SIGTERM)
            p.wait(15)
        out = p.stdout.read().decode()
        p.stdout.close()
        self.assertIn("type=RuntimeError", out)
        self.assertNotIn("secret value", out)

    # ------------------------------------------------------------ scheduler
    def _sched_conn(self):
        c = self.connect(DB, "scheduler")
        self.addCleanup(c.close)
        return c

    def _count(self, prefix):
        return self.su.run("select count(*) from core.job where left(idempotency_key, length(:p)) = :p", p=prefix)[0][0]

    def test_two_schedulers_enqueue_each_minute_once(self):
        from workers.core.runtime.scheduler import tick
        self.su.run("delete from core.job where left(idempotency_key, 6) = 'sched:'")
        now = datetime(2026, 11, 24, 12, 0, 30, tzinfo=UTC)
        a, b = self._sched_conn(), self._sched_conn()
        ra, rb = tick(a, self.reg, now), tick(b, self.reg, now)
        self.assertEqual(ra["inserted"] + rb["inserted"], 1)   # a new schedule starts at the current minute
        self.assertEqual(self._count("sched:mod:rt.every_minute:"), 1)
        later = now + timedelta(minutes=3)
        results = []
        ts = [threading.Thread(target=lambda c=c: results.append(tick(c, self.reg, later))) for c in (a, b)]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        self.assertEqual(sum(r["inserted"] for r in results), 3)
        self.assertEqual(sum(r["failed"] for r in results), 0)
        self.assertEqual(self._count("sched:mod:rt.every_minute:"), 4)
        self.assertEqual(self._count("sched:mod:rt.off:"), 0)   # disabled by the tenant override

    def test_catch_up_is_capped_and_skips_are_counted(self):
        from workers.core.runtime.scheduler import tick
        self.su.run("delete from core.job where left(idempotency_key, 6) = 'sched:'")
        t0 = datetime(2026, 11, 24, 6, 0, tzinfo=UTC)
        c = self._sched_conn()
        tick(c, self.reg, t0)
        r = tick(c, self.reg, t0 + timedelta(hours=3))
        self.assertEqual(r["inserted"], 60)
        self.assertEqual(r["skipped"], 180 - 60)
        self.assertEqual(self.su.run("select data_class from core.job where left(idempotency_key, 6) = 'sched:' limit 1")[0][0], "C1")


if __name__ == "__main__":
    unittest.main()
