"""Raw layer (design 0003 §4): content-addressed blobs, one core.raw_object row per accepted response.

Blob writes and deletes are serialized per sha256 with a transaction-scoped advisory lock, and blobs are deleted only
after the row deletions committed, so a committed row never points to a missing blob.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import hashlib
import os
import time
from pathlib import Path
from typing import Protocol

from .db import tx

LOCK = "select pg_advisory_xact_lock(hashtext('core.raw_object'), hashtext(:s))"


class RawStore(Protocol):
    def put(self, sha256: str, data: bytes) -> str: ...
    def exists(self, storage_key: str) -> bool: ...
    def get(self, storage_key: str) -> bytes: ...
    def delete(self, storage_key: str) -> None: ...
    def keys(self) -> list[tuple[str, float]]: ...   # (storage_key, modified epoch seconds)


class FsRawStore:
    """Directory store for dev, demo and tests. Keys are 'sha256/<hex>'."""

    def __init__(self, root: str | Path):
        self.root = Path(root)

    def _p(self, key: str) -> Path:
        algo, _, h = key.partition("/")
        if algo != "sha256" or len(h) != 64 or not all(c in "0123456789abcdef" for c in h):
            raise ValueError("bad storage key")
        return self.root / h[:2] / h

    def put(self, sha256: str, data: bytes) -> str:
        key = f"sha256/{sha256}"
        p = self._p(key)
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_suffix(f".{os.getpid()}.tmp")
            tmp.write_bytes(data)
            os.replace(tmp, p)
        return key

    def exists(self, key: str) -> bool:
        return self._p(key).exists()

    def get(self, key: str) -> bytes:
        return self._p(key).read_bytes()

    def delete(self, key: str) -> None:
        self._p(key).unlink(missing_ok=True)

    def keys(self) -> list[tuple[str, float]]:
        return [(f"sha256/{p.name}", p.stat().st_mtime) for p in self.root.glob("??/*") if len(p.name) == 64]


class Recorder:
    """Records each accepted response at once, in its own lease-bound transaction (design 0003 §4)."""

    def __init__(self, conn, store: RawStore, token: str, run_id: str, source_id: str):
        self.conn, self.store, self.token, self.run_id, self.source_id = conn, store, token, run_id, source_id
        self.refs: set[str] = set()

    def __call__(self, host: str, path: str, body: bytes, content_type: str | None) -> str:
        sha = hashlib.sha256(body).hexdigest()
        key = self.store.put(sha, body)
        with tx(self.conn, self.token) as c:
            c.run(LOCK, s=sha)
            if not self.store.exists(key):   # a deleter removed it between put and lock: write it again
                self.store.put(sha, body)
            c.run("""insert into core.raw_object (run_id, source_id, url_host, url_path, sha256, size, content_type,
                       storage_key, fetched_at) values (:r, :s, :h, :p, :sha, :n, :ct, :k, now())""",
                  r=self.run_id, s=self.source_id, h=host, p=path.split("?")[0][:300], sha=sha, n=len(body),
                  ct=(content_type or None) and content_type[:200], k=key)
        self.refs.add(sha)
        return sha


def delete_unreferenced(conn, store: RawStore, shas: set[str]) -> int:
    """After the row deletions committed: per sha, under the lock, delete the blob if no row references it.
    Reads and an advisory lock only, so no lease is needed."""
    n = 0
    for sha in sorted(shas):
        with tx(conn, None) as c:
            c.run(LOCK, s=sha)
            if not c.run("select 1 from core.raw_object where sha256 = :s limit 1", s=sha):
                store.delete(f"sha256/{sha}")
                n += 1
    return n


def prune(conn, store: RawStore, token: str, source_id: str, retention_days: int) -> int:
    with tx(conn, token) as c:
        rows = c.run("""delete from core.raw_object where source_id = :s and fetched_at < now() - make_interval(days => :d)
                        returning sha256""", s=source_id, d=retention_days)
    return delete_unreferenced(conn, store, {r[0] for r in rows})


def sweep_orphans(conn, store: RawStore, older_than_s: int = 86_400, now: float | None = None) -> int:
    """Blobs with no row, older than 24 h: left by a crash between blob write and row insert, or after a delete."""
    now = time.time() if now is None else now
    old = {k.split("/", 1)[1] for k, mtime in store.keys() if now - mtime > older_than_s}
    return delete_unreferenced(conn, store, old)
