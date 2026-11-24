"""Runtime pieces without a database (design 0004 §4, §5): heartbeat loss, the data-only runtime spec.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import json
import tempfile
import threading
import unittest
from pathlib import Path

from workers.core.runtime import spec as S
from workers.core.runtime.registry import load_registry, runtime_doc
from workers.core.runtime.worker import MAX_MISSED_BEATS, JobHeartbeat

RT = Path(__file__).resolve().parent / "fixtures" / "rt_tenant"


class FakeConn:
    def __init__(self, error=None):
        self.error, self.calls = error, 0

    def run(self, sql, **kw):
        self.calls += 1
        if self.error:
            raise self.error

    def close(self):
        pass


class HeartbeatTest(unittest.TestCase):
    def beat(self, connect_fn):
        lost = threading.Event()
        hb = JobHeartbeat("db", "worker_c1", "t", 0.01, on_lost=lost.set, connect_fn=connect_fn)
        hb.start()
        hb.join(5)
        self.addCleanup(hb.stop)
        return hb, lost

    def test_a_refused_lease_is_lost_at_once(self):
        conn = FakeConn(RuntimeError("job: invalid lease"))
        hb, lost = self.beat(lambda *a: conn)
        self.assertTrue(hb.lost.is_set() and lost.is_set())
        self.assertEqual(conn.calls, 1)

    def test_repeated_failures_are_lost_after_the_allowed_misses(self):
        conn = FakeConn(OSError("network"))
        hb, lost = self.beat(lambda *a: conn)
        self.assertTrue(lost.is_set())
        self.assertEqual(conn.calls, MAX_MISSED_BEATS)

    def test_a_heartbeat_that_cannot_connect_is_lost_not_silent(self):
        def refuse(*a):
            raise OSError("refused")
        hb, lost = self.beat(refuse)
        self.assertTrue(lost.is_set(), "the thread must not die without marking the lease lost")

    def test_a_stopped_heartbeat_does_not_fire(self):
        lost = threading.Event()
        hb = JobHeartbeat("db", "worker_c1", "t", 60, on_lost=lost.set, connect_fn=lambda *a: FakeConn())
        hb.start(); hb.stop()
        self.assertFalse(lost.is_set())


class RuntimeSpecTest(unittest.TestCase):
    def write(self, doc):
        f = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(doc, f); f.close()
        return f.name

    def doc(self):
        return json.loads(json.dumps(runtime_doc(load_registry(RT / "instance.json", RT))))

    def test_round_trip_matches_the_registry(self):
        reg = load_registry(RT / "instance.json", RT)
        spec = S.load_runtime(self.write(self.doc()))
        self.assertEqual([(s.identity, s.queue, s.data_class, s.payload) for s in spec.schedules],
                         [(s.identity, s.queue, s.data_class, s.payload) for s in reg.schedules])
        self.assertEqual(spec.timezone, reg.timezone)

    def test_forged_schedules_are_refused(self):
        cases = [
            {"identity": "mod:rt.x", "queue": "core.takedown", "data_class": "C1", "cron": "* * * * *", "payload": {}},
            {"identity": "mod:rt.x", "queue": "other.job", "data_class": "C1", "cron": "* * * * *", "payload": {}},
            {"identity": "conn:nao-existe", "queue": "core.connector_run", "data_class": "C1", "cron": "* * * * *",
             "payload": {"source_id": "nao-existe"}},
            {"identity": "mod:rt.x", "queue": "rt.ok", "data_class": "C9", "cron": "* * * * *", "payload": {}},
            {"identity": "mod:rt.x", "queue": "rt.ok", "data_class": "C1", "cron": "61 * * * *", "payload": {}},
            {"identity": "mod:rt.x", "queue": "rt.ok", "data_class": "C1", "cron": "* * * * *", "payload": {"x": "y" * 5000}},
        ]
        for s in cases:
            d = self.doc(); d["schedules"] = [s]
            with self.assertRaises(S.SpecError, msg=s):
                S.load_runtime(self.write(d))

    def test_connector_manifest_is_checked_and_reduced(self):
        m = {"source_id": "exemplo-itens", "data_class": "C0", "hosts": ["dados.exemplo.gov.br"], "rate_limit_per_min": 60,
             "auth": "none", "auth_secret_ref": None, "auth_header": None, "anything": "dropped"}
        d = self.doc(); d["connectors"] = {"exemplo-itens": m}
        d["schedules"].append({"identity": "conn:exemplo-itens", "queue": "core.connector_run", "data_class": "C0",
                               "cron": "0 6 * * *", "payload": {"source_id": "exemplo-itens"}})
        spec = S.load_runtime(self.write(d))
        self.assertNotIn("anything", spec.connectors["exemplo-itens"])
        for bad in ({"hosts": ["10.0.0.1"]}, {"hosts": []}, {"data_class": "C2"}, {"rate_limit_per_min": 10**6},
                    {"auth": "api_key", "auth_secret_ref": "../etc/passwd", "auth_header": "X-Key"},
                    {"source_id": "outra"}):
            d2 = json.loads(json.dumps(d)); d2["connectors"]["exemplo-itens"].update(bad)
            with self.assertRaises(S.SpecError, msg=bad):
                S.load_runtime(self.write(d2))

    def test_unknown_timezone_is_refused(self):
        d = self.doc(); d["timezone"] = "Mars/Olympus"
        with self.assertRaises(S.SpecError):
            S.load_runtime(self.write(d))


if __name__ == "__main__":
    unittest.main()
