"""Takedown of a normalized record (design 0003 §4): delete it, suppress it for good, optionally drop its raw objects.

    python -m workers.core.connectors.takedown --db <database> --tenant <tenantDir> --raw-dir <dir> \
        --source <source_id> --key '<natural key values as a JSON list>' --reason takedown|error|legal [--sha256 <hex> ...]
    ... --lift   lifts the suppression instead (audited as takedown_lift)

Runs as worker_c1 under the lease of its own job (queue core.takedown), so every write is audited with that job as actor.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import argparse
import json
import re
import secrets
import sys

from . import raw as R
from .db import connect, tx
from .runner import key_sha256
from .upsert import delete_keys

REASONS = ("takedown", "error", "legal")


def takedown(database: str, store: R.RawStore, manifest: dict, key: list, reason: str, shas: list[str] = (),
             lift: bool = False, user: str = "worker_c1") -> dict:
    if reason not in REASONS and not lift:
        raise ValueError("reason")
    if not isinstance(key, list) or len(key) != len(manifest["natural_key"]):
        raise ValueError("key")
    if any(not re.fullmatch(r"[0-9a-f]{64}", s) for s in shas):
        raise ValueError("sha256")
    source_id, table = manifest["source_id"], manifest["target_table"]
    conn = connect(database, user)
    try:
        # A queue of its own (core.td_<random>): the claim can only return this invocation's job, never a pending
        # takedown of another source, so the lease and the audit actor are exactly this command's (design 0003 §4).
        queue = f"core.td_{secrets.token_hex(16)}"
        job_id = conn.run("""insert into core.job (id, queue, data_class, payload) values (core.uuid7(), :q, 'C1', '{}')
                             returning id""", q=queue)[0][0]
        claimed = conn.run("select job_id, lease_token from core.claim_job(array[:q], 'takedown')", q=queue)
        if not claimed or claimed[0][0] != job_id:
            raise RuntimeError("takedown: own job not claimed")
        token = claimed[0][1]
        h = key_sha256(key)
        with tx(conn, token) as c:
            if lift:
                n = len(c.run("""update core.suppression set lifted_at = now() where source_id = :s and key_sha256 = :h
                                  and lifted_at is null returning 1""", s=source_id, h=h))
                c.run("select audit.write('takedown_lift', 'core.suppression', null, cast(:d as jsonb))", d=json.dumps({"count": n}))
            else:
                n = delete_keys(c, table, manifest["natural_key"], [tuple(key)])
                c.run("""insert into core.suppression (source_id, key_sha256) values (:s, :h)
                          on conflict (source_id, key_sha256) do update set lifted_at = null""", s=source_id, h=h)
                for s in shas:
                    c.run("delete from core.raw_object where source_id = :s and sha256 = :h", s=source_id, h=s)
                c.run(f"select audit.write('takedown_{reason}', :t, null, cast(:d as jsonb))", t=table, d=json.dumps({"count": n}))
            c.run("select core.finish_job(:t, true, null)", t=token)
        blobs = 0 if lift else R.delete_unreferenced(conn, store, set(shas))
        return {"rows": n, "blobs_deleted": blobs}
    finally:
        conn.close()


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="takedown")
    ap.add_argument("--db", required=True); ap.add_argument("--raw-dir", required=True)
    ap.add_argument("--module", required=True, help="python path of the module worker package that lists the connector")
    ap.add_argument("--source", required=True); ap.add_argument("--key", required=True)
    ap.add_argument("--reason", choices=REASONS, default="takedown"); ap.add_argument("--sha256", action="append", default=[])
    ap.add_argument("--lift", action="store_true")
    a = ap.parse_args(argv)
    mod = __import__(a.module, fromlist=["connectors"])
    found = [c for c in getattr(mod, "connectors", []) if c.manifest["source_id"] == a.source]
    if not found:
        print("takedown: unknown source", file=sys.stderr)
        return 2
    r = takedown(a.db, R.FsRawStore(a.raw_dir), found[0].manifest, json.loads(a.key), a.reason, a.sha256, a.lift)
    print(f"takedown: {r['rows']} row(s), {r['blobs_deleted']} blob(s) deleted")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
