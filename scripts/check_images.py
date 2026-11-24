"""Image gate (design 0004 §7): every Dockerfile FROM is digest-pinned and listed in infra/images/lock.json, and every
lock entry was at least 14 days old when it was added; every GitHub Action is pinned by commit SHA and every
workflow service image by digest. Exit 1 with one line per problem.

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FROM = re.compile(r"^\s*FROM\s+(\S+)(?:\s+AS\s+\S+)?\s*$", re.I | re.M)
MIN_AGE_DAYS = 14
USES = re.compile(r"^\s*(?:-\s*)?uses:\s*(\S+)")
IMAGE = re.compile(r"^\s*image:\s*(\S+)")


def problems() -> list[str]:
    lock = json.loads((ROOT / "infra/images/lock.json").read_text())["images"]
    out = []
    by_ref = {}
    for e in lock:
        by_ref[f"{e['name']}:{e['tag']}@{e['digest']}"] = e
        if not re.fullmatch(r"sha256:[0-9a-f]{64}", e["digest"]) or not e.get("platforms"):
            out.append(f"lock {e['name']}:{e['tag']}: digest or platforms missing")
        if (date.fromisoformat(e["added"]) - date.fromisoformat(e["released"])).days < MIN_AGE_DAYS:
            out.append(f"lock {e['name']}:{e['tag']}: released {e['released']}, added {e['added']}: younger than {MIN_AGE_DAYS} days")
    for df in sorted((ROOT / "infra/images").glob("*/Dockerfile")):
        for ref in FROM.findall(df.read_text()):
            if "@sha256:" not in ref:
                out.append(f"{df.relative_to(ROOT)}: FROM {ref} is not digest-pinned")
            elif ref not in by_ref:
                out.append(f"{df.relative_to(ROOT)}: FROM {ref} is not in infra/images/lock.json")
    for wf in sorted((ROOT / ".github/workflows").glob("*.yml")):
        for n, line in enumerate(wf.read_text().splitlines(), 1):
            m = USES.match(line)
            if m and not m.group(1).startswith("./") and not re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", m.group(1)):
                out.append(f"{wf.relative_to(ROOT)}:{n}: action {m.group(1)} is not pinned by commit SHA")
            m = IMAGE.match(line)
            if m and "@sha256:" not in m.group(1):
                out.append(f"{wf.relative_to(ROOT)}:{n}: image {m.group(1)} is not digest-pinned")
    return out


if __name__ == "__main__":
    p = problems()
    for line in p:
        print(line)
    print("images: ok" if not p else f"images: {len(p)} problems")
    sys.exit(1 if p else 0)
