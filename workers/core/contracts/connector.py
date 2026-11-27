"""Connector contract 0.2.0 (design 0003 §3.1). A connector reaches the network only through `ctx.http()`.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
from datetime import datetime
from typing import Any, Literal, Protocol, TypedDict

from .classes import DataClass


class ConnectorManifest(TypedDict):
    source_id: str  # same id in tenant.yaml, core.data_source, bundles and figures
    name: str
    terms_url: str
    robots: str
    auth: Literal["none", "api_key"]  # "oauth" is not supported in P1
    auth_secret_ref: str | None  # required iff auth == "api_key"
    auth_header: str | None  # header the key goes in, e.g. "X-Api-Key"
    hosts: list[str]  # exact HTTPS host names this source may reach
    rate_limit_per_min: int
    data_class: DataClass
    natural_key: list[str]
    target_table: str  # "mod_<short>.<table>" in the connector's own module schema
    sync: Literal["incremental", "snapshot"]
    deleted_column: str | None  # required iff sync == "incremental": records with it true delete the stored row


class Resource(TypedDict):
    id: str
    url: str


class Response(TypedDict):
    status: int
    headers: dict[str, str]
    body: bytes
    raw_ref: str  # sha256 hex of body, recorded in the raw layer before the response is returned


class Http(Protocol):
    def get(self, url: str, params: dict[str, str] | None = None,
            headers: dict[str, str] | None = None) -> Response: ...


class ConnectorContext(Protocol):
    """All a connector receives: no secrets, no AI, no transactions, no data parts."""

    source_id: str
    params: dict[str, Any]  # tenant.yaml connectors[].params, already validated against params_schema

    def http(self) -> Http: ...


class RawBatch(TypedDict):
    resource: Resource
    fetched_at: datetime
    items: list[Any]
    cursor: dict[str, Any] | None
    raw_refs: list[str]  # raw_ref of every Response used to build the batch


Record = dict[str, Any]


class Issue(TypedDict):
    code: str  # ^[a-z][a-z0-9_]{0,40}$
    path: str  # a field path such as "records[12].codigo", never a value


class ValidationReport(TypedDict):
    errors: list[Issue]
    warnings: list[Issue]


class UpsertStats(TypedDict):
    inserted: int
    updated: int
    unchanged: int


class Connector(Protocol):
    """Synchronous. The runner owns transactions, the cursor, core.data_source_run and the writes to target_table."""

    manifest: ConnectorManifest
    params_schema: dict[str, Any]  # JSON Schema subset; additionalProperties: false at every object level

    def discover(self, ctx: ConnectorContext) -> list[Resource]: ...
    def fetch(self, resource: Resource, cursor: dict[str, Any] | None, ctx: ConnectorContext) -> RawBatch: ...
    def normalize(self, raw: RawBatch) -> list[Record]: ...
    def validate(self, records: list[Record]) -> ValidationReport: ...
