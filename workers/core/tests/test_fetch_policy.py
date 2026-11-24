"""Fetch policy and client (design 0003 §3.2, §9 Policy): no sockets, a fake resolver and transport."""
import hashlib
import unittest

from workers.core.fetch import policy as P
from workers.core.fetch.client import FetchClient

HOST = "dados.exemplo.gov.br"
MANIFEST = {"hosts": [HOST, "cdn.exemplo.gov.br"], "auth": "none", "auth_header": None, "auth_secret_ref": None,
            "rate_limit_per_min": 600}


class Net:
    def __init__(self, routes=None, dns=None):
        self.routes = routes or {}
        self.dns = dns or {}
        self.sent = []

    def resolve(self, host):
        return self.dns.get(host, ["8.8.8.8"])

    def transport(self, ip, host, path_qs, headers, timeout, max_body):
        self.sent.append((ip, host, path_qs, dict(headers)))
        r = self.routes.get(f"https://{host}{path_qs}")
        if r is None:
            return (404, {}, b"") if path_qs == "/robots.txt" else (200, {}, b"ok")
        if isinstance(r, Exception):
            raise r
        return r


def client(net, manifest=MANIFEST, budget=None, secret=None, alive=lambda: True):
    rec = lambda host, path, body, ct: hashlib.sha256(body).hexdigest()
    return FetchClient({**manifest}, rec, secret=secret, resolver=net.resolve, transport=net.transport,
                       bucket=P.TokenBucket(manifest["rate_limit_per_min"], clock=lambda: 0.0, sleep=lambda s: None),
                       budget=budget, alive=alive)


class UrlAndHostTest(unittest.TestCase):
    def refused(self, url, **kw):
        with self.assertRaises(P.FetchRefused) as e:
            client(Net(**kw)).get(url)
        return e.exception.code

    def test_scheme_port_userinfo_host(self):
        for url in [f"http://{HOST}/a", f"https://{HOST}:8443/a", f"https://u:p@{HOST}/a", "https://outro.gov.br/a",
                    "https://127.0.0.1/a", f"https://{HOST}:abc/a"]:
            self.assertEqual(self.refused(url), "fetch_refused", url)

    def test_host_of_another_source(self):
        self.assertEqual(self.refused("https://api.outra-fonte.gov.br/x"), "fetch_refused")

    def test_non_public_addresses(self):
        for ip in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "192.168.1.1", "::1", "fd00::1",
                   "::ffff:127.0.0.1", "0.0.0.0", "224.0.0.1", "198.51.100.7"]:
            self.assertEqual(self.refused(f"https://{HOST}/a", dns={HOST: [ip]}), "fetch_refused", ip)
        self.assertEqual(self.refused(f"https://{HOST}/a", dns={HOST: ["8.8.8.8", "10.0.0.1"]}), "fetch_refused")

    def test_connection_pinned_to_checked_address(self):
        net = Net(dns={HOST: ["8.8.4.4"]})
        client(net).get(f"https://{HOST}/a")
        self.assertTrue(all(ip == "8.8.4.4" and host == HOST for ip, host, _, _ in net.sent))

    def test_headers(self):
        with self.assertRaises(P.FetchRefused):
            client(Net()).get(f"https://{HOST}/a", headers={"Authorization": "x"})
        with self.assertRaises(P.FetchRefused):
            client(Net()).get(f"https://{HOST}/a", headers={"Accept": "a\r\nX-Evil: 1"})
        net = Net()
        client(net).get(f"https://{HOST}/a", headers={"Accept": "application/json"})
        self.assertEqual(net.sent[-1][3]["User-Agent"], P.USER_AGENT)

    def test_no_post(self):
        self.assertFalse(hasattr(client(Net()), "post"))


