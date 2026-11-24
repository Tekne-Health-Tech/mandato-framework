"""Fetch sidecar, egress gateway and database gateway (design 0004 §3, §6, §10). No database, no internet.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import hashlib
import os
import socket
import tempfile
import threading
import unittest

from workers.core.egress import dbgw, proxy
from workers.core.fetch import policy as P
from workers.core.fetch.sidecar import Sidecar, SidecarHttp, read_secret, serve
from workers.core.tests.fixtures.ref_connector import FIXTURES, HOST, ExemploItens

KEY = "s3cr3t-key-value"


def fake_transport(seen):
    def t(ip, host, path_qs, headers, timeout, max_body):
        seen.append((ip, host, path_qs, dict(headers)))
        url = f"https://{host}{path_qs}"
        if path_qs == "/robots.txt" and url not in FIXTURES:
            return 404, {}, b""
        status, h, body = FIXTURES[url]
        return status, {**h, "set-cookie": "a=b", "x-echo-key": headers.get("X-Api-Key", "")}, body
    return t


class SidecarTest(unittest.TestCase):
    def setUp(self):
        self.m = dict(ExemploItens().manifest)
        self.m.update(auth="api_key", auth_header="X-Api-Key", auth_secret_ref="exemplo_key")
        self.seen = []
        self.leases = {"L1": ("job-1", self.m["source_id"]), "L2": ("job-2", "outra-fonte")}

        def grant(lease):
            if lease not in self.leases:
                raise RuntimeError("fetch_grant: invalid lease")
            return self.leases[lease]
        self.sc = Sidecar({self.m["source_id"]: self.m}, grant, secret=lambda ref: KEY, transport=fake_transport(self.seen),
                          bucket=lambda n: P.TokenBucket(10**6, clock=lambda: 0.0, sleep=lambda s: None))
        self.url = next(u for u in FIXTURES if "robots" not in u)

    def test_valid_lease_fetches_through_policy_with_credential_on_first_hop(self):
        out = self.sc.handle({"lease": "L1", "url": self.url})
        self.assertEqual(out["status"], 200, out)
        self.assertEqual(out["host"], HOST)
        self.assertIsNone(self.seen[-1][0], "the sidecar does not resolve; the egress gateway does")
        self.assertEqual(self.seen[-1][3]["X-Api-Key"], KEY)

    def test_only_allow_listed_response_headers_and_never_the_secret(self):
        out = self.sc.handle({"lease": "L1", "url": self.url})
        self.assertLessEqual(set(out["headers"]), {"content-type", "etag", "last-modified", "content-length"})
        self.assertNotIn(KEY, repr({k: v for k, v in out.items() if k != "body_b64"}))

    def test_refusals(self):
        self.assertEqual(self.sc.handle({"lease": "nope", "url": self.url}), {"error": "lease_lost"})
        self.assertEqual(self.sc.handle({"lease": "L2", "url": self.url}), {"error": "unknown_source"})
        self.assertEqual(self.sc.handle({"lease": "L1", "url": "https://example.org/x"}), {"error": "fetch_refused"})
        self.assertEqual(self.sc.handle({"lease": "L1", "url": self.url, "headers": {"Authorization": "x"}}), {"error": "fetch_refused"})
        self.assertEqual(self.sc.handle({"lease": "L1", "url": self.url, "source_id": "x"}), {"error": "bad_request"})
        self.assertEqual(self.sc.handle(["x"]), {"error": "bad_request"})

    def test_budgets_are_per_job(self):
        self.sc.handle({"lease": "L1", "url": self.url})
        c1 = self.sc.clients["job-1"][0]
        self.leases["L3"] = ("job-3", self.m["source_id"])
        self.sc.handle({"lease": "L3", "url": self.url})
        self.assertIsNot(self.sc.clients["job-3"][0].budget, c1.budget)

    def test_socket_round_trip_records_under_the_worker(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "fetch.sock")
        srv = serve(self.sc, path)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        self.assertEqual(oct(os.stat(path).st_mode & 0o777), "0o660")
        recorded = []

        def rec(host, path_, body, ct):
            recorded.append((host, path_))
            return hashlib.sha256(body).hexdigest()
        r = SidecarHttp(path, "L1", rec).get(self.url)
        self.assertEqual(r["status"], 200)
        self.assertEqual(recorded[0][0], HOST)
        with self.assertRaises(P.FetchRefused) as e:
            SidecarHttp(path, "bad", rec).get(self.url)
        self.assertEqual(e.exception.code, "lease_lost")


class SecretTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        with open(os.path.join(self.root, "good_key"), "w") as f:
            f.write("v\n")
        outside = os.path.join(tempfile.mkdtemp(), "other")
        with open(outside, "w") as f:
            f.write("leak")
        os.symlink(outside, os.path.join(self.root, "link_key"))

    def test_read(self):
        self.assertEqual(read_secret("good_key", {"good_key"}, self.root), "v")

    def test_refused(self):
        for ref, allowed in [("../etc/passwd", {"../etc/passwd"}), ("good_key", set()), ("link_key", {"link_key"}),
                             ("Good", {"Good"}), ("missing_key", {"missing_key"})]:
            with self.assertRaises(P.FetchRefused, msg=ref):
                read_secret(ref, allowed, self.root)


class EgressDecideTest(unittest.TestCase):
    ALLOW = {"dados.example.gov.br"}

    def d(self, line, addrs=("8.8.8.8",)):
        return proxy.decide(line.encode() + b"\r\n\r\n", self.ALLOW, lambda h: list(addrs))

    def test_allowed(self):
        self.assertEqual(self.d("CONNECT dados.example.gov.br:443 HTTP/1.1")[:2], (200, "8.8.8.8"))
        self.assertEqual(self.d("CONNECT DADOS.example.gov.br:443 HTTP/1.1")[0], 200)

    def test_refused(self):
        self.assertEqual(self.d("CONNECT other.example.org:443 HTTP/1.1")[0], 403)
        self.assertEqual(self.d("CONNECT dados.example.gov.br:80 HTTP/1.1")[0], 403)
        self.assertEqual(self.d("CONNECT dados.example.gov.br HTTP/1.1")[0], 403)
        self.assertEqual(self.d("GET http://dados.example.gov.br/ HTTP/1.1")[0], 405)
        for private in ("10.0.0.1", "169.254.169.254", "100.64.0.1", "127.0.0.1", "::1", "192.168.1.1"):
            self.assertEqual(self.d("CONNECT dados.example.gov.br:443 HTTP/1.1", ("8.8.8.8", private))[0], 403, private)

    def test_tunnel_pipes_bytes_to_the_checked_address(self):
        echo = socket.socket()
        echo.bind(("127.0.0.1", 0))
        echo.listen()
        self.addCleanup(echo.close)

        def serve_echo():
            c, _ = echo.accept()
            c.sendall(c.recv(100).upper())
            c.close()
        threading.Thread(target=serve_echo, daemon=True).start()
        dialled = []

        def connect(addr):
            dialled.append(addr)
            return socket.create_connection(echo.getsockname())
        srv = proxy.Server(("127.0.0.1", 0), proxy.make_handler(self.ALLOW, lambda h: ["8.8.8.8"], connect))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        s = socket.create_connection(srv.server_address)
        s.sendall(b"CONNECT dados.example.gov.br:443 HTTP/1.1\r\n\r\nhello")
        data = b""
        while b"HELLO" not in data:
            chunk = s.recv(100)
            if not chunk:
                break
            data += chunk
        s.close()
        self.assertTrue(data.startswith(b"HTTP/1.1 200"))
        self.assertIn(b"HELLO", data)
        self.assertEqual(dialled, [("8.8.8.8", 443)])

    def test_refusal_on_the_wire(self):
        srv = proxy.Server(("127.0.0.1", 0), proxy.make_handler(self.ALLOW, lambda h: ["8.8.8.8"], lambda a: 1 / 0))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        s = socket.create_connection(srv.server_address)
        s.sendall(b"CONNECT evil.example.org:443 HTTP/1.1\r\n\r\n")
        self.assertTrue(s.recv(100).startswith(b"HTTP/1.1 403"))
        s.close()


class DbGatewayTest(unittest.TestCase):
    def test_private_destination_refused_unless_test_shape(self):
        dialled = []
        h = dbgw.make_handler("db.example.supabase.co", 5432, resolver=lambda h: ["10.1.2.3"],
                              connect=lambda a: dialled.append(a))
        srv = proxy.Server(("127.0.0.1", 0), h)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        s = socket.create_connection(srv.server_address)
        self.assertEqual(s.recv(10), b"")   # closed without dialling
        s.close()
        self.assertEqual(dialled, [])

    def test_forwards_only_to_the_fixed_destination(self):
        echo = socket.socket()
        echo.bind(("127.0.0.1", 0))
        echo.listen()
        self.addCleanup(echo.close)

        def serve_echo():
            c, _ = echo.accept()
            c.sendall(c.recv(100)[::-1])
            c.close()
        threading.Thread(target=serve_echo, daemon=True).start()
        port = echo.getsockname()[1]
        srv = proxy.Server(("127.0.0.1", 0), dbgw.make_handler("127.0.0.1", port, check_public=False))
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.server_close)
        self.addCleanup(srv.shutdown)
        s = socket.create_connection(srv.server_address)
        s.sendall(b"abc")
        self.assertEqual(s.recv(10), b"cba")
        s.close()


if __name__ == "__main__":
    unittest.main()
