"""Thin pg8000 helpers for workers: connect from PG* env, lease-bound transactions.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import os
from contextlib import contextmanager

import pg8000.native


def connect(database: str, user: str = "worker_c1") -> pg8000.native.Connection:
    host = os.environ.get("PGHOST", "localhost")
    port = int(os.environ.get("PGPORT", "5432"))
    password = os.environ.get("PGPASSWORD")
    pw_file = os.environ.get("PGPASSWORD_FILE")   # containers: the role's password from a mounted secret
    if pw_file:
        with open(pw_file, encoding="utf-8") as f:
            password = f.read().strip()
    kw = {"user": user, "database": database, "password": password}
    if host.startswith("/"):
        kw["unix_sock"] = f"{host}/.s.PGSQL.{port}"
    else:
        # TLS with certificate and host name checks except on loopback or an explicit local `PGSSLMODE=disable`
        # (the compose-internal Postgres of a local instance). Staging reaches the managed database through `dbgw`,
        # which carries the database's real host name as its network alias, so verification still names that host.
        plain = host in ("localhost", "127.0.0.1") or os.environ.get("PGSSLMODE") == "disable"
        kw.update(host=host, port=port, ssl_context=None if plain else True)
    return pg8000.native.Connection(**kw)


@contextmanager
def tx(conn: pg8000.native.Connection, token: str | None):
    """One transaction; with a token it starts with audit.bind_lease (design 0001 §4.5)."""
    conn.run("begin")
    try:
        if token:
            conn.run("select audit.bind_lease(:t)", t=token)
        yield conn
        conn.run("commit")
    except BaseException:
        conn.run("rollback")
        raise
