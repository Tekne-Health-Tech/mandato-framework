from datetime import datetime
from typing import Any, Literal, Protocol, TypedDict

from .classes import DataClass
from .job import JobContext, Tx


class ConnectorManifest(TypedDict):
    source_id: str  # same id in tenant.yaml, core.data_source, bundles and figures
    name: str
    terms_url: str
    robots: str
    auth: Literal["none", "api_key", "oauth"]
    auth_secret_ref: str | None
    rate_limit_per_min: int
    data_class: DataClass
    natural_key: list[str]


class Resource(TypedDict):
    id: str
    url: str


class RawBatch(TypedDict):
    resource: Resource
    fetched_at: datetime
    items: list[Any]
    cursor: dict[str, Any] | None


Record = dict[str, Any]


class ValidationReport(TypedDict):
    errors: list[str]
    warnings: list[str]


class UpsertStats(TypedDict):
    inserted: int
    updated: int
    unchanged: int


class Connector(Protocol):
    """Synchronous. The runner owns the transaction, stores the cursor and writes core.data_source_run."""

    manifest: ConnectorManifest

    def discover(self, ctx: JobContext) -> list[Resource]: ...
    def fetch(self, resource: Resource, cursor: dict[str, Any] | None, ctx: JobContext) -> RawBatch: ...
    def normalize(self, raw: RawBatch) -> list[Record]: ...
    def validate(self, records: list[Record]) -> ValidationReport: ...
    def upsert(self, records: list[Record], tx: Tx) -> UpsertStats: ...  # idempotent on natural_key