class RedirectTest(unittest.TestCase):
    def test_redirect_to_disallowed_host_or_address(self):
        net = Net({f"https://{HOST}/a": (302, {"location": "https://evil.example.com/x"}, b"")})
        with self.assertRaises(P.FetchRefused):
            client(net).get(f"https://{HOST}/a")
        net = Net({f"https://{HOST}/a": (302, {"location": "https://cdn.exemplo.gov.br/x"}, b"")},
                  dns={"cdn.exemplo.gov.br": ["169.254.169.254"]})
        with self.assertRaises(P.FetchRefused):
            client(net).get(f"https://{HOST}/a")

    def test_redirect_limit(self):
        net = Net({f"https://{HOST}/a": (302, {"location": "/a"}, b"")})
        with self.assertRaises(P.FetchRefused):
            client(net).get(f"https://{HOST}/a")

    def test_credential_only_on_first_hop(self):
        m = {**MANIFEST, "auth": "api_key", "auth_header": "X-Api-Key", "auth_secret_ref": "k"}
        net = Net({f"https://{HOST}/a": (302, {"location": "https://cdn.exemplo.gov.br/b"}, b"")})
        client(net, m, secret=lambda ref: "s3cret").get(f"https://{HOST}/a")
        sent = [s for s in net.sent if s[2] != "/robots.txt"]
        self.assertEqual(sent[0][3].get("X-Api-Key"), "s3cret")
        self.assertNotIn("X-Api-Key", sent[1][3])
        self.assertTrue(all("X-Api-Key" not in s[3] for s in net.sent if s[2] == "/robots.txt"))


class RobotsTest(unittest.TestCase):
    def test_404_allows(self):
        client(Net()).get(f"https://{HOST}/a")

    def test_5xx_and_errors_refuse(self):
        for r in [(503, {}, b""), OSError("down")]:
            net = Net({f"https://{HOST}/robots.txt": r})
            with self.assertRaises(P.FetchRefused) as e:
                client(net).get(f"https://{HOST}/a")
            self.assertEqual(e.exception.code, "robots_disallowed")

    def test_disallowed_path(self):
        net = Net({f"https://{HOST}/robots.txt": (200, {}, b"User-agent: *\nDisallow: /privado\n")})
        c = client(net)
        c.get(f"https://{HOST}/publico")
        with self.assertRaises(P.FetchRefused) as e:
            c.get(f"https://{HOST}/privado/x")
        self.assertEqual(e.exception.code, "robots_disallowed")
        self.assertEqual(sum(1 for s in net.sent if s[2] == "/robots.txt"), 1, "robots fetched once per run")

    def test_disallow_rules_match_the_query_too(self):
        net = Net({f"https://{HOST}/robots.txt": (200, {}, b"User-agent: *\nDisallow: /busca?privado=1\n")})
        c = client(net)
        c.get(f"https://{HOST}/busca", params={"q": "x"})
        for url, params in ((f"https://{HOST}/busca?privado=1", None), (f"https://{HOST}/busca", {"privado": "1"})):
            with self.assertRaises(P.FetchRefused) as e:
                c.get(url, params=params)
            self.assertEqual(e.exception.code, "robots_disallowed")
        self.assertFalse(any("privado" in s[2] for s in net.sent))

    def test_long_paths_are_matched_whole(self):
        long = "/a" * 200
        net = Net({f"https://{HOST}/robots.txt": (200, {}, f"User-agent: *\nDisallow: {long}/fim\n".encode())})
        with self.assertRaises(P.FetchRefused) as e:
            client(net).get(f"https://{HOST}{long}/fim")
        self.assertEqual(e.exception.code, "robots_disallowed")


