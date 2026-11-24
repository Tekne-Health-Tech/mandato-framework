"""Connector runner: the `core.connector_run` job (design 0003 §5).

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import hashlib
import os
import json
import logging
import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from workers.core.contracts.classes import DataClass
from workers.core.fetch import policy as P
from workers.core.fetch.client import FetchClient, resolve, tls_transport

from . import raw as R
from .db import connect, tx
from .loader import MAX_RECORDS, MAX_RESOURCES, ConnectorRefused, check_connector, check_records
from .upsert import delete_keys, delete_missing, table_columns, upsert_rows

QUEUE = "core.connector_run"
log = logging.getLogger("mandato.connectors")


class CursorConflict(Exception):
    code = "cursor_conflict"


def key_sha256(values: list) -> str:
    return hashlib.sha256(json.dumps(values, separators=(",", ":"), ensure_ascii=False, default=str).encode()).hexdigest()


@dataclass
class Deps:
    database: str
    store: R.RawStore
    registry: dict[str, tuple[Any, str]]  # source_id -> (connector, module short)
    tenant_connectors: dict[str, dict]  # source_id -> tenant.yaml connectors[] entry
    secret: Callable[[str], str] = lambda ref: (_ for _ in ()).throw(KeyError(ref))
    resolver: Callable = resolve
    transport: Callable = tls_transport
    bucket: Callable[[int], P.TokenBucket] = lambda n: P.TokenBucket(n)
    budget: Callable[[], P.RunBudget] = P.RunBudget
    heartbeat_s: float = 60.0
    user: str = "worker_c1"
    hooks: dict[str, Callable] = field(default_factory=dict)  # test seams: "before_tx2", "lock" (bypass advisory lock)


class Ctx:
    def __init__(self, source_id: str, params: dict, http: FetchClient):
        self.source_id, self.params, self._http = source_id, params, http

    def http(self) -> FetchClient:
        return self._http


class Heartbeat(threading.Thread):
    def __init__(self, deps: Deps, token: str):
        super().__init__(daemon=True)
        self.deps, self.token = deps, token
        self.stop_ev, self.lost = threading.Event(), threading.Event()

    def run(self) -> None:
        conn = connect(self.deps.database, self.deps.user)
        try:
            while not self.stop_ev.wait(self.deps.heartbeat_s):
                try:
                    conn.run("select core.heartbeat_job(:t)", t=self.token)
                except Exception:
                    self.lost.set()
                    return
        finally:
            conn.close()


def _finish(conn, token: str, ok: bool, code: str | None) -> str:
    return conn.run("select core.finish_job(:t, :o, :e)", t=token, o=ok, e=code)[0][0]


def run(deps: Deps, token: str, job_id: str, payload: dict) -> str:
    """Runs one claimed job to its end; returns the job's new state."""
    conn = connect(deps.database, deps.user)
    hb = Heartbeat(deps, token)
    hb.start()
    try:
        return _run(deps, conn, hb, token, job_id, payload)
    finally:
        hb.stop_ev.set()
        hb.join(5)
        conn.close()


def _run(deps: Deps, conn, hb: Heartbeat, token: str, job_id: str, payload: dict) -> str:
    source_id = payload.get("source_id") if isinstance(payload, dict) else None
    entry = deps.registry.get(source_id) if isinstance(source_id, str) else None
    tenant = deps.tenant_connectors.get(source_id) if entry else None
    if not entry or tenant is None:
        return _finish(conn, token, False, "unknown_source")
    connector, short = entry
    try:
        check_connector(connector, short, tenant.get("params"))
        if connector.manifest["source_id"] != source_id:
            raise ConnectorRefused("invalid_manifest", "source_id")
    except ConnectorRefused as e:
        log.warning("connector refused: source=%s code=%s", source_id, e.code)
        return _finish(conn, token, False, e.code)
    m = connector.manifest

    lock = deps.hooks.get("lock", lambda: conn.run("select pg_try_advisory_lock(hashtext('core.connector_run'), hashtext(:s))",
                                                    s=source_id)[0][0])
    if not lock():
        log.info("source busy: source=%s", source_id)
        return _finish(conn, token, True, None)
    try:
        if not conn.run("select 1 from core.data_source where source_id = :s", s=source_id):
            return _finish(conn, token, False, "source_not_provisioned")
        with tx(conn, token) as c:   # tx 1
            row = c.run("select cursor from core.data_source where source_id = :s for update", s=source_id)
            c.run("""update core.data_source_run r set status = 'failed', error = 'lease_expired', finished_at = now()
                      where r.source_id = :s and r.status = 'running'
                        and not exists (select 1 from core.job j where j.id = r.job_id and j.state = 'running')""", s=source_id)
            c.run("""update core.data_source set name = :n, terms_url = :u where source_id = :s
                      and (name is distinct from :n or terms_url is distinct from :u)""", s=source_id, n=m["name"], u=m["terms_url"])
            run_id = c.run("""insert into core.data_source_run (id, source_id, job_id) values (core.uuid7(), :s, :j)
                              returning id""", s=source_id, j=job_id)[0][0]
            cursor_before = row[0][0]
        try:   # retention runs here, while the lease is valid (tx 2 finishes the job); a failure leaves the run going
            R.prune(conn, deps.store, token, source_id, int(tenant.get("raw_retention_days", 180)))
        except Exception as e:
            log.warning("prune failed: source=%s type=%s", source_id, type(e).__name__)
        return _collect_and_apply(deps, conn, hb, token, connector, source_id, tenant, str(run_id), cursor_before)
    finally:
        if "lock" not in deps.hooks:
            conn.run("select pg_advisory_unlock(hashtext('core.connector_run'), hashtext(:s))", s=source_id)


