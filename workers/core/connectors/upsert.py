"""Normalized layer helper (design 0003 §7): idempotent upsert on the natural key, deletes by natural key.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import json

from .loader import IDENT_RE, ConnectorRefused, check_records

BATCH = 500


def _q(name: str) -> str:
    if not IDENT_RE.match(name):
        raise ConnectorRefused("unknown_column")
    return f'"{name}"'


def table_columns(conn, table: str) -> set[str]:
    schema, _, name = table.partition(".")
    _q(schema), _q(name)
    return {r[0] for r in conn.run("select column_name from information_schema.columns where table_schema = :s and table_name = :t",
                                   s=schema, t=name)}


def _check(conn, table, records, natural_key):
    if not records:
        raise ConnectorRefused("shape", "empty")
    if check_records(records, natural_key, None):
        raise ConnectorRefused("shape")
    cols = list(records[0])
    if not set(cols) <= table_columns(conn, table):
        raise ConnectorRefused("unknown_column")
    return cols


def upsert_rows(conn, table: str, records: list[dict], natural_key: list[str]) -> dict:
    cols = _check(conn, table, records, natural_key)
    schema, _, name = table.partition(".")
    t = f"{_q(schema)}.{_q(name)}"
    rest = [c for c in cols if c not in natural_key]
    if rest:
        action = (f"do update set {', '.join(f'{_q(c)} = excluded.{_q(c)}' for c in rest)} "
                  f"where ({', '.join(f't.{_q(c)}' for c in rest)}) is distinct from ({', '.join(f'excluded.{_q(c)}' for c in rest)})")
    else:
        action = "do nothing"
    stats = {"inserted": 0, "updated": 0, "unchanged": 0}
    for i in range(0, len(records), BATCH):
        chunk = records[i:i + BATCH]
        params, rows = {}, []
        for j, r in enumerate(chunk):
            rows.append("(" + ", ".join(f":p{j}_{k}" for k in range(len(cols))) + ")")
            params.update({f"p{j}_{k}": r[c] for k, c in enumerate(cols)})
        sql = (f"insert into {t} as t ({', '.join(_q(c) for c in cols)}) values {', '.join(rows)} "
               f"on conflict ({', '.join(_q(c) for c in natural_key)}) {action} returning (xmax = 0)")
        out = conn.run(sql, **params)
        ins = sum(1 for r in out if r[0])
        stats["inserted"] += ins
        stats["updated"] += len(out) - ins
        stats["unchanged"] += len(chunk) - len(out)
    return stats


def delete_keys(conn, table: str, natural_key: list[str], keys: list[tuple]) -> int:
    schema, _, name = table.partition(".")
    t = f"{_q(schema)}.{_q(name)}"
    cond = " and ".join(f"{_q(c)} = :k{i}" for i, c in enumerate(natural_key))
    n = 0
    for k in keys:
        n += len(conn.run(f"delete from {t} where {cond} returning 1", **{f"k{i}": v for i, v in enumerate(k)}))
    return n


def delete_missing(conn, table: str, natural_key: list[str], keep: list[tuple]) -> int:
    """Snapshot sync: delete every row whose natural key is not in `keep`."""
    schema, _, name = table.partition(".")
    t = f"{_q(schema)}.{_q(name)}"
    key_expr = "jsonb_build_array(" + ", ".join(f"t.{_q(c)}" for c in natural_key) + ")"
    out = conn.run(f"delete from {t} as t where not exists (select 1 from jsonb_array_elements(cast(:a as jsonb)) k "
                   f"where k = {key_expr}) returning 1", a=json.dumps([list(k) for k in keep], default=str))
    return len(out)
