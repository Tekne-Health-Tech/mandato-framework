"""Instance registry (design 0004 §4.2, §4.3, §5.1): which jobs, connectors and schedules this instance runs.

Input is `instance.json`, rendered from tenant.yaml by `mandato instance render` (the JS loader owns YAML parsing and
validation). Module workers are imported from the `worker` path of their manifest, under a private module name, and
must export `jobs` and `connectors` lists (contract 0.2.0); nothing is imported from a free-form string.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import importlib.util
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from workers.core.connectors.loader import ConnectorRefused, check_connector, check_registry

from .cron import Cron, CronError, parse

POOL_OF = {"C0": "c1", "C1": "c1", "C2": "c2", "C3": "c3"}
CONNECTOR_QUEUE = "core.connector_run"
NOOP_QUEUE = "core.noop"
# core.takedown is claimed by the takedown command itself (design 0003 §10), never by the loop.
BUILTIN_QUEUES = {"c1": [CONNECTOR_QUEUE, NOOP_QUEUE], "c2": [NOOP_QUEUE], "c3": [NOOP_QUEUE]}


class RegistryError(Exception):
    pass


@dataclass(frozen=True)
class Schedule:
    identity: str        # conn:<source_id> | mod:<short>.<id>
    queue: str
    data_class: str
    cron: Cron
    payload: dict
    expr: str = ""        # the cron expression, kept for runtime.json


@dataclass
class Registry:
    slug: str
    env: str
    timezone: str
    jobs: dict[str, Any] = field(default_factory=dict)                     # queue -> Job
    connectors: dict[str, tuple[Any, str]] = field(default_factory=dict)  # source_id -> (connector, module short)
    tenant_connectors: dict[str, dict] = field(default_factory=dict)      # source_id -> tenant.yaml entry
    enabled_sources: set[str] = field(default_factory=set)
    schedules: list[Schedule] = field(default_factory=list)
    missing_sources: list[str] = field(default_factory=list)              # in tenant.yaml, no connector installed

    def pools(self) -> list[str]:
        classes = {_cls(j) for j in self.jobs.values()} | {_cls(c) for c, _ in self.connectors.values()}
        return sorted({"c1"} | {POOL_OF[c] for c in classes})

    def queues(self, pool: str) -> list[str]:
        own = [q for q, j in self.jobs.items() if POOL_OF[_cls(j)] == pool]
        return sorted(own + BUILTIN_QUEUES[pool])


def _cls(obj) -> str:
    dc = obj.manifest["data_class"] if hasattr(obj, "manifest") else obj.data_class
    return class_name(dc)


def class_name(dc) -> str:
    """'C0'..'C3' from a DataClass member or its name."""
    return dc.name if hasattr(dc, "name") else str(dc)


def _import(path: Path, name: str):
    init = path / "__init__.py"
    if not init.is_file():
        raise RegistryError(f"module worker {path} has no __init__.py")
    spec = importlib.util.spec_from_file_location(name, init, submodule_search_locations=[str(path)])
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


def load_registry(instance_json: str | Path, tenant_root: str | Path | None = None) -> Registry:
    p = Path(instance_json)
    doc = json.loads(p.read_text(encoding="utf-8"))
    root = Path(tenant_root or doc["tenant_root"]).resolve()
    reg = Registry(slug=doc["slug"], env=doc["env"], timezone=doc["timezone"])
    overrides = doc.get("schedule_overrides") or {}
    module_schedules = []
    for m in doc["modules"]:
        if not m.get("worker"):
            continue
        wdir = (root / m["worker"]).resolve()
        if root not in wdir.parents:
            raise RegistryError(f"module {m['id']}: worker path leaves the tenant")
        mod = _import(wdir, f"mandato_mod_{m['short']}")
        for j in getattr(mod, "jobs", []):
            if not j.queue.startswith(f"{m['short']}.") or j.queue in reg.jobs:
                raise RegistryError(f"module {m['id']}: job queue {j.queue} is not its own or is duplicated")
            if _cls(j) not in POOL_OF:
                raise RegistryError(f"module {m['id']}: job {j.queue} has no data class")
            reg.jobs[j.queue] = j
        for c in getattr(mod, "connectors", []):
            sid = c.manifest["source_id"]
            if sid in reg.connectors:
                raise RegistryError(f"connector {sid} is declared twice")
            if _cls(c) not in ("C0", "C1"):
                raise RegistryError(f"connector {sid}: C2/C3 sources are not supported in this lane (design 0004 §4.3)")
            reg.connectors[sid] = (c, m["short"])
        for s in m.get("schedules") or []:
            module_schedules.append((m["short"], s))
    try:
        check_registry(list(reg.connectors.values()))
    except ConnectorRefused as e:
        raise RegistryError(f"connector registry refused: {e.code}") from None
    for short, s in module_schedules:
        key = f"{short}.{s['id']}"
        job = reg.jobs.get(s["queue"])
        if job is None:   # a schedule whose queue has no registered job could never be claimed (design 0004 §5.1)
            raise RegistryError(f"schedule {key}: queue {s['queue']} has no registered job")
        if not overrides.get(key, {}).get("enabled", True):
            continue
        reg.schedules.append(Schedule(f"mod:{key}", s["queue"], _cls(job), _cron(s["cron"], key), dict(s.get("payload") or {}),
                                      s["cron"]))
    for c in doc.get("connectors") or []:
        sid = c["source_id"]
        reg.tenant_connectors[sid] = c
        if sid not in reg.connectors:
            reg.missing_sources.append(sid)
            continue
        connector, short = reg.connectors[sid]
        try:
            check_connector(connector, short, c.get("params"))
        except ConnectorRefused as e:
            raise RegistryError(f"connector {sid} refused: {e.code}") from None
        if not c.get("enabled", True):
            continue
        reg.enabled_sources.add(sid)
        reg.schedules.append(Schedule(f"conn:{sid}", CONNECTOR_QUEUE, _cls(connector), _cron(c["schedule"], sid),
                                      {"source_id": sid}, c["schedule"]))
    return reg


def runtime_doc(reg: Registry) -> dict:
    """What the scheduler and the fetch sidecar need, as data (design 0004 §4.2): they read this file and never import
    module code, which runs only inside the workers' trust boundary (and in the probe that writes this file)."""
    def manifest(m: dict) -> dict:
        return {k: (class_name(v) if k == "data_class" else v) for k, v in m.items()}
    return {"slug": reg.slug, "env": reg.env, "timezone": reg.timezone,
            "schedules": [{"identity": s.identity, "queue": s.queue, "data_class": s.data_class, "cron": s.expr,
                           "payload": s.payload} for s in reg.schedules],
            "connectors": {sid: manifest(reg.connectors[sid][0].manifest) for sid in sorted(reg.enabled_sources)}}


def _cron(expr: str, what: str) -> Cron:
    try:
        return parse(expr)
    except CronError as e:
        raise RegistryError(f"schedule {what}: {e}") from None


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="Print what an instance needs (used by `mandato instance up`).")
    ap.add_argument("instance_json")
    ap.add_argument("--tenant-root")
    a = ap.parse_args()
    try:
        reg = load_registry(a.instance_json, a.tenant_root)
    except (RegistryError, OSError, KeyError, ValueError) as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    print(json.dumps({"pools": reg.pools(), "queues": {p: reg.queues(p) for p in reg.pools()},
                      "enabled_sources": sorted(reg.enabled_sources), "missing_sources": reg.missing_sources,
                      "schedules": [s.identity for s in reg.schedules],
                      "egress_hosts": sorted({h for s in reg.enabled_sources for h in reg.connectors[s][0].manifest["hosts"]}),
                      "secret_refs": sorted({c.manifest["auth_secret_ref"] for c, _ in reg.connectors.values()
                                             if c.manifest.get("auth") == "api_key"}),
                      "runtime": runtime_doc(reg)}))


if __name__ == "__main__":
    main()