def _lease_gone(e: Exception) -> bool:
    return "audit: invalid lease" in str(e) or "job: invalid lease" in str(e)


def _fail(conn, token, run_id, code) -> str:
    try:
        with tx(conn, token) as c:   # tx 3
            c.run("update core.data_source_run set status = 'failed', error = :e, finished_at = now() where id = :r", e=code, r=run_id)
            return _finish(c, token, False, code)
    except Exception as e:
        if _lease_gone(e):   # nothing can be written without the lease; the next run closes this one
            return "lease_lost"
        raise


def _collect_and_apply(deps, conn, hb, token, connector, source_id, tenant, run_id, cursor_before) -> str:
    m = connector.manifest
    recorder = R.Recorder(conn, deps.store, token, run_id, source_id)
    client = FetchClient(m, recorder, secret=deps.secret, resolver=deps.resolver, transport=deps.transport,
                         bucket=deps.bucket(m["rate_limit_per_min"]), budget=deps.budget(), alive=lambda: not hb.lost.is_set())
    ctx = Ctx(source_id, tenant.get("params") or {}, client)
    cursors = dict(cursor_before or {})
    records, issues = [], []
    try:
        resources = connector.discover(ctx)
        if len(resources) > MAX_RESOURCES:
            raise P.FetchRefused("run_too_large")
        for res in resources:
            batch = connector.fetch(res, cursors.get(res["id"]), ctx)
            if not set(batch.get("raw_refs", [])) <= recorder.refs:
                raise P.FetchRefused("internal", "raw_ref")
            recs = connector.normalize(batch)
            if len(records) + len(recs) > MAX_RECORDS:
                raise P.FetchRefused("run_too_large")
            issues += connector.validate(recs)["errors"]
            records += recs
            cursors[res["id"]] = batch["cursor"]
        issues += check_records(records, m["natural_key"], m["deleted_column"])
        if records and not issues:
            cols = table_columns(conn, m["target_table"])
            if not set(records[0]) - ({m["deleted_column"]} if m["deleted_column"] else set()) <= cols:
                issues.append({"code": "unknown_column", "path": "records[0]"})
        if hb.lost.is_set():
            raise P.FetchRefused("lease_lost")
        deps.hooks.get("before_tx2", lambda: None)()
        if issues:
            codes = {}
            for i in issues:
                codes[i["code"]] = codes.get(i["code"], 0) + 1
            for i in issues[:20]:
                log.warning("validation: source=%s code=%s path=%s", source_id, i["code"], i["path"])
            with tx(conn, token) as c:   # tx 2, rejected
                c.run("""update core.data_source_run set status = 'rejected', error = 'validation', finished_at = now(),
                          stats = cast(:st as jsonb) where id = :r""",
                      r=run_id, st=json.dumps({"records": len(records), "errors": len(issues), "codes": codes}))
                state = _finish(c, token, False, "validation")
            return state
        stats = _apply(deps, conn, token, m, source_id, run_id, records, cursors, cursor_before, len(recorder.refs))
    except (P.FetchRefused, ConnectorRefused, CursorConflict) as e:
        log.warning("run failed: source=%s code=%s", source_id, e.code)
        if e.code == "lease_lost":   # the lease is gone: nothing can be written; the next run closes this one
            return "lease_lost"
        return _fail(conn, token, run_id, e.code)
    except Exception as e:   # record values never reach the log: type and code only
        if hb.lost.is_set() or _lease_gone(e):
            log.warning("run failed: source=%s code=lease_lost", source_id)
            return "lease_lost"
        log.error("run failed: source=%s code=internal type=%s", source_id, type(e).__name__)
        log.debug("internal detail", exc_info=os.environ.get("MANDATO_DEBUG") == "1")
        return _fail(conn, token, run_id, "internal")
    return stats["state"]


def _apply(deps, conn, token, m, source_id, run_id, records, cursors, cursor_before, raw_objects) -> dict:
    nk, dc = m["natural_key"], m["deleted_column"]
    with tx(conn, token) as c:   # tx 2, one transaction
        sup = {r[0] for r in c.run("select key_sha256 from core.suppression where source_id = :s and lifted_at is null", s=source_id)}
        kept = [r for r in records if key_sha256([r[k] for k in nk]) not in sup]
        suppressed = len(records) - len(kept)
        removed = [r for r in kept if dc and r[dc]]
        live = [{k: v for k, v in r.items() if k != dc} for r in kept if not (dc and r[dc])]
        st = upsert_rows(c, m["target_table"], live, nk) if live else {"inserted": 0, "updated": 0, "unchanged": 0}
        deleted = delete_keys(c, m["target_table"], nk, [tuple(r[k] for k in nk) for r in removed]) if removed else 0
        if m["sync"] == "snapshot":
            deleted += delete_missing(c, m["target_table"], nk, [tuple(r[k] for k in nk) for r in live])
        n = c.run("""update core.data_source set cursor = cast(:new as jsonb), last_success_at = now()
                      where source_id = :s and cursor is not distinct from cast(:old as jsonb) returning 1""",
                  s=source_id, new=json.dumps(cursors), old=None if cursor_before is None else json.dumps(cursor_before))
        if not n:
            raise CursorConflict()
        stats = {"records": len(records), **st, "deleted": deleted, "suppressed": suppressed, "raw_objects": raw_objects}
        c.run("""update core.data_source_run set status = 'ok', finished_at = now(), stats = cast(:st as jsonb) where id = :r""",
              r=run_id, st=json.dumps(stats))
        stats["state"] = _finish(c, token, True, None)
    return stats
