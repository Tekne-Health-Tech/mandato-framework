#!/usr/bin/env bash
# Builds tenants/demo/published/ from the demo seed: fresh database, 0001, seed, projections read as worker_c1
# (proving the C1 pool's grants suffice), then bundles and a signed manifest. CI diffs the result against git.
# Usage: PGHOST=... PGPORT=... scripts/publish-demo.sh [outDir]
set -euo pipefail
cd "$(dirname "$0")/.."
DB=${DEMO_DB:-mandato_demo}; OUT=${1:-tenants/demo/published}
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
PSQL="psql -X -q -v ON_ERROR_STOP=1 -At"
psql -X -q -U postgres -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
$PSQL -U postgres -d "$DB" -f packages/db/test/supabase-shim.sql >/dev/null
$PSQL -U postgres -d "$DB" -f packages/db/migrations/0001_core.sql >/dev/null
$PSQL -U postgres -d "$DB" -f tenants/demo/seed.sql >/dev/null
for p in content agenda causes municipalities takedowns; do
  PGOPTIONS='-c timezone=UTC' $PSQL -U worker_c1 -d "$DB" -c "$(node scripts/publish-demo.js sql $p)" > "$TMP/$p.json"
done
node scripts/publish-demo.js build "$TMP" "$OUT"
