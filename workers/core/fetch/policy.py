"""Fetch policy shared by the in-process client and the fetch sidecar (design 0003 §3.2). Pure: no I/O here.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import ipaddress
import re
import time
from dataclasses import dataclass, field
from urllib.parse import urlencode, urlsplit
from urllib.robotparser import RobotFileParser

MAX_BODY = 50 * 1024 * 1024
MAX_RUN_BYTES = 200 * 1024 * 1024
MAX_RUN_REQUESTS = 10_000
MAX_REDIRECTS = 3
TIMEOUT_S = 30
ALLOWED_HEADERS = {"accept", "accept-language", "if-none-match", "if-modified-since"}
HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
USER_AGENT = "mandato-framework/0.2"


class FetchRefused(Exception):
    """A request the policy does not allow. `code` is stored; the message never is."""

    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


@dataclass(frozen=True)
class Target:
    host: str
    path: str  # path only, for raw_object.url_path
    path_qs: str  # path plus query, for the request line


def check_url(url: str, hosts: list[str], params: dict[str, str] | None = None) -> Target:
    u = urlsplit(url)
    if u.scheme != "https":
        raise FetchRefused("fetch_refused", "scheme")
    if u.username is not None or u.password is not None:
        raise FetchRefused("fetch_refused", "userinfo")
    try:
        port = u.port
    except ValueError:
        raise FetchRefused("fetch_refused", "port") from None
    if port not in (None, 443):
        raise FetchRefused("fetch_refused", "port")
    host = (u.hostname or "").lower()
    if not HOST_RE.match(host) or host not in hosts:
        raise FetchRefused("fetch_refused", "host")
    path = u.path or "/"
    query = u.query
    if params:
        query = (query + "&" if query else "") + urlencode(sorted(params.items()))
    return Target(host, path[:300], path + (f"?{query}" if query else ""))


def check_headers(headers: dict[str, str] | None) -> dict[str, str]:
    out = {}
    for k, v in (headers or {}).items():
        if k.lower() not in ALLOWED_HEADERS or "\r" in v or "\n" in v:
            raise FetchRefused("fetch_refused", "header")
        out[k] = v
    return out


def is_public(ip: str) -> bool:
    a = ipaddress.ip_address(ip)
    if isinstance(a, ipaddress.IPv6Address) and a.ipv4_mapped is not None:
        a = a.ipv4_mapped
    if isinstance(a, ipaddress.IPv4Address) and a in ipaddress.ip_network("100.64.0.0/10"):
        return False
    return a.is_global and not (a.is_multicast or a.is_reserved or a.is_loopback or a.is_link_local
                                or a.is_private or a.is_unspecified)


def check_addresses(addresses: list[str]) -> str:
    """Every resolved address must be public; the connection is pinned to the first one."""
    if not addresses or not all(is_public(a) for a in addresses):
        raise FetchRefused("fetch_refused", "address")
    return addresses[0]


class Robots:
    """RFC 9309: 2xx -> obey; 4xx -> allow all; anything else -> disallow all (fail closed)."""

    def __init__(self, status: int | None, body: bytes):
        self.allow_all = status is not None and 400 <= status < 500
        self.deny_all = status is None or not (200 <= status < 300 or self.allow_all)
        self.parser = RobotFileParser()
        if not self.allow_all and not self.deny_all:
            self.parser.parse(body.decode("utf-8", "replace").splitlines())

    def allowed(self, path: str) -> bool:
        if self.allow_all:
            return True
        if self.deny_all:
            return False
        return self.parser.can_fetch(USER_AGENT, path)


@dataclass
class TokenBucket:
    per_min: int
    clock: object = time.monotonic
    sleep: object = time.sleep
    _stamps: list[float] = field(default_factory=list)

    def take(self) -> None:
        """Blocks until one more request fits in any 60 s window."""
        now = self.clock()
        self._stamps = [t for t in self._stamps if now - t < 60]
        if len(self._stamps) >= self.per_min:
            self.sleep(60 - (now - self._stamps[0]))
            now = self.clock()
            self._stamps = [t for t in self._stamps if now - t < 60]
        self._stamps.append(now)


@dataclass
class RunBudget:
    max_bytes: int = MAX_RUN_BYTES
    max_requests: int = MAX_RUN_REQUESTS
    bytes: int = 0
    requests: int = 0

    def request(self) -> None:
        if self.requests >= self.max_requests or self.bytes >= self.max_bytes:
            raise FetchRefused("run_too_large")
        self.requests += 1

    def body(self, n: int) -> None:
        self.bytes += n
        if self.bytes > self.max_bytes:
            raise FetchRefused("run_too_large")
