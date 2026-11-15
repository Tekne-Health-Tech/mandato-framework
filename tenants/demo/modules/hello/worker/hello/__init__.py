"""demo.hello worker: one C1 job, no AI, no personal data."""
from dataclasses import dataclass
from typing import Any

from workers.core.contracts.classes import DataClass


@dataclass
class Result:
    ok: bool
    detail: str


class Greet:
    queue = "hello.greet"
    data_class = DataClass.C1
    concurrency = 1

    def run(self, payload: dict[str, Any], ctx: Any) -> Result:
        return Result(ok=True, detail="olá")


jobs = [Greet()]
connectors: list[Any] = []
providers: list[Any] = []
