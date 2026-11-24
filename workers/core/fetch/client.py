"""In-process fetch client (design 0003 §3.4): the policy of `policy.py` plus a pinned TLS transport.

Tests and the demo use it directly. In production the same class runs inside the fetch sidecar, the only process of
the c1 pool with internet egress; workers there get a socket stub with the same `get` signature.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import hashlib
import http.client
import socket
import ssl
from collections.abc import Callable
from urllib.parse import urljoin

from . import policy as P

# transport(ip, host, path_qs, headers, timeout, max_body) -> (status, headers lower-cased, body)
Transport = Callable[[str, str, str, dict[str, str], float, int], tuple[int, dict[str, str], bytes]]
Resolver = Callable[[str], list[str]]
# recorder(host, path, body, content_type) -> raw_ref; must persist the bytes before returning
Recorder = Callable[[str, str, bytes, str | None], str]


def resolve(host: str) -> list[str]:
    return sorted({ai[4][0] for ai in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})


def tls_transport(ip: str, host: str, path_qs: str, headers: dict[str, str], timeout: float, max_body: int):
    """Connects to the already validated `ip`; SNI, Host and certificate checks use `host`."""
    ctx = ssl.create_default_context()
    raw = socket.create_connection((ip, 443), timeout=timeout)
    try:
        sock = ctx.wrap_socket(raw, server_hostname=host)
    except Exception:
        raw.close()
        raise
    conn = http.client.HTTPSConnection(host, 443, timeout=timeout, context=ctx)
    conn.sock = sock
    try:
        conn.request("GET", path_qs, headers={**headers, "Host": host, "Accept-Encoding": "identity"})
        r = conn.getresponse()
        length = r.getheader("Content-Length")
        if length is not None and length.isdigit() and int(length) > max_body:
            raise P.FetchRefused("fetch_refused", "body_too_large")
        body = r.read(max_body + 1)
        if len(body) > max_body:
            raise P.FetchRefused("fetch_refused", "body_too_large")
        return r.status, {k.lower(): v for k, v in r.getheaders()}, body
    finally:
        conn.close()


class FetchClient:
    def __init__(self, manifest: dict, recorder: Recorder, *, secret: Callable[[str], str] | None = None,
                 resolver: Resolver | None = resolve, transport: Transport = tls_transport,
                 bucket: P.TokenBucket | None = None, budget: P.RunBudget | None = None,
                 alive: Callable[[], bool] = lambda: True):
        self.hosts = list(manifest["hosts"])
        self.auth = (manifest["auth_header"], secret(manifest["auth_secret_ref"])) if manifest["auth"] == "api_key" else None
        self.recorder, self.resolver, self.transport = recorder, resolver, transport
        self.bucket = bucket or P.TokenBucket(manifest["rate_limit_per_min"])
        self.budget = budget or P.RunBudget()
        self.alive = alive
        self.robots: dict[str, P.Robots] = {}

    def _send(self, target: P.Target, headers: dict[str, str]) -> tuple[int, dict[str, str], bytes]:
        if not self.alive():
            raise P.FetchRefused("lease_lost")
        self.budget.request()
        self.bucket.take()
        ip = None   # resolver None: the transport's gateway resolves and checks (fetch sidecar behind egress, design 0004 §3)
        if self.resolver is not None:
            try:
                ip = P.check_addresses(self.resolver(target.host))
            except OSError:
                raise P.FetchRefused("fetch_failed", "dns") from None
        try:
            status, h, body = self.transport(ip, target.host, target.path_qs, headers, P.TIMEOUT_S, P.MAX_BODY)
        except P.FetchRefused:
            raise
        except (OSError, http.client.HTTPException, ssl.SSLError):
            raise P.FetchRefused("fetch_failed", "transport") from None
        if len(body) > P.MAX_BODY:
            raise P.FetchRefused("fetch_refused", "body_too_large")
        self.budget.body(len(body))
        return status, h, body

    def _robots(self, host: str) -> P.Robots:
        if host not in self.robots:
            try:
                status, _, body, _ = self._follow(f"https://{host}/robots.txt", {}, credential=False, robots=False)
            except P.FetchRefused as e:
                if e.code in ("run_too_large", "lease_lost", "fetch_refused"):   # policy refusals surface as such
                    raise
                status, body = None, b""
            self.robots[host] = P.Robots(status, body)
        return self.robots[host]

    def _follow(self, url: str, headers: dict[str, str], *, credential: bool, robots: bool,
                params: dict[str, str] | None = None):
        base = {**headers, "User-Agent": P.USER_AGENT}
        for hop in range(P.MAX_REDIRECTS + 1):
            target = P.check_url(url, self.hosts, params if hop == 0 else None)
            if robots and not self._robots(target.host).allowed(target.path):
                raise P.FetchRefused("robots_disallowed")
            send = dict(base)
            if credential and hop == 0 and self.auth:
                send[self.auth[0]] = self.auth[1]
            status, h, body = self._send(target, send)
            if status in (301, 302, 303, 307, 308) and "location" in h:
                url = urljoin(f"https://{target.host}{target.path_qs}", h["location"])
                continue
            return status, h, body, target
        raise P.FetchRefused("fetch_refused", "redirects")

    def get(self, url: str, params: dict[str, str] | None = None, headers: dict[str, str] | None = None) -> dict:
        status, h, body, target = self._follow(url, P.check_headers(headers), credential=True, robots=True, params=params)
        ref = self.recorder(target.host, target.path, body, h.get("content-type"))
        if ref != hashlib.sha256(body).hexdigest():
            raise P.FetchRefused("internal", "raw_ref")
        return {"status": status, "headers": h, "body": body, "raw_ref": ref}
