"""Connector runner, raw layer and takedown against Postgres (design 0003 §9). Needs TEST_DB (a database built by
packages/db/test/run.sh) and PG* env; MANDATO_REQUIRE_DB=1 turns a missing TEST_DB into a failure (CI database job)."""
import copy
import hashlib
import json
import os
import tempfile
import threading
import time
import unittest

from workers.core.connectors import raw as R
from workers.core.connectors.runner import Deps, run
from workers.core.connectors.takedown import takedown
from workers.core.contracts.classes import DataClass
from workers.core.fetch import policy as P
from workers.core.tests.fixtures.ref_connector import FIXTURES, HOST, ExemploItens, page

DB = os.environ.get("TEST_DB")
NEED = os.environ.get("MANDATO_REQUIRE_DB") == "1"


@unittest.skipUnless(DB or NEED, "TEST_DB not set")
class RunnerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DB:
            raise AssertionError("MANDATO_REQUIRE_DB=1 but TEST_DB is not set")
        from workers.core.connectors.db import connect
        cls.connect = staticmethod(connect)

    def setUp(self):
        self.su = self.connect(DB, os.environ.get("PGUSER", "postgres"))
        self.su.run("set session_replication_role = replica")
        self.su.run("delete from mod_hello.exemplo_item")
        self.su.run("delete from core.raw_object where source_id = 'exemplo-itens'")
        self.su.run("delete from core.suppression where source_id = 'exemplo-itens'")
        self.su.run("delete from core.data_source_run where source_id = 'exemplo-itens'")
        self.su.run("""insert into core.data_source (source_id, name, terms_url, cadence) values ('exemplo-itens','exemplo-itens','','0 6 * * *')
                       on conflict (source_id) do update set cursor = null, last_success_at = null""")
        self.su.run("delete from core.job where queue in ('core.connector_run','core.takedown')")
        self.su.run("set session_replication_role = origin")
        self.dir = tempfile.TemporaryDirectory()
        self.store = R.FsRawStore(self.dir.name)
        self.fixtures = copy.deepcopy(FIXTURES)
        self.connector = ExemploItens()

    def tearDown(self):
        self.su.close()
        self.dir.cleanup()

    def transport(self, ip, host, path_qs, headers, timeout, max_body):
        url = f"https://{host}{path_qs}"
        if path_qs == "/robots.txt":
            return 404, {}, b""
        hook = self.fixtures.get(url)
        if callable(hook):
            return hook()
        return hook

    def deps(self, **kw):
        d = Deps(database=DB, store=self.store, registry={"exemplo-itens": (self.connector, "hello")},
                 tenant_connectors={"exemplo-itens": {"source_id": "exemplo-itens", "params": {"uf": "EX"}}},
                 resolver=lambda h: ["8.8.8.8"], transport=self.transport,
                 bucket=lambda n: P.TokenBucket(n, clock=lambda: 0.0, sleep=lambda s: None), heartbeat_s=0.2)
        for k, v in kw.items():
            setattr(d, k, v)
        return d

    def claim(self, source="exemplo-itens"):
        w = self.connect(DB, "worker_c1")
        try:
            w.run("insert into core.job (id, queue, data_class, payload) values (core.uuid7(), 'core.connector_run', 'C1', cast(:p as jsonb))",
                  p=json.dumps({"source_id": source}))
            job_id, _, payload, token = w.run("select * from core.claim_job(array['core.connector_run'], 'test')")[0]
            return token, str(job_id), payload
        finally:
            w.close()

    def go(self, deps=None, source="exemplo-itens"):
        token, job_id, payload = self.claim(source)
        state = run(deps or self.deps(), token, job_id, payload)
        return state, job_id

    def q(self, sql, **kw):
        return self.su.run(sql, **kw)

    def last_run(self):
        return tuple(self.q("select status, error, stats from core.data_source_run where source_id = 'exemplo-itens' order by started_at desc, id desc limit 1")[0])

    # ------------------------------------------------------------------ ok path
    def test_ok_run_then_incremental_then_snapshot_delete(self):
        state, job = self.go()
        self.assertEqual(state, "done")
        status, error, stats = self.last_run()
        self.assertEqual((status, error), ("ok", None))
        self.assertEqual((stats["records"], stats["inserted"], stats["raw_objects"]), (3, 3, 2))
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item")[0][0], 3)
        cur, last = self.q("select cursor, last_success_at from core.data_source where source_id = 'exemplo-itens'")[0]
        self.assertEqual(cur, {"itens-EX": {"paginas": 2}})
        self.assertIsNotNone(last)
        self.assertEqual(self.q("select state from core.job where id = cast(:j as uuid)", j=job)[0][0], "done")
        self.assertEqual(self.q("select count(*) from core.raw_object where source_id = 'exemplo-itens'")[0][0], 2)
        # second run: nothing changes
        self.go()
        self.assertEqual(self.last_run()[2]["unchanged"], 3)
        # upstream removes item 3: snapshot sync deletes it
        self.fixtures[f"https://{HOST}/api/itens?pagina=2&uf=EX"] = page([], False)
        self.go()
        self.assertEqual(self.last_run()[2]["deleted"], 1)
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item")[0][0], 2)

    def test_writes_are_audited_with_the_job_as_actor(self):
        _, job = self.go()
        n = self.q("select count(*) from audit.event where entity = 'mod_hello.exemplo_item' and actor_kind = 'worker' and actor_id = :j", j=job)[0][0]
        self.assertEqual(n, 3)

    # ------------------------------------------------------------------ refusals before any write
    def test_refusals_before_any_write(self):
        state, _ = self.go(source="nao-existe")
        self.assertEqual(state, "dead")
        c2 = ExemploItens(); c2.manifest = {**ExemploItens.manifest, "data_class": DataClass.C2}
        self.connector = c2
        self.assertEqual(self.go()[0], "dead")
        self.connector = ExemploItens()
        self.assertEqual(self.go(self.deps(tenant_connectors={"exemplo-itens": {"params": {"uf": "ex"}}}))[0], "dead")
        self.assertEqual(self.q("select count(*) from core.data_source_run where source_id = 'exemplo-itens'")[0][0], 0)
        self.q("set session_replication_role = replica"); self.q("delete from core.data_source where source_id = 'exemplo-itens'")
        self.q("set session_replication_role = origin")
        state, job = self.go()
        self.assertEqual((state, self.q("select last_error from core.job where id = cast(:j as uuid)", j=job)[0][0]),
                         ("dead", "source_not_provisioned"))

    # ------------------------------------------------------------------ rejected and failed
    def test_validation_failure_is_rejected_and_keeps_raw(self):
        self.go()
        cursor = self.q("select cursor from core.data_source where source_id = 'exemplo-itens'")[0][0]
        self.fixtures[f"https://{HOST}/api/itens?pagina=1&uf=EX"] = page([{"id": 1, "nome": "  ", "valor": 1}], False)
        state, job = self.go()
        self.assertEqual(state, "queued")
        status, error, stats = self.last_run()
        self.assertEqual((status, error, stats["codes"]), ("rejected", "validation", {"missing_field": 1}))
        self.assertEqual(self.q("select cursor from core.data_source where source_id = 'exemplo-itens'")[0][0], cursor)
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item")[0][0], 3)
        run_id = self.q("select id from core.data_source_run where source_id='exemplo-itens' order by started_at desc, id desc limit 1")[0][0]
        self.assertEqual(self.q("select count(*) from core.raw_object where run_id = :r", r=run_id)[0][0], 1)

    def test_database_error_in_upsert_fails_with_nothing_written(self):
        class BadType(ExemploItens):
            def normalize(self, raw):
                return [dict(r, valor="não-é-número") for r in super().normalize(raw)]
        self.connector = BadType()
        state, _ = self.go()
        self.assertEqual(state, "queued")
        self.assertEqual(self.last_run()[:2], ("failed", "internal"))
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item")[0][0], 0)
        self.assertIsNone(self.q("select cursor from core.data_source where source_id = 'exemplo-itens'")[0][0])
        self.assertEqual(self.q("select count(*) from core.raw_object where source_id = 'exemplo-itens'")[0][0], 2)

    def test_forged_raw_ref_fails(self):
        class Forged(ExemploItens):
            def fetch(self, resource, cursor, ctx):
                b = super().fetch(resource, cursor, ctx); b["raw_refs"] = ["ab" * 32]; return b
        self.connector = Forged()
        self.go()
        self.assertEqual(self.last_run()[:2], ("failed", "internal"))

    def test_run_size_limits(self):
        class Many(ExemploItens):
            def discover(self, ctx):
                return [{"id": str(i), "url": f"https://{HOST}/api/itens"} for i in range(1001)]
        self.connector = Many()
        self.go()
        self.assertEqual(self.last_run()[:2], ("failed", "run_too_large"))

    # ------------------------------------------------------------------ concurrency
    def test_busy_source_and_cursor_compare_and_set(self):
        holder = self.connect(DB, "worker_c1")
        holder.run("select pg_advisory_lock(hashtext('core.connector_run'), hashtext('exemplo-itens'))")
        try:
            state, job = self.go()
            self.assertEqual(state, "done")
            self.assertEqual(self.q("select count(*) from core.data_source_run where source_id='exemplo-itens'")[0][0], 0)
        finally:
            holder.close()

        def advance():   # another run advanced the cursor while this one collected
            self.q("set session_replication_role = replica")
            self.q("update core.data_source set cursor = '{\"itens-EX\": {\"paginas\": 9}}' where source_id = 'exemplo-itens'")
            self.q("set session_replication_role = origin")
        state, _ = self.go(self.deps(hooks={"lock": lambda: True, "before_tx2": advance}))
        self.assertEqual(self.last_run()[:2], ("failed", "cursor_conflict"))
        self.assertEqual(self.q("select cursor from core.data_source where source_id='exemplo-itens'")[0][0], {"itens-EX": {"paginas": 9}})
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item")[0][0], 0)

    # ------------------------------------------------------------------ heartbeat and lease
    def test_heartbeat_keeps_a_long_fetch_alive(self):
        url = f"https://{HOST}/api/itens?pagina=1&uf=EX"
        first = self.fixtures[url]
        seen = {}

        def slow():
            self.q("update core.job set locked_at = now() - interval '20 minutes' where queue = 'core.connector_run' and state = 'running'")
            time.sleep(0.8)
            w = self.connect(DB, "worker_c1")
            seen["reclaimed"] = w.run("select core.reclaim_jobs()")[0][0]
            w.close()
            return first
        self.fixtures[url] = slow
        state, _ = self.go()
        self.assertEqual((state, seen["reclaimed"]), ("done", 0))

    def test_lost_lease_aborts_before_writing(self):
        url = f"https://{HOST}/api/itens?pagina=1&uf=EX"
        first = self.fixtures[url]

        def steal():
            self.q("update core.job set lease_hash = null where queue = 'core.connector_run' and state = 'running'")
            time.sleep(0.6)
            return first
        self.fixtures[url] = steal
        state, _ = self.go()
        self.assertEqual(state, "lease_lost")
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item")[0][0], 0)

    def test_next_run_closes_an_orphaned_run(self):
        self.q("set session_replication_role = replica")
        self.q("insert into core.data_source_run (id, source_id, status) values (core.uuid7(), 'exemplo-itens', 'running')")
        self.q("set session_replication_role = origin")
        self.go()
        self.assertEqual(self.q("select count(*) from core.data_source_run where source_id='exemplo-itens' and status='running'")[0][0], 0)
        self.assertEqual(self.q("select count(*) from core.data_source_run where error='lease_expired'")[0][0], 1)

    # ------------------------------------------------------------------ raw layer
    def test_raw_dedup_prune_and_orphan_sweep(self):
        self.go(); self.go()
        shas = {r[0] for r in self.q("select sha256 from core.raw_object where source_id='exemplo-itens'")}
        self.assertEqual(len(shas), 2)
        self.assertEqual(len(self.store.keys()), 2, "identical bodies are stored once")
        self.q("set session_replication_role = replica")
        self.q("update core.raw_object set fetched_at = now() - interval '400 days' where source_id='exemplo-itens'")
        self.q("set session_replication_role = origin")
        self.go()   # prune runs at the start of the run, then the run records fresh rows
        self.assertEqual(self.q("select count(*) from core.raw_object where fetched_at < now() - interval '1 day'")[0][0], 0)
        self.assertEqual(len(self.store.keys()), 2, "blobs referenced by the new rows stay")
        orphan = b"orphan"; sha = hashlib.sha256(orphan).hexdigest(); self.store.put(sha, orphan)
        w = self.connect(DB, "worker_c1")
        self.assertEqual(R.sweep_orphans(w, self.store, now=time.time() + 90_000), 1)
        w.close()
        self.assertFalse(self.store.exists(f"sha256/{sha}"))

    def test_writer_and_deleter_of_the_same_blob_never_leave_a_dangling_row(self):
        body = b"compartilhado"; sha = hashlib.sha256(body).hexdigest()
        self.go()
        run_id = self.q("select id from core.data_source_run where source_id='exemplo-itens' limit 1")[0][0]
        self.q("update core.job set state='running', lease_hash=sha256(decode(repeat('ef',32),'hex')) where queue='core.connector_run' and id=(select job_id from core.data_source_run where id=:r)", r=run_id)
        deleter = self.connect(DB, "worker_c1")
        deleter.run("begin")
        deleter.run(R.LOCK, s=sha)           # deleter holds the lock and has seen no row
        writer = self.connect(DB, "worker_c1")
        rec = R.Recorder(writer, self.store, "ef" * 32, str(run_id), "exemplo-itens")
        t = threading.Thread(target=lambda: rec("h.gov.br", "/x", body, None))
        t.start(); time.sleep(0.3)            # writer has put the blob and now waits on the lock
        self.store.delete(f"sha256/{sha}")    # deleter deletes the blob, then commits
        deleter.run("commit"); deleter.close()
        t.join(5); writer.close()
        self.assertEqual(self.q("select count(*) from core.raw_object where sha256 = :s", s=sha)[0][0], 1)
        self.assertTrue(self.store.exists(f"sha256/{sha}"), "the writer re-put the blob under the lock")

    # ------------------------------------------------------------------ takedown
    def test_takedown_deletes_suppresses_and_audits(self):
        self.go()
        sha = self.q("select sha256 from core.raw_object where source_id='exemplo-itens' order by fetched_at limit 1")[0][0]
        audited = lambda: self.q("select count(*) from audit.event where action = 'takedown_takedown' and details = '{\"count\": 1}'")[0][0]
        before = audited()
        r = takedown(DB, self.store, ExemploItens.manifest, ["2"], "takedown", [sha])
        self.assertEqual(r["rows"], 1)
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item where codigo = '2'")[0][0], 0)
        self.assertEqual(audited(), before + 1)
        self.assertEqual(self.q("select count(*) from core.raw_object where sha256 = :s", s=sha)[0][0], 0)
        self.assertFalse(self.store.exists(f"sha256/{sha}"))
        self.go()
        self.assertEqual(self.last_run()[2]["suppressed"], 1)
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item where codigo = '2'")[0][0], 0, "it does not come back")
        takedown(DB, self.store, ExemploItens.manifest, ["2"], "takedown", lift=True)
        self.go()
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item where codigo = '2'")[0][0], 1)

    def test_incremental_removal_deletes_the_row(self):
        class Incr(ExemploItens):
            manifest = {**ExemploItens.manifest, "sync": "incremental", "deleted_column": "removido"}
            def normalize(self, raw):
                return [dict(r, removido=r["codigo"] == "3" and self.drop) for r in super().normalize(raw)]
            drop = False
        self.connector = Incr()
        self.go()
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item")[0][0], 3)
        self.q("set session_replication_role = replica"); self.q("update core.data_source set cursor = null where source_id='exemplo-itens'")
        self.q("set session_replication_role = origin")
        Incr.drop = True
        self.go()
        self.assertEqual(self.q("select count(*) from mod_hello.exemplo_item where codigo = '3'")[0][0], 0)
        self.assertEqual(self.last_run()[2]["deleted"], 1)


if __name__ == "__main__":
    unittest.main()
