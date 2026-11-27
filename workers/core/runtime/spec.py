"""Runtime spec (design 0004 §4.2): the data-only view of an instance that the scheduler and the fetch sidecar run on.

`mandato instance up` writes `runtime.json` from the registry probe (a worker-image container with no network and no
secrets). The scheduler and the sidecar load it here and never import module code: a module can only describe its
schedules and connectors, and every field is checked again before use.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from workers.core.connectors.loader import HEADER_RE, SOURCE_RE
from workers.core.fetch.policy import HOST_RE

from .cron import CronError, parse
from .registry import CONNECTOR_QUEUE, Schedule

QUEUE_RE = re.compile(r"^[a-z][a-z0-9]{1,15}\.[a-z][a-z0-9_]{0,40}$")
MOD_ID_RE = re.compile(r"^mod:([a-z][a-z0-9]{1,15})\.[a-z][a-z0-9_]{0,40}$")
SECRET_REF_RE = re.compile(r"^[a-z][a-z0-9_]{1,60}$")
MAX_PAYLOAD = 4096


class SpecError(Exception):
    pass


@dataclass
class RuntimeSpec:
    slug: str
    env: str
    timezone: str
    schedules: list[Schedule] = field(default_factory=list)
    connectors: dict[str, dict] = field(default_factory=dict)   # source_id -> fetch manifest (enabled only)


def check_fetch_manifest(sid: str, m: dict) -> dict:
    """The manifest fields the sidecar acts on: hosts, rate limit and credential. Anything else is dropped."""
    if not isinstance(m, dict) or m.get("source_id") != sid or not SOURCE_RE.match(sid):
        raise SpecError(f"connector {sid}: source_id")
    if m.get("data_class") not in ("C0", "C1"):
        raise SpecError(f"connector {sid}: data_class")
    hosts = m.get("hosts")
    if not isinstance(hosts, list) or not hosts or not all(isinstance(h, str) and HOST_RE.match(h) for h in hosts):
        raise SpecError(f"connector {sid}: hosts")
    rate = m.get("rate_limit_per_min")
    if not isinstance(rate, int) or isinstance(rate, bool) or not 1 <= rate <= 600:
        raise SpecError(f"connector {sid}: rate_limit_per_min")
    auth = m.get("auth")
    if auth == "none":
        if m.get("auth_secret_ref") is not None or m.get("auth_header") is not None:
            raise SpecError(f"connector {sid}: auth")
    elif auth == "api_key":
        if not isinstance(m.get("auth_secret_ref"), str) or not SECRET_REF_RE.match(m["auth_secret_ref"]) \
                or not isinstance(m.get("auth_header"), str) or not HEADER_RE.match(m["auth_header"]):
            raise SpecError(f"connector {sid}: auth")
    else:
        raise SpecError(f"connector {sid}: auth")
    return {"source_id": sid, "data_class": m["data_class"], "hosts": list(hosts), "rate_limit_per_min": rate,
            "auth": auth, "auth_secret_ref": m.get("auth_secret_ref"), "auth_header": m.get("auth_header")}


def check_schedule(s: dict, connectors: dict[str, dict]) -> Schedule:
    if not isinstance(s, dict):
        raise SpecError("schedule")
    ident, queue, dc, payload = s.get("identity"), s.get("queue"), s.get("data_class"), s.get("payload")
    if not isinstance(ident, str) or not isinstance(queue, str) or not QUEUE_RE.match(queue) or not isinstance(payload, dict):
        raise SpecError("schedule fields")
    if len(json.dumps(payload)) > MAX_PAYLOAD:
        raise SpecError(f"schedule {ident}: payload too large")
    if ident.startswith("conn:"):
        sid = ident[5:]
        if sid not in connectors or queue != CONNECTOR_QUEUE or payload != {"source_id": sid} \
                or dc != connectors[sid]["data_class"]:
            raise SpecError(f"schedule {ident}: not its connector's run")
    else:
        m = MOD_ID_RE.match(ident)
        if not m or not queue.startswith(f"{m.group(1)}.") or dc not in ("C0", "C1", "C2", "C3"):
            raise SpecError(f"schedule {ident}: not its module's queue")
    try:
        cron = parse(s.get("cron"))
    except (CronError, TypeError, AttributeError):
        raise SpecError(f"schedule {ident}: cron") from None
    return Schedule(ident, queue, dc, cron, dict(payload), s["cron"])


def load_runtime(path: str | Path) -> RuntimeSpec:
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        raise SpecError("document")
    connectors = {sid: check_fetch_manifest(sid, m) for sid, m in (doc.get("connectors") or {}).items()}
    spec = RuntimeSpec(slug=str(doc["slug"]), env=str(doc["env"]), timezone=str(doc["timezone"]), connectors=connectors)
    try:
        ZoneInfo(spec.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise SpecError("timezone") from None
    seen = set()
    for s in doc.get("schedules") or []:
        sch = check_schedule(s, connectors)
        if sch.identity in seen:
            raise SpecError(f"schedule {sch.identity}: duplicated")
        seen.add(sch.identity)
        spec.schedules.append(sch)
    return spec
