"""Runtime test module (design 0004 §10): jobs that exercise every loop outcome. Not a real module."""
import time
from dataclasses import dataclass
from typing import Any

from workers.core.contracts.classes import DataClass


@dataclass
class Result:
    ok: Any
    detail: Any = ""


class _Job:
    data_class = DataClass.C1
    concurrency = 1

    def __init__(self, name, fn, data_class=DataClass.C1):
        self.queue, self.fn, self.data_class = f"rt.{name}", fn, data_class

    def run(self, payload, ctx):
        return self.fn(payload, ctx)


def _sleep(payload, ctx):
    time.sleep(float(payload.get("s", 1)))
    return Result(True, "slept")


def _tx_sleep(payload, ctx):
    with ctx.tx() as c:
        c.run("insert into mod_hello.exemplo_item (codigo, nome, valor) values (:c, 'rt', 1)", c=payload["codigo"])
        time.sleep(float(payload.get("s", 30)))
    return Result(True)


def _raise(payload, ctx):
    raise RuntimeError("secret value that must not be logged")


jobs = [
    _Job("ok", lambda p, c: Result(True, "olá")),
    _Job("fail_text", lambda p, c: Result(False, "olá, falhou")),
    _Job("fail_code", lambda p, c: Result(False, "upstream_down")),
    _Job("raises", _raise),
    _Job("none_result", lambda p, c: None),
    _Job("sleep", _sleep),
    _Job("tx_sleep", _tx_sleep),
    _Job("secret", lambda p, c: Result(True, c.secret("x"))),
    _Job("c2", lambda p, c: Result(True), DataClass.C2),
]
connectors: list[Any] = []
