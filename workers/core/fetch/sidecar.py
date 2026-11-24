"""Fetch sidecar (design 0004 §6): the only process of the c1 pool that sends connector requests out.

It listens on a Unix socket shared only with the worker of its pool. The capability is the job lease the worker holds:
`core.fetch_grant(lease)` (role fetch_c1) names the job and its source, so a worker can fetch only for the connector
job it currently runs. The sidecar applies the same `FetchClient` policy as the in-process client, holds the secrets,
budgets per job and rate limits per source, and writes nothing: the worker records each response under its own lease.

Outbound connections go through the `egress` gateway (HTTP CONNECT), which resolves the name, refuses non-public
addresses and hosts outside the allow-list, and pins the connection; TLS stays end to end from here.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import base64
import hashlib
import http.client
import json
import logging
import os
import re
import socket
import socketserver
import ssl
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler

from . import policy as P
from .client import FetchClient, deadline, exchange

log = logging.getLogger("mandato.fetch.sidecar")
SECRET_REF = re.compile(r"^[a-z][a-z0-9_]{1,60}$")
PASS_HEADERS = ("content-type", "etag", "last-modified", "content-length")
MAX_REQUEST = 64 * 1024
JOB_IDLE_S = 3600


def read_secret(ref: str, allowed: set[str], root: str = "/run/secrets") -> str:
    """Opens <root>/<ref> without following symlinks; ref must be well-formed and configured."""
    if not SECRET_REF.match(ref) or ref not in allowed:
        raise P.FetchRefused("secret_unavailable")
    dfd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        fd = os.open(ref, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
    except OSError:
        raise P.FetchRefused("secret_unavailable") from None
    finally:
        os.close(dfd)
    with os.fdopen(fd, "r", encoding="utf-8") as f:
        return f.read().strip()


def connect_transport(proxy: tuple[str, int], ca_file: str | None = None) -> Callable:
    """A FetchClient transport that tunnels through the egress gateway with HTTP CONNECT, then speaks TLS to `host`."""
    def transport(ip, host, path_qs, headers, timeout, max_body):
        end = time.monotonic() + timeout
        raw = socket.create_connection(proxy, timeout=max(timeout, 0.001))
        try:
            with deadline(raw, end - time.monotonic()):   # tunnel, TLS handshake and exchange share one deadline
                raw.sendall(f"CONNECT {host}:443 HTTP/1.1\r\nHost: {host}:443\r\n\r\n".encode("ascii"))
                head = b""
                while b"\r\n\r\n" not in head:
                    chunk = raw.recv(1024)
                    if not chunk or len(head) > 8192:
                        raise P.FetchRefused("fetch_failed", "egress")
                    head += chunk
                status_line = head.split(b"\r\n", 1)[0]
                if status_line.split(b" ")[1:2] != [b"200"]:
                    code = status_line.split(b" ")[1:2]
                    raise P.FetchRefused("fetch_refused" if code == [b"403"] else "fetch_failed", "egress")
                ctx = ssl.create_default_context(cafile=ca_file)
                sock = ctx.wrap_socket(raw, server_hostname=host)
                conn = http.client.HTTPSConnection(host, 443, timeout=timeout, context=ctx)
                try:
                    return exchange(conn, sock, host, path_qs, headers, max_body)
                finally:
                    conn.close()
        finally:
            raw.close()
    return transport


@dataclass
class _Slot:
    client: FetchClient
    lock: threading.Lock = field(default_factory=threading.Lock)
    last: float = 0.0
    users: int = 0          # requests holding or waiting on `lock`; guarded by Sidecar.lock


class Sidecar:
    """Request handling, independent of the socket server so tests can drive it directly."""

    def __init__(self, registry: dict[str, dict], grant: Callable[[str], tuple[str, str]], *,
                 secret: Callable[[str], str], transport: Callable, resolver: Callable[[str], list[str]] | None = None,
                 bucket: Callable[[int], P.TokenBucket] = lambda n: P.TokenBucket(n), clock=time.monotonic):
        self.registry = registry          # source_id -> manifest (enabled connectors only)
        self.grant = grant                # lease -> (job_id, source_id); raises on any refusal
        self.secret, self.transport = secret, transport
        self.resolver = resolver   # None: the egress gateway resolves, checks and pins the address
        self.buckets = {s: bucket(m["rate_limit_per_min"]) for s, m in registry.items()}
        self.clients: dict[str, _Slot] = {}   # sha256(lease) -> slot
        self.clock = clock
        self.lock = threading.Lock()

    def _client(self, job_id: str, source_id: str, lease: str) -> "_Slot":
        """One client per job, with its own lock: a job's requests run one at a time, so its run budget, robots cache
        and redirects are never raced. The client re-checks the lease before each request it sends (design 0004 §6)."""
        key = hashlib.sha256(lease.encode()).hexdigest()   # one client per claim: a re-claimed job starts afresh
        with self.lock:
            now = self.clock()
            # only a slot nobody holds or waits on may go: an evicted slot in use would let a second client (own lock,
            # fresh budget) run beside it for the same lease
            for j in [j for j, s in self.clients.items() if s.users == 0 and now - s.last > JOB_IDLE_S]:
                del self.clients[j]
            if key not in self.clients:
                m = self.registry[source_id]
                c = FetchClient(m, lambda host, path, body, ct: hashlib.sha256(body).hexdigest(), secret=self.secret,
                                resolver=self.resolver, transport=self.transport, bucket=self.buckets[source_id],
                                alive=lambda: self._still_granted(lease, job_id))
                self.clients[key] = _Slot(c)
            slot = self.clients[key]
            slot.users += 1
            slot.last = now
            return slot

    def _release(self, slot: "_Slot") -> None:
        with self.lock:
            slot.users -= 1
            slot.last = self.clock()

    def _still_granted(self, lease: str, job_id: str) -> bool:
        try:
            return str(self.grant(lease)[0]) == job_id
        except Exception:
            return False

    def handle(self, req: dict) -> dict:
        try:
            if not isinstance(req, dict) or set(req) - {"lease", "url", "params", "headers"}:
                raise P.FetchRefused("bad_request")
            lease, url = req.get("lease"), req.get("url")
            params, headers = req.get("params") or None, req.get("headers") or None
            if not isinstance(lease, str) or not isinstance(url, str):
                raise P.FetchRefused("bad_request")
            for d in (params, headers):
                if d is not None and not (isinstance(d, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in d.items())):
                    raise P.FetchRefused("bad_request")
            try:
                job_id, source_id = self.grant(lease)
            except Exception:
                raise P.FetchRefused("lease_lost") from None
            if source_id not in self.registry:
                raise P.FetchRefused("unknown_source")
            slot = self._client(str(job_id), source_id, lease)
            try:
                with slot.lock:
                    status, h, body, target = slot.client._follow(url, P.check_headers(headers), credential=True,
                                                                  robots=True, params=params)
            finally:
                self._release(slot)
            return {"status": status, "headers": {k: h[k] for k in PASS_HEADERS if k in h},
                    "host": target.host, "path": target.path, "body_b64": base64.b64encode(body).decode("ascii")}
        except P.FetchRefused as e:
            return {"error": e.code}
        except Exception as e:
            log.error("sidecar internal: type=%s", type(e).__name__)
            return {"error": "internal"}


class _Handler(BaseHTTPRequestHandler):
    sidecar: Sidecar = None   # set by serve()

    def log_message(self, fmt, *args):   # request lines carry no values worth keeping; never log URLs or bodies
        pass

    def do_POST(self):
        if self.path != "/fetch":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > MAX_REQUEST:
            self.send_error(413)
            return
        try:
            req = json.loads(self.rfile.read(n))
        except ValueError:
            req = None
        out = json.dumps(self.sidecar.handle(req)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


class _Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        sock, _ = super().get_request()
        return sock, ("unix", 0)   # BaseHTTPRequestHandler expects a (host, port) address


def serve(sidecar: Sidecar, path: str, mode: int = 0o660) -> _Server:
    if os.path.exists(path):
        os.unlink(path)
    handler = type("Handler", (_Handler,), {"sidecar": sidecar})
    srv = _Server(path, handler)
    os.chmod(path, mode)
    return srv


class SidecarHttp:
    """Worker side: `Http.get` over the sidecar socket. Records each response under the worker's own lease."""

    def __init__(self, path: str, lease: str, recorder: Callable[[str, str, bytes, str | None], str], timeout: float = 120):
        self.path, self.lease, self.recorder, self.timeout = path, lease, recorder, timeout

    def _post(self, payload: dict) -> dict:
        body = json.dumps(payload).encode()
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        try:
            s.connect(self.path)
            conn = http.client.HTTPConnection("sidecar")
            conn.sock = s
            conn.request("POST", "/fetch", body=body, headers={"Content-Type": "application/json"})
            r = conn.getresponse()
            data = r.read()
        except OSError:
            raise P.FetchRefused("fetch_failed", "sidecar") from None
        finally:
            s.close()
        if r.status != 200:
            raise P.FetchRefused("fetch_failed", "sidecar")
        return json.loads(data)

    def get(self, url: str, params: dict[str, str] | None = None, headers: dict[str, str] | None = None) -> dict:
        out = self._post({"lease": self.lease, "url": url, "params": params, "headers": headers})
        if "error" in out:
            raise P.FetchRefused(out["error"])
        body = base64.b64decode(out["body_b64"])
        ref = self.recorder(out["host"], out["path"], body, out["headers"].get("content-type"))
        if ref != hashlib.sha256(body).hexdigest():
            raise P.FetchRefused("internal", "raw_ref")
        return {"status": out["status"], "headers": out["headers"], "body": body, "raw_ref": ref}


