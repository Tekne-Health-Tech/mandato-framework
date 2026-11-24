"""Static AI boundary check (design 0001 §7.5), on the syntax tree so aliases do not hide anything.

Defense in depth only: the hard boundary is the network (workers have no egress, providers run in sidecars).
In module worker code (anything outside `providers/`, `workers/core/contracts/` and `workers/core/tests/`):
  - no provider SDK, HTTP or socket library, under any alias, and no dynamic import (`__import__`, `importlib`);
  - no import of provider code (`*.providers`), of any `*Provider`, of `AiGateway`, or of private names (`_x`);
  - no call to any `*Provider` or `AiGateway`, directly or through an alias, and no reference to them as an
    attribute at all (so `E = ai.EchoProvider` is caught where the name is taken, not only where it is called);
  - no `ClassifiedPart(...)`: parts come from the loaders `text_part` / `column_part`.
Usage: python3 scripts/check_ai_boundary.py [root ...]   (default: tenants workers). Exit 1 on any finding.
"""
import ast
import pathlib
import sys

FORBIDDEN_MODULES = ("anthropic", "openai", "google.genai", "google.generativeai", "httpx", "requests", "aiohttp",
                     "urllib3", "urllib.request", "http.client", "socket", "importlib")
# Framework-owned trees. workers/core/fetch is the fetch boundary itself (design 0003 §3): the only worker code that
# opens sockets. Module connectors stay under every rule above, so a connector cannot import a network library.
EXEMPT = ("workers/core/contracts/", "workers/core/tests/", "workers/core/fetch/", "workers/core/connectors/",
          "workers/core/testing/")


def forbidden_module(name: str) -> bool:
    return any(name == m or name.startswith(m + ".") for m in FORBIDDEN_MODULES) or ".providers" in f".{name}"


def forbidden_name(name: str) -> bool:
    return name.endswith("Provider") or name == "AiGateway" or name.startswith("_")


def check_file(path: pathlib.Path) -> list[str]:
    rel = path.as_posix()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=rel)
    in_providers = "/providers/" in f"/{rel}"
    out = []
    bad = lambda node, why: out.append(f"{rel}:{node.lineno}: {why}")
    aliases: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                aliases[(a.asname or a.name).split(".")[0]] = a.name
                if forbidden_module(a.name) and not in_providers:
                    bad(node, f"imports {a.name} (provider SDK, network client or dynamic import)")
        elif isinstance(node, ast.ImportFrom):
            mod = node.module or ""
            if forbidden_module(mod) and not in_providers:
                bad(node, f"imports from {mod}")
            for a in node.names:
                aliases[a.asname or a.name] = a.name
                if forbidden_name(a.name) and not in_providers:
                    bad(node, f"imports {a.name} from {mod or '.'}")
        elif isinstance(node, ast.Call):
            f = node.func
            target = aliases.get(f.id, f.id) if isinstance(f, ast.Name) else f.attr if isinstance(f, ast.Attribute) else ""
            if target == "__import__":
                bad(node, "dynamic import")
            elif target == "ClassifiedPart":
                bad(node, "builds a ClassifiedPart; use the loaders")
            elif forbidden_name(target) and not in_providers and not target.startswith("_"):
                bad(node, f"instantiates {target}; only the framework does")
        elif isinstance(node, ast.Attribute) and node.attr.startswith("_") and not node.attr.startswith("__") and not in_providers:
            bad(node, f"reaches private name {node.attr}")
        elif isinstance(node, ast.Attribute) and forbidden_name(node.attr) and not in_providers:
            bad(node, f"references {node.attr}; only the framework holds providers and the gateway")
    return out


def main(roots: list[str]) -> int:
    findings = []
    for root in roots or ["tenants", "workers"]:
        for p in sorted(pathlib.Path(root).rglob("*.py")):
            if not any(p.as_posix().startswith(e) for e in EXEMPT):
                findings += check_file(p)
    for f in findings:
        print(f"AI boundary: {f}")
    if not findings:
        print(f"OK: AI boundary holds in {' '.join(roots or ['tenants', 'workers'])}")
    return 1 if findings else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
