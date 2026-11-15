"""AI gateway contract (design 0001 §7.5).

Closed modules implement AiProvider and ProviderRouter; the framework owns AiGateway and the guard.
Locality and class ceilings come from the operator list in tenant.yaml (`ai.providers`), never from
provider code. The hard boundary is isolation: workers have no internet egress, each provider runs in
its own sidecar, and each data class has its own worker pool and database role.
"""

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Callable, Literal, Protocol

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


_LOADER_TOKEN = object()  # private; modules get parts only from the loaders below (CI forbids importing it)


def text_part(text: str, job_class: DataClass) -> ClassifiedPart:
    """Loader `ctx.text_part`: the part carries the job's class, never lower."""
    return ClassifiedPart("text", text, job_class, _token=_LOADER_TOKEN)


def column_part(text: str, column_class: DataClass | str | None) -> ClassifiedPart:
    """Loader `ctx.load_part`: the class is the column's Appendix A class; unknown means C3."""
    cls = column_class if isinstance(column_class, DataClass) else DataClass.parse(column_class)
    return ClassifiedPart("text", text, cls, _token=_LOADER_TOKEN)


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
    if entry.locality == "local" and not all(LOCAL_HOST.match(h) for h in entry.egress):
        raise AiRefused(f"local provider {provider_id} lists a non-private egress host")
    return effective, entry


# Same rule as tenant.schema.json $defs.localHost: a "local" provider may reach only private hosts.
LOCAL_HOST = re.compile(r"^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.(internal|local|lan)|10(\.[0-9]{1,3}){3}"
                        r"|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2})(:[0-9]+)?$")

ProvenanceWriter = Callable[[str, str, str, str], str]   # (task, provider_id, model, input_sha256) -> provenance id


class AiGateway:
    """Framework-owned and the only path from a job to a provider (§7.5). Not an extension point.

    Providers are registered here by the framework from the modules' `worker.providers`; module code never holds a
    provider object. Every call runs the guard first and writes provenance (hash only, never text).
    """

    def __init__(self, router: ProviderRouter, providers: dict[str, AiProvider],
                 operator: dict[str, OperatorProvider], write_provenance: ProvenanceWriter) -> None:
        self._router, self._providers = router, dict(providers)
        self._operator, self._write = dict(operator), write_provenance

    def generate(self, task: str, job_class: DataClass, parts: list[ClassifiedPart],
                 output_schema: dict[str, Any]) -> AiResult:
        if not all(isinstance(p, ClassifiedPart) for p in parts):
            raise AiRefused("parts must come from the framework loaders")
        effective = max([job_class, *(p.data_class for p in parts)])
        provider_id = self._router.route(task, effective)
        check(task, job_class, parts, provider_id, self._operator)
        provider = self._providers.get(provider_id)  # type: ignore[arg-type]
        if provider is None:
            raise AiRefused(f"provider {provider_id} is not registered with the gateway")
        digest = hashlib.sha256(json.dumps([p.kind for p in parts] + [p._content for p in parts],
                                           ensure_ascii=False).encode("utf-8")).hexdigest()
        result = provider.generate(task, parts, output_schema)
        provenance_id = self._write(task, provider_id, result.model, digest)  # type: ignore[arg-type]
        return AiResult(result.output, provider_id, result.model, result.tokens_in, result.tokens_out, provenance_id)


class FixedRouter:
    """Routes every task to one provider id. For the demo and CI; real routers live in closed modules."""

    def __init__(self, provider_id: str) -> None:
        self._id = provider_id

    def route(self, task: str, effective_class: DataClass) -> str | None:
        return self._id


class NoneRouter:
    def route(self, task: str, effective_class: DataClass) -> str | None:
        return None


class NoneProvider:
    """Refuses everything. The default when an instance configures no provider."""

    id = "none"

    def generate(self, task: str, parts: list[ClassifiedPart], output_schema: dict[str, Any]) -> AiResult:
        raise AiRefused("no AI provider is configured")


class EchoProvider:
    """Deterministic local provider for CI and the demo tenant. Contains no prompts."""

    id = "echo"

    def generate(self, task: str, parts: list[ClassifiedPart], output_schema: dict[str, Any]) -> AiResult:
        return AiResult(output={"task": task, "parts": len(parts)}, provider_id=self.id, model="echo-1",
                        tokens_in=0, tokens_out=0, provenance_id="")
