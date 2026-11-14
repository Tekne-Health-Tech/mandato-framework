#!/usr/bin/env bash
# ADR-0012: the framework never depends on closed modules or on a mandate's config.
set -euo pipefail
pattern='mandato-pro|mandato-config|@tekne/pro|tekne_pro'
hits=$(git ls-files -z | grep -zv -E '^(scripts/check-boundaries\.sh|AGENTS\.md|README\.md|CONTRIBUTING\.md|CLA\.md|\.github/)' \
  | xargs -0 -r grep -HnE "$pattern" -- || true)
if [ -n "$hits" ]; then
  echo "Framework must not reference closed modules or mandate config (ADR-0012):"
  echo "$hits"
  exit 1
fi
echo "OK: no references to mandato-pro or mandato-config."
