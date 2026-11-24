"""Contract suite every connector's tests reuse (design 0003 §8).

    class MyConnectorTest(ConnectorContract, unittest.TestCase):
        connector = MyConnector(); module_short = "mymod"; params = {...}
        fixtures = {"https://host/path?x=1": (200, {"content-type": "application/json"}, b"..."), ...}

The database part (§8.5) runs when TEST_DB is set and is mandatory where MANDATO_REQUIRE_DB=1 (the CI database job).

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import copy
import hashlib
import os
import unittest
from typing import Any

from workers.core.connectors.loader import check_connector, check_records
from workers.core.fetch import policy as P
from workers.core.fetch.client import FetchClient

PUBLIC_IP = "8.8.8.8"   # any public address: FakeHttp never connects


class FakeHttp:
    """Serves recorded fixtures through the real FetchClient policy (everything but DNS and sockets)."""

    def __init__(self, manifest: dict, fixtures: dict[str, tuple[int, dict, bytes]], secret=lambda ref: "test-key"):
        self.fixtures, self.seen, self.recorded = fixtures, [], set()
        self.client = FetchClient(manifest, self._record, secret=secret, resolver=lambda host: [PUBLIC_IP],
                                  transport=self._transport, bucket=P.TokenBucket(10**6, clock=lambda: 0.0, sleep=lambda s: None))

    def _record(self, host, path, body, ctype) -> str:
        sha = hashlib.sha256(body).hexdigest()
        self.recorded.add(sha)
        return sha

    def _transport(self, ip, host, path_qs, headers, timeout, max_body):
        url = f"https://{host}{path_qs}"
        self.seen.append((url, dict(headers)))
        if path_qs == "/robots.txt" and url not in self.fixtures:
            return 404, {}, b""
        if url not in self.fixtures:
            raise AssertionError(f"no fixture for {url}")
        return self.fixtures[url]


class Ctx:
    def __init__(self, source_id, params, http):
        self.source_id, self.params, self._http = source_id, params, http

    def http(self):
        return self._http


class ConnectorContract:
    connector: Any = None
    module_short: str = ""
    params: dict = {}
    fixtures: dict = {}

    def _collect(self):
        fake = FakeHttp(self.connector.manifest, self.fixtures)
        ctx = Ctx(self.connector.manifest["source_id"], self.params, fake.client)
        batches = [self.connector.fetch(r, None, ctx) for r in self.connector.discover(ctx)]
        return fake, batches

    def test_contract_manifest_and_params(self):
        check_connector(self.connector, self.module_short, self.params)

    def test_contract_fetch_stays_inside_hosts_and_records_raw(self):
        fake, batches = self._collect()
        hosts = set(self.connector.manifest["hosts"])
        for url, headers in fake.seen:
            self.assertIn(url.split("/")[2], hosts)
            extra = {k.lower() for k in headers} - P.ALLOWED_HEADERS - {"user-agent"}
            if self.connector.manifest["auth"] == "api_key":
                extra -= {self.connector.manifest["auth_header"].lower()}
            self.assertEqual(extra, set())
        for b in batches:
            self.assertTrue(set(b["raw_refs"]) <= fake.recorded, "raw_refs must come from recorded responses")
            self.assertTrue(b["raw_refs"], "every batch names the responses it came from")

    def test_contract_normalize_is_deterministic_and_well_shaped(self):
        _, batches = self._collect()
        m = self.connector.manifest
        a = [r for b in batches for r in self.connector.normalize(copy.deepcopy(b))]
        b2 = [r for b in batches for r in self.connector.normalize(copy.deepcopy(b))]
        self.assertEqual(a, b2)
        self.assertTrue(a, "fixtures must produce records")
        self.assertEqual(check_records(a, m["natural_key"], m["deleted_column"]), [])

    def test_contract_validate(self):
        _, batches = self._collect()
        recs = [r for b in batches for r in self.connector.normalize(b)]
        self.assertEqual(self.connector.validate(recs)["errors"], [])
        broken = copy.deepcopy(recs)
        del broken[0][self.connector.manifest["natural_key"][0]]
        self.assertTrue(self.connector.validate(broken)["errors"], "a record without its natural key must be an error")

    @unittest.skipUnless(os.environ.get("TEST_DB") or os.environ.get("MANDATO_REQUIRE_DB"), "database part: TEST_DB")
    def test_contract_target_table(self):
        if not os.environ.get("TEST_DB"):
            self.fail("MANDATO_REQUIRE_DB is set but TEST_DB is not")
        from workers.core.connectors.db import connect
        conn = connect(os.environ["TEST_DB"], "postgres")
        try:
            self.assertEqual(target_table_problems(conn, self.connector.manifest), [])
        finally:
            conn.close()


def target_table_problems(conn, m: dict) -> list[str]:
    schema, _, table = m["target_table"].partition(".")
    out = []
    rel = conn.run("""select c.oid, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner)
                        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = :s and c.relname = :t""",
                   s=schema, t=table)
    if not rel:
        return ["missing"]
    oid, rls, force, owner = rel[0]
    if owner != f"{schema}_owner":
        out.append("owner")
    if not (rls and force):
        out.append("rls")
    privs = {r[0] for r in conn.run("""select privilege_type from information_schema.role_table_grants
                                       where grantee = 'worker_c1' and table_schema = :s and table_name = :t""", s=schema, t=table)}
    if privs != {"SELECT", "INSERT", "UPDATE", "DELETE"}:
        out.append("grants")
    if not conn.run("select 1 from pg_policy where polrelid = :o and 'worker_c1'::regrole = any(polroles)", o=oid):
        out.append("policy")
    if not conn.run("select 1 from pg_trigger where tgrelid = :o and tgfoid = 'audit.row_trigger'::regproc", o=oid):
        out.append("audit_trigger")
    cols = conn.run("""select a.attname, col_description(a.attrelid, a.attnum) from pg_attribute a
                        where a.attrelid = :o and a.attnum > 0 and not a.attisdropped""", o=oid)
    if any(not (d or "").startswith("class=") for _, d in cols):
        out.append("class_comments")
    uniq = conn.run("""select array_agg(a.attname order by k.n) from pg_index i
                         cross join lateral unnest(i.indkey) with ordinality k(attnum, n)
                         join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
                        where i.indrelid = :o and i.indisunique group by i.indexrelid""", o=oid)
    if not any(sorted(u[0]) == sorted(m["natural_key"]) for u in uniq):
        out.append("natural_key_unique")
    return out
