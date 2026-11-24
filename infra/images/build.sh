#!/usr/bin/env bash
# Builds the instance images (design 0004 §7) from the repository root: mandato-worker:<tag> and mandato-tools:<tag>.
# Usage: infra/images/build.sh [tag]   (default tag: dev)
# Behind a TLS-intercepting proxy, set EXTRA_CA=/path/to/ca.pem; it is passed as a build secret, never stored in a layer.
# Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TAG=${1:-dev}
python3 "$ROOT/scripts/check_images.py"
args=()
if [ -n "${EXTRA_CA:-}" ]; then args+=(--secret "id=extra_ca,src=$EXTRA_CA"); fi
for p in HTTPS_PROXY HTTP_PROXY NO_PROXY; do
  if [ -n "${!p:-}" ]; then args+=(--build-arg "$p=${!p}"); fi
done
if [ -n "${HTTPS_PROXY:-}" ]; then args+=(--network host); fi
for img in worker tools; do
  docker build "${args[@]}" -f "$ROOT/infra/images/$img/Dockerfile" -t "mandato-$img:$TAG" "$ROOT"
done
