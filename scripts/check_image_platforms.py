"""Registry check of the image lock (design 0004 §7): each entry's index digest must list exactly the per-platform
digests recorded for linux/amd64 and linux/arm64. Needs docker with buildx and registry access (CI job `images`).

Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
"""
import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def platforms(ref: str) -> dict[str, str]:
    for attempt in range(4):   # registries rate-limit anonymous reads; retry with backoff
        r = subprocess.run(["docker", "buildx", "imagetools", "inspect", "--raw", ref], capture_output=True, text=True,
                           timeout=120)
        if r.returncode == 0:
            break
        time.sleep(5 * (attempt + 1))
    else:
        raise SystemExit(f"{ref}: registry read failed: {r.stderr.strip()[-200:]}")
    raw = r.stdout
    out = {}
    for m in json.loads(raw).get("manifests", []):
        p = m.get("platform") or {}
        if p.get("os") == "linux" and (p.get("architecture"), p.get("variant")) in (("amd64", None), ("arm64", None), ("arm64", "v8")):
            out[f"linux/{p['architecture']}"] = m["digest"]
    return out


def main() -> int:
    bad = 0
    for e in json.loads((ROOT / "infra/images/lock.json").read_text())["images"]:
        ref = f"{e['name']}@{e['digest']}"
        got = platforms(ref)
        if got != e["platforms"]:
            print(f"{e['name']}:{e['tag']}: lock platforms {e['platforms']} != registry {got}")
            bad += 1
    print("image platforms: ok" if not bad else f"image platforms: {bad} mismatched")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
