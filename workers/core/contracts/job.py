from contextlib import AbstractContextManager
from typing import Any, Protocol
from uuid import UUID

from .ai import AiGateway, ClassifiedPart
from .classes import DataClass


class Tx(Protocol):
    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> Any: ...


class JobResult(Protocol):
    ok: bool
    detail: str


class JobContext(Protocol):
    job_id: UUID
    data_class: DataClass  # the actor is derived by the database from the lease (§4.5)

    def tx(self) -> AbstractContextManager[Tx]:
        """Opens a transaction that starts with audit.bind_lease(token)."""
        ...

    def load_part(self, table: str, column: str, row_id: UUID) -> ClassifiedPart: ...
    def text_part(self, text: str) -> ClassifiedPart: ...
    def blob_part(self, storage_key: str) -> ClassifiedPart: ...
    def ai(self) -> AiGateway: ...
    def secret(self, ref: str) -> str: ...


class Job(Protocol):
    queue: str  # "<short>.<name>"
    data_class: DataClass
    concurrency: int

    def run(self, payload: dict[str, Any], ctx: JobContext) -> JobResult: ...
