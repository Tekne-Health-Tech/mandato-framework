#!/usr/bin/env bash
# Network test (design 0004 §9): the release gate of design 0003 §3.4 for enabling connectors.
# Builds a local instance of a copy of the demo tenant with one connector pointed at a stand-in origin, puts a
# controlled "internet" on the `outside` network (allowed.test, other.test, a public-range subnet, a test CA trusted
# only by the fetch sidecar), and checks who can reach what, end to end.
# Usage: infra/compose/test-network.sh   (needs docker, node, openssl and the images mandato-worker:dev, mandato-tools:dev)
# Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
STATE="$ROOT/infra/.state/nettest-local"
T="$WORK/tenant"
pass=0; fail=0
ok()    { local name=$1; shift; if out=$("$@" 2>&1); then pass=$((pass+1)); echo "ok   - $name"; else fail=$((fail+1)); echo "FAIL - $name: ${out: -400}"; fi; }
fails() { local name=$1; shift; if out=$("$@" 2>&1); then fail=$((fail+1)); echo "FAIL - $name (expected a failure): ${out: -300}"; else pass=$((pass+1)); echo "ok   - $name"; fi; }

# ------------------------------------------------------------------ tenant copy with one connector
cp -r "$ROOT/tenants/demo" "$T"
rm -f "$T/.mandato-demo.env"
sed -i "s/values ('demo', /values ('nettest', /" "$T/seed.sql"
cp "$ROOT/infra/compose/test/nettest_connector.py" "$T/modules/hello/worker/hello/nettest.py"
sed -i 's/^connectors: list\[Any\] = \[\]$/from .nettest import ExemploItensNet\nconnectors: list[Any] = [ExemploItensNet()]/' "$T/modules/hello/worker/hello/__init__.py"
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs'; import { parse, stringify } from 'yaml';
const f = process.argv[1]; const t = parse(readFileSync(f, 'utf8'));
t.instance.slug = 'nettest';
t.connectors = [{ source_id: 'exemplo-itens', schedule: '0 6 1 * *', params: { uf: 'EX' } }];
writeFileSync(f, stringify(t));" "$T/tenant.yaml" || { echo "tenant copy failed"; exit 1; }

# ------------------------------------------------------------------ test CA and origin certificates
CA="$WORK/ca"; mkdir -p "$CA"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=mandato network test CA" -keyout "$CA/ca.key" -out "$CA/ca.pem" 2>/dev/null
for h in allowed.test other.test; do
  openssl req -newkey rsa:2048 -nodes -subj "/CN=$h" -keyout "$CA/$h.key" -out "$CA/$h.csr" 2>/dev/null
  printf "subjectAltName=DNS:%s\n" "$h" > "$CA/$h.ext"
  openssl x509 -req -in "$CA/$h.csr" -CA "$CA/ca.pem" -CAkey "$CA/ca.key" -CAcreateserial -days 2 -extfile "$CA/$h.ext" -out "$CA/$h.pem" 2>/dev/null
