"""AI gateway contract (design 0001 §7.5).

Closed modules implement AiProvider and ProviderRouter; the framework owns AiGateway and the guard.
Locality and class ceilings come from the operator list in tenant.yaml (`ai.providers`), never from
provider code. The hard boundary is isolation: workers have no internet egress, each provider runs in
its own sidecar, and each data class has its own worker pool and database role.
"""

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .classes import DataClass

PartKind = Literal["text", "image", "audio"]


class ClassifiedPart:
    """Opaque input part. Built only by JobContext loaders; its class can be raised, never lowered."""

    __slots__ = ("_kind", "_content", "_class")

    def __init__(self, kind: PartKind, content: str, data_class: DataClass, *, _token: object) -> None:
        if _token is not _LOADER_TOKEN:
            raise TypeError("ClassifiedPart is built by the framework loaders only")
        self._kind, self._content, self._class = kind, content, data_class

    @property
    def kind(self) -> PartKind:
        return self._kind

    @property
    def data_class(self) -> DataClass:
        return self._class

    def at_least(self, data_class: DataClass) -> "ClassifiedPart":
        return ClassifiedPart(self._kind, self._content, max(self._class, data_class), _token=_LOADER_TOKEN)


_LOADER_TOKEN = object()  # held by the framework loader module; not part of the public contract


@dataclass(frozen=True)
class OperatorProvider:
    """One entry of tenant.yaml `ai.providers`."""

    id: str
    locality: Literal["local", "external"]
    max_data_class: DataClass
    egress: tuple[str, ...]


@dataclass(frozen=True)
class AiResult:
    output: dict[str, Any]
    provider_id: str
    model: str
    tokens_in: int
    tokens_out: int
    provenance_id: str


class AiProvider(Protocol):
    id: str

    def generate(self, task: str, parts: list[ClassifiedPart], output_schema: dict[str, Any]) -> AiResult: ...


class ProviderRouter(Protocol):
    def route(self, task: str, effective_class: DataClass) -> str | None: ...


class AiRefused(Exception):
    pass


def check(task: str, job_class: DataClass, parts: list[ClassifiedPart], provider_id: str | None,
          operator: dict[str, OperatorProvider]) -> tuple[DataClass, OperatorProvider]:
    """The fail-closed guard. Runs before any network call; raises AiRefused on any doubt."""
    if "." not in task:
        raise AiRefused("task must be <module short>.<task>")
    effective = max([job_class, *(p.data_class for p in parts)])
    if provider_id is None:
        raise AiRefused("no provider routed")
    entry = operator.get(provider_id)
    if entry is None:
        raise AiRefused(f"provider {provider_id} is not in the operator list")
    if effective > entry.max_data_class:
        raise AiRefused(f"{effective.name} exceeds {provider_id} ceiling {entry.max_data_class.name}")
    if effective == DataClass.C3 and entry.locality != "local":
        raise AiRefused("C3 data may only reach local providers")
    return effective, entry


class AiGateway(Protocol):
    def generate(self, task: str, parts: list[ClassifiedPart], output_schema: dict[str, Any]) -> AiResult: ...


class NoneRouter:
    def route(self, task: str, effective_class: DataClass) -> str | None:
        return None


class EchoProvider:
    """Deterministic local provider for CI and the demo tenant. Contains no prompts."""

    id = "echo"

    def generate(self, task: str, parts: list[ClassifiedPart], output_schema: dict[str, Any]) -> AiResult:
        return AiResult(output={"task": task, "parts": len(parts)}, provider_id=self.id, model="echo-1",
                        tokens_in=0, tokens_out=0, provenance_id="")
