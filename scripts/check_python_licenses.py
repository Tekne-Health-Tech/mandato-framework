"""Transitive license check of the worker's Python dependencies (design 0003 §10).

Every distribution pinned in workers/requirements.txt must be installed at that version, have a reviewed SPDX
license below, that license must be in the allow-list of .github/workflows/ci.yml, and its own metadata must not
mention a copyleft license. A new or upgraded pin fails until someone reviews it and adds it here.
Usage: python scripts/check_python_licenses.py   (exit 1 on any finding)
"""
import pathlib
import re
import sys
from importlib.metadata import PackageNotFoundError, metadata, version

ROOT = pathlib.Path(__file__).resolve().parents[1]
REVIEWED = {   # (distribution, version): SPDX, checked against the package's LICENSE file at selection time
    ("pg8000", "1.31.6"): "BSD-3-Clause",
    ("scramp", "1.5.0"): "MIT-0",
    ("asn1crypto", "1.5.1"): "MIT",
    ("python-dateutil", "4.0.0"): "BSD-3-Clause",   # dual Apache-2.0 / BSD-3-Clause; either is allowed
    ("tzdata", "2026.6"): "Apache-2.0",
}
COPYLEFT = re.compile(r"\b(A|L)?GPL|copyleft|EUPL|SSPL|CDDL", re.I)


def allowed() -> set[str]:
    m = re.search(r"allow-licenses:\s*(.+)", (ROOT / ".github/workflows/ci.yml").read_text())
    return {x.strip() for x in m.group(1).split(",")} if m else set()


def main() -> int:
    ok, bad = allowed(), []
    for line in (ROOT / "workers/requirements.txt").read_text().splitlines():
        m = re.match(r"^([A-Za-z0-9_.-]+)==([^\s]+)", line)
        if not m:
            continue
        dist, ver = m.groups()
        try:
            got = version(dist)
        except PackageNotFoundError:
            bad.append(f"{dist}: not installed"); continue
        if got != ver:
            bad.append(f"{dist}: installed {got}, pinned {ver}")
        spdx = REVIEWED.get((dist, ver))
        if not spdx:
            bad.append(f"{dist}=={ver}: license not reviewed")
        elif spdx not in ok:
            bad.append(f"{dist}=={ver}: {spdx} not in the allow-list")
        md = metadata(dist)
        text = " ".join([md.get("License-Expression") or "", md.get("License") or "", *(md.get_all("Classifier") or [])])
        if COPYLEFT.search(text):
            bad.append(f"{dist}: metadata mentions a copyleft license")
    for b in bad:
        print(f"python licenses: {b}")
    if not bad:
        print("OK: worker Python dependencies are pinned, reviewed and allowed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