class LimitsTest(unittest.TestCase):
    def test_body_cap(self):
        net = Net({f"https://{HOST}/a": (200, {}, b"x" * (P.MAX_BODY + 1))})
        with self.assertRaises(P.FetchRefused):
            client(net).get(f"https://{HOST}/a")

    def test_run_budget(self):
        net = Net({f"https://{HOST}/a": (200, {}, b"x" * 1000)})
        c = client(net, budget=P.RunBudget(max_bytes=2500, max_requests=100))
        c.get(f"https://{HOST}/a"); c.get(f"https://{HOST}/a")
        with self.assertRaises(P.FetchRefused) as e:
            c.get(f"https://{HOST}/a")
        self.assertEqual(e.exception.code, "run_too_large")
        c = client(Net(), budget=P.RunBudget(max_requests=3))   # robots + 2
        c.get(f"https://{HOST}/a"); c.get(f"https://{HOST}/b")
        with self.assertRaises(P.FetchRefused) as e:
            c.get(f"https://{HOST}/c")
        self.assertEqual(e.exception.code, "run_too_large")

    def test_rate_limit_never_exceeded(self):
        t = [0.0]; slept = []
        def sleep(s): slept.append(s); t[0] += s
        b = P.TokenBucket(3, clock=lambda: t[0], sleep=sleep)
        stamps = []
        for _ in range(10):
            b.take(); stamps.append(t[0]); t[0] += 1
        for i in range(len(stamps)):
            self.assertLessEqual(sum(1 for s in stamps if stamps[i] <= s < stamps[i] + 60), 3)

    def test_rate_limit_holds_across_threads(self):
        import threading
        lock = threading.Lock(); t = [0.0]; stamps = []
        def sleep(s):
            with lock:
                t[0] += s
        b = P.TokenBucket(5, clock=lambda: t[0], sleep=sleep)
        def take():
            for _ in range(5):
                b.take()
                with lock:
                    stamps.append(t[0])
        ts = [threading.Thread(target=take) for _ in range(4)]
        for th in ts: th.start()
        for th in ts: th.join(10)
        self.assertEqual(len(stamps), 20)
        for s0 in stamps:
            self.assertLessEqual(sum(1 for s in stamps if s0 <= s < s0 + 60), 5)

    def test_lease_lost_during_the_rate_limit_wait_sends_nothing(self):
        state = {"alive": True}
        net = Net()
        c = client(net, alive=lambda: state["alive"])
        c.get(f"https://{HOST}/a")
        sent = len(net.sent)
        t = [0.0]
        c.bucket.clock = lambda: t[0]
        def sleep(s):
            t[0] += s
            state["alive"] = False
        c.bucket.sleep = sleep
        c.bucket.per_min = 1
        with self.assertRaises(P.FetchRefused) as e:
            c.get(f"https://{HOST}/b")
        self.assertEqual(e.exception.code, "lease_lost")
        self.assertEqual(len(net.sent), sent)

    def test_lost_lease_stops_requests(self):
        with self.assertRaises(P.FetchRefused) as e:
            client(Net(), alive=lambda: False).get(f"https://{HOST}/a")
        self.assertEqual(e.exception.code, "lease_lost")


class DeadlineTest(unittest.TestCase):
    """The per-request time budget is total, not per read (design 0003 §3.2)."""

    def test_a_dripping_server_is_cut_at_the_deadline(self):
        import http.client, socket, threading, time
        from workers.core.fetch.client import http_get
        srv = socket.socket(); srv.bind(("127.0.0.1", 0)); srv.listen(1)
        stop = threading.Event()
        def drip():
            c, _ = srv.accept()
            c.recv(4096)
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n")
            while not stop.is_set():
                try:
                    c.sendall(b"x")
                except OSError:
                    break
                time.sleep(0.2)   # each read succeeds well inside the socket timeout
            c.close()
        th = threading.Thread(target=drip, daemon=True); th.start()
        sock = socket.create_connection(srv.getsockname(), timeout=5)
        conn = http.client.HTTPConnection("x")
        t0 = time.monotonic()
        try:
            with self.assertRaises(P.FetchRefused) as e:
                http_get(conn, sock, "x", "/", {}, 1.0, 10_000)
        finally:
            stop.set(); conn.close(); srv.close()
        self.assertEqual(e.exception.code, "fetch_failed")
        self.assertLess(time.monotonic() - t0, 3)


if __name__ == "__main__":
    unittest.main()
