"""Database gateway (design 0004 §3, staging): a TCP relay with exactly one destination, the configured database.

Workers, API and scheduler have no route out; in staging they reach the managed Postgres only through this relay.
The destination is fixed at start; each new connection re-resolves it and refuses non-public addresses (a DNS change
cannot redirect the relay into a private network). TLS to Postgres stays end to end (sslmode=verify-full).

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import logging
import socket
import socketserver
from collections.abc import Callable

from workers.core.fetch import policy as P

from .proxy import pipe

log = logging.getLogger("mandato.dbgw")


def make_handler(dest_host: str, dest_port: int, resolver: Callable[[str], list[str]] | None = None,
                 connect: Callable[[tuple[str, int]], socket.socket] = lambda addr: socket.create_connection(addr, timeout=15),
                 check_public: bool = True):
    resolver = resolver or (lambda h: sorted({ai[4][0] for ai in socket.getaddrinfo(h, dest_port, type=socket.SOCK_STREAM)}))

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                addrs = resolver(dest_host)
                addr = P.check_addresses(addrs) if check_public else addrs[0]
                up = connect((addr, dest_port))
            except (OSError, P.FetchRefused, IndexError):
                log.warning("dbgw: destination unavailable")
                return
            try:
                pipe(self.request, up, idle_s=3600, max_s=7 * 86400)
            except OSError:
                pass
            finally:
                up.close()
    return Handler


def main() -> None:   # pragma: no cover - exercised by the network test
    import argparse
    from .proxy import Server
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", default="0.0.0.0:5432")
    ap.add_argument("--dest", required=True, help="host:port of the managed database")
    ap.add_argument("--allow-private-dest", action="store_true", help="test shape only: the stand-in database is private")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    dh, dp = a.dest.rsplit(":", 1)
    lh, lp = a.listen.rsplit(":", 1)
    srv = Server((lh, int(lp)), make_handler(dh, int(dp), check_public=not a.allow_private_dest))
    log.info("dbgw listening")
    srv.serve_forever()


if __name__ == "__main__":
    main()
