"""Egress gateway (design 0004 §3): the only container of the fetch path with a route out.

An HTTP CONNECT proxy that tunnels only to `<host>:443` for hosts in a fixed allow-list (the `hosts` of enabled
connector manifests). It resolves the name itself, refuses unless every address is public, and connects to the first
checked address, so a compromised sidecar cannot reach other hosts, private ranges or metadata services. It never
sees plaintext: TLS runs end to end between the sidecar and the origin.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import logging
import select
import socket
import socketserver
import time
from collections.abc import Callable

from workers.core.fetch import policy as P

log = logging.getLogger("mandato.egress")
MAX_HEAD = 8192
IDLE_S = 60
MAX_TUNNEL_S = 900


def _resolve(host: str) -> list[str]:
    return sorted({ai[4][0] for ai in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})


def decide(head: bytes, allow: set[str], resolver: Callable[[str], list[str]]) -> tuple[int, str | None, str]:
    """Returns (status, address, host). status 200 means tunnel to address:443."""
    try:
        line = head.split(b"\r\n", 1)[0].decode("ascii")
    except UnicodeDecodeError:
        return 400, None, ""
    parts = line.split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT" or not parts[2].startswith("HTTP/1."):
        return 405, None, ""
    host, sep, port = parts[1].rpartition(":")
    host = host.lower()
    if not sep or port != "443" or not P.HOST_RE.match(host) or host not in allow:
        return 403, None, host
    try:
        addr = P.check_addresses(resolver(host))
    except P.FetchRefused:
        return 403, None, host
    except OSError:
        return 502, None, host
    return 200, addr, host


def pipe(a: socket.socket, b: socket.socket, idle_s: float = IDLE_S, max_s: float = MAX_TUNNEL_S) -> None:
    start = time.monotonic()
    socks = [a, b]
    while time.monotonic() - start < max_s:
        r, _, _ = select.select(socks, [], [], idle_s)
        if not r:
            return
        for s in r:
            data = s.recv(65536)
            if not data:
                return
            (b if s is a else a).sendall(data)


def make_handler(allow: set[str], resolver: Callable[[str], list[str]] = _resolve,
                 connect: Callable[[tuple[str, int]], socket.socket] = lambda addr: socket.create_connection(addr, timeout=15)):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            c = self.request
            c.settimeout(15)
            head = b""
            try:
                while b"\r\n\r\n" not in head:
                    chunk = c.recv(1024)
                    if not chunk:
                        return
                    head += chunk
                    if len(head) > MAX_HEAD:
                        c.sendall(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n")
                        return
            except OSError:
                return
            status, addr, host = decide(head, allow, resolver)
            if status != 200:
                log.warning("egress refused: host=%s status=%d", host[:253], status)
                c.sendall(f"HTTP/1.1 {status} Refused\r\n\r\n".encode())
                return
            try:
                up = connect((addr, 443))
            except OSError:
                c.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
                return
            try:
                c.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                c.settimeout(None)
                up.settimeout(None)
                extra = head.split(b"\r\n\r\n", 1)[1]
                if extra:
                    up.sendall(extra)
                pipe(c, up)
            except OSError:
                pass
            finally:
                up.close()
    return Handler


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:   # pragma: no cover - exercised by the network test
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--hosts-file", required=True, help="one host per line, written by `mandato instance up`")
    ap.add_argument("--listen", default="0.0.0.0:3128")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    with open(a.hosts_file, encoding="utf-8") as f:   # no module code runs in the gateway
        allow = {h.strip().lower() for h in f if h.strip() and P.HOST_RE.match(h.strip().lower())}
    host, port = a.listen.rsplit(":", 1)
    srv = Server((host, int(port)), make_handler(allow))
    log.info("egress listening: hosts=%d", len(allow))
    srv.serve_forever()


if __name__ == "__main__":
    main()
