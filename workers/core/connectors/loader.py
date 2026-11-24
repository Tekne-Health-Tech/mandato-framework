"""Connector checks done before any write (design 0003 §5.1), shared by the runner and the contract suite.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import re
from typing import Any

from workers.core.contracts.classes import DataClass
from workers.core.fetch.policy import HOST_RE

SOURCE_RE = re.compile(r"^[a-z][a-z0-9-]{1,60}$")
IDENT_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")
CODE_RE = re.compile(r"^[a-z][a-z0-9_]{0,40}$")
HEADER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,63}$")
# The params_schema subset the framework validates itself (no third-party validator in the worker).
SCHEMA_KEYS = {"type", "properties", "required", "additionalProperties", "enum", "pattern", "minimum", "maximum",
               "items", "minLength", "maxLength", "description", "minItems", "maxItems"}
MAX_RESOURCES = 1_000
MAX_RECORDS = 200_000


class ConnectorRefused(Exception):
    def __init__(self, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


def _strict(schema: Any, path: str = "$") -> None:
    if not isinstance(schema, dict) or set(schema) - SCHEMA_KEYS:
        raise ConnectorRefused("invalid_manifest", f"params_schema {path}: unsupported keyword")
    if schema.get("type") == "object":
        if schema.get("additionalProperties") is not False:
            raise ConnectorRefused("invalid_manifest", f"params_schema {path}: additionalProperties must be false")
        for k, sub in schema.get("properties", {}).items():
            _strict(sub, f"{path}.{k}")
    if "items" in schema:
        _strict(schema["items"], f"{path}[]")


def validate_value(schema: dict, v: Any, path: str = "$") -> list[str]:
    """Errors as paths only, never values."""
    t = schema.get("type")
    kinds = {"object": dict, "array": list, "string": str, "boolean": bool, "null": type(None)}
    if t == "integer" and (not isinstance(v, int) or isinstance(v, bool)):
        return [path]
    if t == "number" and (not isinstance(v, (int, float)) or isinstance(v, bool)):
        return [path]
    if t in kinds and not isinstance(v, kinds[t]):
        return [path]
    if "enum" in schema and v not in schema["enum"]:
        return [path]
    out = []
    if isinstance(v, str):
        if "pattern" in schema and not re.search(schema["pattern"], v):
            out.append(path)
        if len(v) < schema.get("minLength", 0) or len(v) > schema.get("maxLength", 10**9):
            out.append(path)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        if v < schema.get("minimum", float("-inf")) or v > schema.get("maximum", float("inf")):
            out.append(path)
    if isinstance(v, dict):
        props = schema.get("properties", {})
        out += [f"{path}.{k}" for k in schema.get("required", []) if k not in v]
        for k, x in v.items():
            out += validate_value(props[k], x, f"{path}.{k}") if k in props else [f"{path}.{k}"]
    if isinstance(v, list):
        if len(v) < schema.get("minItems", 0) or len(v) > schema.get("maxItems", 10**9):
            out.append(path)
        for i, x in enumerate(v):
            out += validate_value(schema.get("items", {}), x, f"{path}[{i}]")
    return out


def check_connector(connector: Any, module_short: str, params: dict | None) -> None:
    """Raises ConnectorRefused with a stored code; returns nothing when the connector may run."""
    m = getattr(connector, "manifest", None)
    need = {"source_id", "name", "terms_url", "robots", "auth", "auth_secret_ref", "auth_header", "hosts",
            "rate_limit_per_min", "data_class", "natural_key", "target_table", "sync", "deleted_column"}
    if not isinstance(m, dict) or need - set(m):
        raise ConnectorRefused("invalid_manifest", "fields")
    if not SOURCE_RE.match(str(m["source_id"])):
        raise ConnectorRefused("invalid_manifest", "source_id")
    if not isinstance(m["data_class"], DataClass) or m["data_class"] > DataClass.C1:
        raise ConnectorRefused("invalid_manifest", "data_class")
    if m["auth"] == "none":
        if m["auth_secret_ref"] is not None or m["auth_header"] is not None:
            raise ConnectorRefused("invalid_manifest", "auth")
    elif m["auth"] == "api_key":
        if not m["auth_secret_ref"] or not isinstance(m["auth_header"], str) or not HEADER_RE.match(m["auth_header"]):
            raise ConnectorRefused("invalid_manifest", "auth")
    else:
        raise ConnectorRefused("invalid_manifest", "auth")
    if not isinstance(m["hosts"], list) or not m["hosts"] or not all(isinstance(h, str) and HOST_RE.match(h) for h in m["hosts"]):
        raise ConnectorRefused("invalid_manifest", "hosts")
    if not isinstance(m["rate_limit_per_min"], int) or not 1 <= m["rate_limit_per_min"] <= 600:
        raise ConnectorRefused("invalid_manifest", "rate_limit_per_min")
    nk = m["natural_key"]
    if not isinstance(nk, list) or not nk or not all(isinstance(k, str) and IDENT_RE.match(k) for k in nk) or len(set(nk)) != len(nk):
        raise ConnectorRefused("invalid_manifest", "natural_key")
    schema, _, table = str(m["target_table"]).partition(".")
    if schema != f"mod_{module_short}" or not IDENT_RE.match(table):
        raise ConnectorRefused("invalid_manifest", "target_table")
    if m["sync"] == "snapshot":
        if m["deleted_column"] is not None:
            raise ConnectorRefused("invalid_manifest", "deleted_column")
    elif m["sync"] == "incremental":
        if not isinstance(m["deleted_column"], str) or not IDENT_RE.match(m["deleted_column"]) or m["deleted_column"] in nk:
            raise ConnectorRefused("invalid_manifest", "deleted_column")
    else:
        raise ConnectorRefused("invalid_manifest", "sync")
    ps = getattr(connector, "params_schema", None)
    if not isinstance(ps, dict) or ps.get("type") != "object":
        raise ConnectorRefused("invalid_manifest", "params_schema")
    _strict(ps)
    if validate_value(ps, params if params is not None else {}):
        raise ConnectorRefused("invalid_params")


def check_registry(entries: list[tuple[Any, str]]) -> None:
    """A snapshot connector owns its target table alone: no other connector, snapshot or incremental, may write it,
    because a snapshot run deletes every row it did not return (design 0003 §4)."""
    by_table: dict[str, list[str]] = {}
    for c, _ in entries:
        m = c.manifest
        by_table.setdefault(m["target_table"], []).append(m.get("sync"))
    for syncs in by_table.values():
        if len(syncs) > 1 and "snapshot" in syncs:
            raise ConnectorRefused("invalid_manifest", "snapshot_table_shared")


def check_records(records: list[dict], natural_key: list[str], deleted_column: str | None) -> list[dict]:
    """Shape checks over the whole run (design 0003 §5.4, §7). Returns issues, codes and paths only."""
    issues = []
    if not records:
        return issues
    keys = set(records[0])
    if not set(natural_key) <= keys or (deleted_column and deleted_column not in keys):
        issues.append({"code": "shape", "path": "records[0]"})
        return issues
    seen = set()
    for i, r in enumerate(records):
        if set(r) != keys:
            issues.append({"code": "shape", "path": f"records[{i}]"})
            continue
        if not all(IDENT_RE.match(k) for k in r):
            issues.append({"code": "unknown_column", "path": f"records[{i}]"})
            continue
        nk = tuple(r[k] for k in natural_key)
        if any(x is None for x in nk):
            issues.append({"code": "natural_key_null", "path": f"records[{i}]"})
        elif nk in seen:
            issues.append({"code": "natural_key_duplicate", "path": f"records[{i}]"})
        seen.add(nk)
        if deleted_column and not isinstance(r[deleted_column], bool):
            issues.append({"code": "shape", "path": f"records[{i}].{deleted_column}"})
    return issues
