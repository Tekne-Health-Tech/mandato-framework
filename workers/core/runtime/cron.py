"""Minimal cron for the scheduler (design 0004 §4). Five fields; `*`, numbers, lists, ranges and steps on `*` or a range.
No names, no `L`/`W`/`#`, no `@` macros. Day-of-month and day-of-week combine as in Vixie cron: when both are
restricted, a day matches if either matches. Times are wall-clock in the instance timezone.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

MAX_CATCH_UP_MIN = 60
_BOUNDS = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)]
_PART = re.compile(r"^(\*|\d{1,2}|\d{1,2}-\d{1,2})(?:/(\d{1,2}))?$")


class CronError(ValueError):
    pass


@dataclass(frozen=True)
class Cron:
    minute: frozenset
    hour: frozenset
    dom: frozenset
    month: frozenset
    dow: frozenset          # 0 = Sunday
    dom_any: bool
    dow_any: bool

    def matches(self, t: datetime) -> bool:
        if t.minute not in self.minute or t.hour not in self.hour or t.month not in self.month:
            return False
        dom_ok = t.day in self.dom
        dow_ok = (t.isoweekday() % 7) in self.dow
        if self.dom_any or self.dow_any:
            return dom_ok and dow_ok
        return dom_ok or dow_ok


def _field(text: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in text.split(","):
        m = _PART.match(part)
        if not m:
            raise CronError("bad field")
        base, step = m.group(1), m.group(2)
        if base == "*":
            a, b = lo, hi
        elif "-" in base:
            a, b = (int(x) for x in base.split("-"))
        else:
            if step is not None:
                raise CronError("step needs * or a range")
            a = b = int(base)
        n = int(step) if step is not None else 1
        if n < 1 or a > b or a < lo or b > hi:
            raise CronError("out of range")
        out.update(range(a, b + 1, n))
    return out


def parse(expr: str) -> Cron:
    fields = expr.split()
    if len(fields) != 5:
        raise CronError("need 5 fields")
    vals = [_field(f, lo, hi) for f, (lo, hi) in zip(fields, _BOUNDS)]
    dow = {0 if d == 7 else d for d in vals[4]}
    return Cron(*(frozenset(v) for v in vals[:4]), frozenset(dow), fields[2] == "*", fields[4] == "*")


def due_minutes(spec: Cron, tz: str, last_check: datetime | None, now: datetime) -> list[datetime]:
    """UTC minutes in (last_check, now] at which `spec` fires in `tz`, at most the last 60. No last check: only now."""
    try:
        zone = ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError):
        raise CronError("unknown timezone") from None
    end = now.astimezone(timezone.utc).replace(second=0, microsecond=0)
    floor = end - timedelta(minutes=MAX_CATCH_UP_MIN - 1)
    if last_check is None:
        start = end
    else:
        start = max(last_check.astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1), floor)
    out, t = [], start
    while t <= end:
        if spec.matches(t.astimezone(zone)):
            out.append(t)
        t += timedelta(minutes=1)
    return out