done
chmod 0644 "$CA"/*.key "$CA"/*.pem

# ------------------------------------------------------------------ bring the instance up
if [ -f "$STATE/compose.yaml" ]; then docker compose -f "$STATE/compose.yaml" down --volumes >/dev/null 2>&1; fi
rm -rf "$STATE"
cleanup() { docker compose -f "$STATE/compose.yaml" down --volumes >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
origin() { printf '{"image":"mandato-worker:dev","user":"10004:10004","read_only":true,"cap_drop":["ALL"],"security_opt":["no-new-privileges:true"],"command":["python","/srv/https_server.py","/srv/ca/%s.pem","/srv/ca/%s.key"],"volumes":["%s:/srv/https_server.py:ro","%s:/srv/ca:ro"],"networks":{"outside":{"ipv4_address":"%s","aliases":["%s"]}}}' \
  "$1" "$1" "$ROOT/infra/compose/test/https_server.py" "$CA" "$2" "$1"; }
EXTRA="{\"services\":{\"allowed-test\":$(origin allowed.test 11.0.0.10),\"other-test\":$(origin other.test 11.0.0.11)},\"networkPatch\":{\"outside\":{\"ipam\":{\"config\":[{\"subnet\":\"11.0.0.0/24\"}]}}}}"
echo "# instance up (local shape)"
ok "mandato instance up builds the instance" node --input-type=module -e "
const m = await import('$ROOT/infra/bootstrap/instance.mjs');
m.up(process.argv[1], { env: 'local', stateDir: process.argv[2], fetchCa: process.argv[3] + '/ca.pem', extra: JSON.parse(process.argv[4]) });" "$T" "$STATE" "$CA" "$EXTRA"
F="$STATE/compose.yaml"
DB=mandato_nettest_dev
ex()  { local svc=$1; shift; docker compose -f "$F" exec -T "$svc" "$@"; }
py()  { local svc=$1; shift; ex "$svc" python -c "$*"; }
sql() { docker compose -f "$F" run --rm -T --entrypoint psql tools -X -q -At -v ON_ERROR_STOP=1 -d "$DB" -c "$1" 2>/dev/null; }
TCP='import socket,sys; socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=3)'
DNS='import socket,sys; socket.getaddrinfo(sys.argv[1], 443)'

echo "# 1. no route out from workers and the scheduler"
for svc in worker-c1 scheduler; do
  fails "$svc: TCP to allowed.test:443"      ex $svc python -c "$TCP" allowed.test 443
  fails "$svc: TCP to an outside address"    ex $svc python -c "$TCP" 11.0.0.10 443
  fails "$svc: TCP to a public address"      ex $svc python -c "$TCP" 1.1.1.1 443
  fails "$svc: external names do not resolve" ex $svc python -c "$DNS" example.com
done

echo "# 2. what workers may reach"
ok "worker-c1: the database"     ex worker-c1 python -c "$TCP" postgres 5432
ok "worker-c1: its fetch socket" ex worker-c1 python -c "import os; assert os.path.exists('/run/mandato-fetch/fetch.sock')"
fails "worker-c1: no secrets mount beyond its own" ex worker-c1 sh -c "ls /run/secrets | grep -v '^pg_worker_c1$'"

echo "# 3. the fetch path"
fails "fetch-c1: raw TCP to allowed.test" ex fetch-c1 python -c "$TCP" 11.0.0.10 443
fails "fetch-c1: raw TCP to other.test"   ex fetch-c1 python -c "$TCP" 11.0.0.11 443
fails "fetch-c1: external names do not resolve" ex fetch-c1 python -c "$DNS" example.com
CONNECT='import socket,sys; s=socket.create_connection(("egress",3128),timeout=5); s.sendall(("CONNECT %s:443 HTTP/1.1\r\n\r\n" % sys.argv[1]).encode()); r=s.recv(64); print(r[:12]); sys.exit(0 if r.startswith(b"HTTP/1.1 200") else 1)'
ok    "egress tunnels to allowed.test"  ex fetch-c1 python -c "$CONNECT" allowed.test
fails "egress refuses other.test"       ex fetch-c1 python -c "$CONNECT" other.test
fails "egress refuses a metadata address" ex fetch-c1 python -c "$CONNECT" 169.254.169.254
LEASE='from workers.core.fetch.sidecar import SidecarHttp; import sys
try:
    SidecarHttp("/run/mandato-fetch/fetch.sock", sys.argv[1], lambda *a: "x").get("https://allowed.test/api/itens")
except Exception as e:
    print(getattr(e, "code", type(e).__name__)); sys.exit(1 if getattr(e, "code", "") == "lease_lost" else 2)'
fails "the sidecar refuses a forged lease" ex worker-c1 python -c "$LEASE" "$(printf 'ab%.0s' $(seq 32))"

echo "# 3b. end to end: a connector run goes worker -> sidecar -> egress -> origin and lands in its table"
sql "insert into core.job (id, queue, data_class, payload) values (core.uuid7(), 'core.connector_run', 'C0', '{\"source_id\":\"exemplo-itens\"}')" >/dev/null
for i in $(seq 1 60); do st=$(sql "select state from core.job where queue='core.connector_run' order by created_at desc limit 1"); [ "$st" = done ] && break; sleep 1; done
ok "the connector job is done"                 test "$st" = done
ok "its three records are in mod_hello.exemplo_item" test "$(sql 'select count(*) from mod_hello.exemplo_item')" = 3
ok "both responses were recorded as raw objects"     test "$(sql "select count(*) from core.raw_object where source_id='exemplo-itens'")" = 2
ok "the run is ok"                                    test "$(sql "select status from core.data_source_run where source_id='exemplo-itens' order by started_at desc limit 1")" = ok

echo "# 4. the socket and the secrets stay with their pool"
MOUNTS=$(for c in $(docker compose -f "$F" ps -q); do docker inspect -f '{{.Name}} {{range .Mounts}}{{.Destination}},{{end}}' "$c"; done)
ok "only worker-c1 and fetch-c1 mount the socket volume" bash -c "echo '$MOUNTS' | grep '/run/mandato-fetch' | grep -v -e worker-c1 -e fetch-c1 | wc -l | grep -qx 0"
ok "the scheduler and the fetch sidecar mount no tenant code" bash -c "echo '$MOUNTS' | grep -e scheduler -e fetch-c1 | grep -c /srv/tenant | grep -qx 0"
fails "the fetch sidecar cannot read module code" ex fetch-c1 ls /srv/tenant

echo "# 6. no root, pinned images"
for c in $(docker compose -f "$F" ps -q); do
  n=$(docker inspect -f '{{.Name}}' "$c"); u=$(docker inspect -f '{{.Config.User}}' "$c")
  ok "$n runs as a non-root uid ($u)" bash -c "[ -n '$u' ] && [ '${u%%:*}' != 0 ] && [ '${u%%:*}' != root ]"
done
for c in $(docker compose -f "$F" ps -q); do
  n=$(docker inspect -f '{{.Name}}' "$c")
  ok "$n has a read-only root filesystem and no capabilities" bash -c "[ \"\$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}}' $c)\" = 'true [ALL]' ]"
done
WID=$(docker image inspect -f '{{.Id}}' mandato-worker:dev)
ok "workers run the built image by content id" bash -c "[ \"\$(docker inspect -f '{{.Image}}' $(docker compose -f "$F" ps -q worker-c1))\" = '$WID' ]"
PG=$(docker inspect -f '{{.Config.Image}}' "$(docker compose -f "$F" ps -q postgres)")
ok "postgres runs the locked digest" bash -c "grep -q \"${PG##*@}\" '$ROOT/infra/images/lock.json'"
ok "every Dockerfile FROM is in the lock" python3 "$ROOT/scripts/check_images.py"

echo "# summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