def main() -> None:   # pragma: no cover - exercised by the network test
    import argparse
    from workers.core.connectors.db import connect
    from workers.core.runtime.spec import load_runtime

    ap = argparse.ArgumentParser()
    ap.add_argument("--runtime", required=True, help="runtime.json written by `mandato instance up`; no module code runs here")
    ap.add_argument("--database", required=True)
    ap.add_argument("--socket", default="/run/mandato/fetch.sock")
    ap.add_argument("--egress", default="egress:3128")
    ap.add_argument("--ca-file", default=None)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    manifests = load_runtime(a.runtime).connectors
    allowed = {m["auth_secret_ref"] for m in manifests.values() if m.get("auth") == "api_key"}
    conn = connect(a.database, "fetch_c1")
    db_lock = threading.Lock()

    def grant(lease):
        with db_lock:
            row = conn.run("select job_id::text, source_id from core.fetch_grant(:l)", l=lease)
        return row[0][0], row[0][1]

    host, port = a.egress.rsplit(":", 1)
    sc = Sidecar(manifests, grant, secret=lambda ref: read_secret(ref, allowed),
                 transport=connect_transport((host, int(port)), a.ca_file))
    srv = serve(sc, a.socket)
    log.info("sidecar listening: sources=%d", len(manifests))
    srv.serve_forever()


if __name__ == "__main__":
    main()
