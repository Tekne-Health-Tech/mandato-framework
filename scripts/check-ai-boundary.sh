#!/usr/bin/env bash
# Static AI boundary checks (design 0001 §7.5): defense in depth behind the network isolation.
# Module worker code may not import provider SDKs or HTTP clients, build ClassifiedPart or reach the loader token,
# or instantiate providers / the gateway. Provider adapters live under a `providers/` directory and are exempt
# from the import rule only. Usage: scripts/check-ai-boundary.sh [root ...]  (default: module worker code)
set -uo pipefail
cd "$(dirname "$0")/.."
roots=("$@"); [ ${#roots[@]} -eq 0 ] && roots=(tenants workers)
files=$(find "${roots[@]}" -name '*.py' -not -path 'workers/core/contracts/*' -not -path 'workers/core/tests/*' | sort)
bad=0
report() { echo "AI boundary: $1"; bad=1; }
for f in $files; do
  case $f in */providers/*) ;; *)
    grep -nE '^\s*(import|from)\s+(anthropic|openai|google\.genai|google\.generativeai|httpx|requests|aiohttp|urllib3|urllib\.request|http\.client|socket)\b' "$f" \
      | while read -r l; do echo "AI boundary: $f:$l (provider SDK or network client outside providers/)"; done | grep . && bad=1
  esac
  grep -nE '_LOADER_TOKEN|ClassifiedPart\(' "$f" | while read -r l; do echo "AI boundary: $f:$l (parts come only from the loaders)"; done | grep . && bad=1
  grep -nE '\b(AiGateway|[A-Za-z]*Provider)\(' "$f" | grep -vE '^\s*[0-9]+:\s*class ' \
    | while read -r l; do echo "AI boundary: $f:$l (only the framework instantiates providers and the gateway)"; done | grep . && bad=1
done
[ $bad -eq 0 ] && echo "OK: AI boundary holds in ${roots[*]}"
exit $bad
