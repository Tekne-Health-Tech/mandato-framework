#!/usr/bin/env bash
# Applies 0001 to a fresh database and runs the adversarial checks of design 0001 §4 and §11.
# Usage: PGHOST=... PGPORT=... packages/db/test/run.sh
set -uo pipefail
cd "$(dirname "$0")"
DB=${TEST_DB:-mandato_test}
PSQL="psql -X -q -v ON_ERROR_STOP=1 -At"
CHIEF=00000000-0000-7000-8000-000000000001; COMM=00000000-0000-7000-8000-000000000002
PARL=00000000-0000-7000-8000-000000000003; REMOVED=00000000-0000-7000-8000-000000000005; NEWU=00000000-0000-7000-8000-000000000006
pass=0; fail=0
# Contract 0.1.1: aal2 counts only with a TOTP entry in amr, so the helper adds a fresh one (design 0002 §3).
claims() { printf '{"sub":"%s","aal":"%s","amr":[{"method":"totp","timestamp":%s}]}' "$1" "$2" "$(date +%s)"; }
# as ROLE CLAIMS SQL -> runs SQL in one transaction as login ROLE with JWT claims
as() { local role=$1 cl=$2; shift 2
  $PSQL -U "$role" -d "$DB" -c "begin; select set_config('request.jwt.claims', '$cl', true); $*; commit;" 2>&1; }
ok()   { local name=$1; shift; if out=$("$@"); then pass=$((pass+1)); echo "ok   - $name"; else fail=$((fail+1)); echo "FAIL - $name: $out"; fi; }
fails(){ local name=$1; shift; if out=$("$@"); then fail=$((fail+1)); echo "FAIL - $name (expected an error): $out"; else pass=$((pass+1)); echo "ok   - $name"; fi; }
equals(){ local name=$1 want=$2; shift 2; out=$("$@" | tail -1); if [ "$out" = "$want" ]; then pass=$((pass+1)); echo "ok   - $name"; else fail=$((fail+1)); echo "FAIL - $name: got '$out', want '$want'"; fi; }
sup() { $PSQL -U postgres -d "$DB" -c "$*" 2>&1; }

psql -X -q -U postgres -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
# A runtime role that already exists with dangerous attributes must come out of the migration hardened (§4.1).
psql -X -q -U postgres -d postgres >/dev/null 2>&1 <<'SQL'
do $$ begin if not exists (select 1 from pg_roles where rolname = 'worker_c1') then create role worker_c1 login; end if; end $$;
alter role worker_c1 bypassrls createdb createrole;
grant pg_read_all_data to worker_c1;
SQL
$PSQL -U postgres -d "$DB" -f supabase-shim.sql >/dev/null || { echo "shim failed"; exit 1; }
$PSQL -U postgres -d "$DB" -f ../migrations/0001_core.sql >/dev/null 2>&1 || { echo "migration failed"; exit 1; }
$PSQL -U postgres -d "$DB" -f seed-test.sql >/dev/null || { echo "seed failed"; exit 1; }
# The demo module's migration, applied by the real runner: bootstrap (owner role, schema) then migrate as migrator.
ROOT=$(cd ../../.. && pwd)
node "$ROOT/packages/core-config/bin/mandato.js" bootstrap "$ROOT/tenants/demo" "$DB" >/dev/null || { echo "mandato bootstrap failed"; exit 1; }
node "$ROOT/packages/core-config/bin/mandato.js" migrate "$ROOT/tenants/demo" "$DB" >/dev/null || { echo "mandato migrate failed"; exit 1; }

echo "# structure"
UNCLASSIFIED="select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where (n.nspname in ('core','audit') or n.nspname like 'mod\\_%') and c.relkind in ('r','u') and a.attnum>0 and not a.attisdropped and coalesce(col_description(c.oid,a.attnum),'') !~ '^class=C[0-3]\$'"
equals "every core/audit/module column has a class comment" 0 sup "$UNCLASSIFIED"
equals "the demo.hello module table was migrated" 1 sup "select count(*) from pg_class where relname='greeting_log' and relnamespace='mod_hello'::regnamespace"
equals "negative fixture: an unclassified module column is caught" 1 sup "begin; $(cat fixtures/unclassified-column.sql) $UNCLASSIFIED; rollback"
equals "prefixed columns meet their minimum class" 0 sup "select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('core','audit') and a.attnum>0 and ((a.attname like 'pii\\_%' and col_description(c.oid,a.attnum) < 'class=C2') or (a.attname ~ '^(phi|piim|enc)_' and col_description(c.oid,a.attnum) <> 'class=C3'))"
equals "C2+ columns carry a prefix" 0 sup "select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('core','audit') and a.attnum>0 and col_description(c.oid,a.attnum) in ('class=C2','class=C3') and a.attname !~ '^(pii|phi|piim|enc)_'"
equals "RLS enabled and forced on every table (core, audit, modules)" 0 sup "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where (n.nspname in ('core','audit') or n.nspname like 'mod\\_%') and c.relkind in ('r','u') and not (c.relrowsecurity and c.relforcerowsecurity)"
equals "no runtime role bypasses RLS" 0 sup "select count(*) from pg_roles where rolname in ('api_rt','worker_c1','worker_c2','worker_c3','migrator','core_owner','audit_owner') and (rolbypassrls or rolsuper)"
equals "anon/authenticated hold nothing in core or audit" 0 sup "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema in ('core','audit')"
equals "no SECURITY DEFINER in api" 0 sup "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='api' and p.prosecdef"
equals "worker_c1 cannot read any C2/C3 column" 0 sup "select count(*) from information_schema.column_privileges cp join pg_namespace n on n.nspname=cp.table_schema join pg_class c on c.relnamespace=n.oid and c.relname=cp.table_name join pg_attribute a on a.attrelid=c.oid and a.attname=cp.column_name where cp.grantee='worker_c1' and cp.privilege_type='SELECT' and col_description(c.oid,a.attnum) in ('class=C2','class=C3')"
equals "worker_c2 cannot read any C3 column" 0 sup "select count(*) from information_schema.column_privileges cp join pg_namespace n on n.nspname=cp.table_schema join pg_class c on c.relnamespace=n.oid and c.relname=cp.table_name join pg_attribute a on a.attrelid=c.oid and a.attname=cp.column_name where cp.grantee='worker_c2' and cp.privilege_type='SELECT' and col_description(c.oid,a.attnum)='class=C3' and not (c.relname='data_key')"

equals "a pre-existing runtime role loses dangerous attributes" 0 sup "select count(*) from pg_roles where rolname='worker_c1' and (rolbypassrls or rolcreatedb or rolcreaterole or rolsuper)"
equals "a pre-existing runtime role loses foreign memberships" 0 sup "select count(*) from pg_auth_members am join pg_roles m on m.oid=am.member where m.rolname in ('api_rt','worker_c1','worker_c2','worker_c3')"
equals "PostgREST exposes only api" "pgrst.db_schemas=api" sup "select array_to_string(setconfig, ',') from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = 'authenticator' and s.setdatabase = 0"
equals "anon/authenticated see no schema but api (PostgREST fail-closed)" 0 sup "select count(*) from pg_namespace n cross join (values ('anon'),('authenticated')) r(role) where has_schema_privilege(r.role, n.oid, 'USAGE') and n.nspname not in ('api','pg_catalog','information_schema','auth')"

# Bootstrap refuses a contract role that holds grants outside the contract (here: SELECT on public.secrets).
NEG=${DB}_neg
psql -X -q -U postgres -d postgres -c "drop database if exists $NEG" -c "create database $NEG" >/dev/null 2>&1
$PSQL -U postgres -d "$NEG" -f supabase-shim.sql >/dev/null
$PSQL -U postgres -d "$NEG" -c "create table public.secrets (x text); grant usage on schema public to worker_c1; grant select on public.secrets to worker_c1" >/dev/null
out=$($PSQL -U postgres -d "$NEG" -f ../migrations/0001_core.sql 2>&1 >/dev/null); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "bootstrap refused: contract roles hold privileges outside the contract.*public.secrets"; then
  pass=$((pass+1)); echo "ok   - bootstrap refuses a pre-existing role with grants outside the contract"
else fail=$((fail+1)); echo "FAIL - bootstrap refuses a pre-existing role with grants outside the contract: rc=$rc $out"; fi
psql -X -q -U postgres -d postgres -c "drop database $NEG" >/dev/null
# Same for a large object granted to a contract role.
psql -X -q -U postgres -d postgres -c "drop database if exists $NEG" -c "create database $NEG" >/dev/null 2>&1
$PSQL -U postgres -d "$NEG" -f supabase-shim.sql >/dev/null
LO=$($PSQL -U postgres -d "$NEG" -c "select lo_create(0)" | tail -1)
$PSQL -U postgres -d "$NEG" -c "grant select on large object $LO to worker_c1" >/dev/null
out=$($PSQL -U postgres -d "$NEG" -f ../migrations/0001_core.sql 2>&1 >/dev/null); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "large object $LO"; then
  pass=$((pass+1)); echo "ok   - bootstrap refuses a contract role with a large-object grant"
else fail=$((fail+1)); echo "FAIL - bootstrap refuses a contract role with a large-object grant: rc=$rc $out"; fi
psql -X -q -U postgres -d postgres -c "drop database $NEG" >/dev/null

echo "# access (aal2, staff)"
equals "aal2 staff reads C1 content" 1 as api_rt "$(claims $COMM aal2)" "select count(*) from core.content_item"
equals "aal1 session reads no C1 content" 0 as api_rt "$(claims $COMM aal1)" "select count(*) from core.content_item"
equals "anonymous reads no C1 content" 0 as api_rt '{}' "select count(*) from core.content_item"
equals "anonymous reads C0 causes table" 0 as api_rt '{}' "select count(*) from core.cause"
fails "aal1 session cannot insert content" as api_rt "$(claims $COMM aal1)" "insert into core.content_item (id,type,author_id) values (core.uuid7(),'nota','$COMM')"
ok "editor with aal2 inserts content (audited)" as api_rt "$(claims $COMM aal2)" "insert into core.content_item (id,type,author_id) values (core.uuid7(),'nota','$COMM')"
fails "approver equal to author is rejected" as api_rt "$(claims $COMM aal2)" "update core.content_item set approver_id = author_id where id='00000000-0000-7000-8000-0000000000c1'"

equals "anonymous api_rt reads no data key" 0 as api_rt '{}' "select count(*) from core.data_key"
equals "aal1 api_rt reads no data key" 0 as api_rt "$(claims $COMM aal1)" "select count(*) from core.data_key"
equals "aal2 staff reads only the C2 data key" C2 as api_rt "$(claims $COMM aal2)" "select string_agg(data_class, ',') from core.data_key"

echo "# role administration"
fails "direct insert into role_assignment" as api_rt "$(claims $CHIEF aal2)" "insert into core.role_assignment (id,user_id,role_id,granted_by) values (core.uuid7(),'$NEWU','operador','$CHIEF')"
fails "self-grant" as api_rt "$(claims $CHIEF aal2)" "select core.grant_role('$CHIEF','parlamentar')"
fails "grant by a non-holder" as api_rt "$(claims $COMM aal2)" "select core.grant_role('$NEWU','operador')"
fails "grant with aal1" as api_rt "$(claims $CHIEF aal1)" "select core.grant_role('$NEWU','operador')"
fails "grant to a removed user" as api_rt "$(claims $CHIEF aal2)" "select core.grant_role('$REMOVED','operador')"
ok "chief grants a role to another active user" as api_rt "$(claims $CHIEF aal2)" "select core.grant_role('$NEWU','operador')"
equals "grantor recorded from the JWT" "$CHIEF" sup "select granted_by from core.role_assignment where user_id='$NEWU'"

echo "# audit"
equals "audit actor derived from session_user and JWT" "api_rt|user|$CHIEF" sup "select db_role||'|'||actor_kind||'|'||actor_id from audit.event where entity='core.role_assignment' order by at desc limit 1"
fails "api_rt cannot update audit events" as api_rt "$(claims $CHIEF aal2)" "update audit.event set action='x'"
fails "api_rt cannot delete audit events" as api_rt "$(claims $CHIEF aal2)" "delete from audit.event"
fails "even the audit owner path cannot truncate" sup "truncate audit.event"
fails "api_rt cannot call audit.bind_migration" as api_rt '{}' "select audit.bind_migration('core','x')"

fails "audit details refuse free text (an e-mail)" as api_rt "$(claims $CHIEF aal2)" "select audit.write('note','core.content_item',null,'{\"to\":\"pessoa@example.org\"}')"
fails "audit details refuse personal data hidden in a key" as api_rt "$(claims $CHIEF aal2)" "select audit.write('note','core.content_item',null,'{\"fields\":{\"Maria Silva\":1}}')"
fails "audit details refuse a personal value that looks like an identifier" as api_rt "$(claims $CHIEF aal2)" "select audit.write('note','core.content_item',null,'{\"patient\":\"mariasilva\"}')"
fails "audit fields must be columns of the audited table" as api_rt "$(claims $CHIEF aal2)" "select audit.write('note','core.content_item',null,'{\"fields\":[\"mariasilva\"]}')"
fails "audit states must be registered" as api_rt "$(claims $CHIEF aal2)" "select audit.write('note','core.content_item',null,'{\"to_state\":\"mariasilva\"}')"
fails "audit actions must be registered" as api_rt "$(claims $CHIEF aal2)" "select audit.write('mariasilva','core.content_item',null,'{}')"
fails "audit entity_id from a direct caller must be a uuid" as api_rt "$(claims $CHIEF aal2)" "select audit.write('export','core.content_item','mariasilva','{}')"
fails "audit entity must be an existing table" as api_rt "$(claims $CHIEF aal2)" "select audit.write('note','maria.silva',null,'{}')"
ok "audit details accept columns, ids, states and counts" as api_rt "$(claims $CHIEF aal2)" "select audit.write('note','core.content_item','00000000-0000-7000-8000-0000000000c1','{\"fields\":[\"state\",\"type\"],\"ids\":[\"00000000-0000-7000-8000-0000000000c1\"],\"from_state\":\"draft\",\"to_state\":\"in_review\",\"count\":1}')"
ok "editor updates a content version (audited)" as api_rt "$(claims $COMM aal2)" "update core.content_version set summary = 'novo' where content_id = '00000000-0000-7000-8000-0000000000c1' and n = 1"
equals "composite keys are recorded as entity_id" "00000000-0000-7000-8000-0000000000c1|1" sup "select entity_id from audit.event where entity='core.content_version' order by at desc limit 1"
fails "a worker cannot update a C1 table without a bound lease" as worker_c1 '{}' "update core.data_source set cursor = '{}'::jsonb"

echo "# worker leases"
TOKEN=$($PSQL -U worker_c1 -d "$DB" -c "select lease_token from core.claim_job(array['hello.greet'],'w1')" | tail -1)
[ -n "$TOKEN" ] && { pass=$((pass+1)); echo "ok   - worker_c1 claims a C1 job"; } || { fail=$((fail+1)); echo "FAIL - worker_c1 claims a C1 job"; }
fails "worker write without a bound lease" as worker_c1 '{}' "select audit.write('test','core.job',null,'{}')"
ok "worker write with a bound lease" as worker_c1 '{}' "select audit.bind_lease('$TOKEN'); select audit.write('test','core.job',null,'{}')"
fails "lease is not inherited by the next transaction" as worker_c1 '{}' "select audit.write('test','core.job',null,'{}')"
fails "a forged token is refused" as worker_c1 '{}' "select audit.bind_lease(repeat('ab',32))"
fails "worker_c2 cannot bind a C1 job lease" as worker_c2 '{}' "select audit.bind_lease('$TOKEN')"
fails "binding twice in one transaction is refused" as worker_c1 '{}' "select audit.bind_lease('$TOKEN'); select audit.bind_lease('$TOKEN')"
equals "worker audit actor is the job" "worker_c1|worker|00000000-0000-7000-8000-0000000000f1" sup "select db_role||'|'||actor_kind||'|'||actor_id from audit.event where action='test'"
fails "set_config app.actor is ignored" as worker_c1 '{}' "select set_config('app.actor','system:retention',true); select audit.write('test','core.job',null,'{}')"
fails "worker_c1 cannot read pii_email" as worker_c1 '{}' "select pii_email from core.app_user"
fails "worker_c2 cannot claim a C1 job" bash -c "out=\$($PSQL -U worker_c2 -d $DB -c \"select count(*) from core.claim_job(array['hello.greet'],'w2')\"); [ \"\$out\" = 1 ] && echo claimed || exit 1"

echo "# audit actor for every runtime login (stage 6, test 1)"
for n in 2 3; do
  T=$($PSQL -U worker_c$n -d "$DB" -c "select lease_token from core.claim_job(array['test.c$n'],'w$n')" | tail -1)
  ok "worker_c$n writes with its own lease" as worker_c$n '{}' "select audit.bind_lease('$T'); select audit.write('actor-c$n','core.job',null,'{}')"
  equals "worker_c$n audit actor is its job" "worker_c$n|worker|00000000-0000-7000-8000-0000000000f$n" sup "select db_role||'|'||actor_kind||'|'||actor_id from audit.event where action='actor-c$n'"
done
ok "migrator writes under a migration lease" as migrator '{}' "select audit.bind_migration('core','0001_core.sql'); select audit.write('actor-mig','audit.migration_log',null,'{}')"
equals "migrator audit actor is the migration" "migrator|migration|core:0001_core.sql" sup "select db_role||'|'||actor_kind||'|'||actor_id from audit.event where action='actor-mig'"
equals "no audit event ever records a definer role" 0 sup "select count(*) from audit.event where db_role in ('audit_owner','core_owner','postgres')"
fails "migrator cannot use a worker lease kind" as migrator '{}' "select audit.write('x','core.job',null,'{}')"

echo "# migrations"
fails "migrator cannot rewrite migration_log" as migrator '{}' "update audit.migration_log set sha256='x'"
ok "migrator records the migration bound to its transaction" as migrator '{}' "select audit.bind_migration('test.record','test-record'); select audit.record_migration('test.record','test-record','abc')"
fails "migrator cannot record a migration without its lease" as migrator '{}' "select audit.record_migration('core','test-unbound','abc')"
fails "migrator cannot record a migration other than the bound one" as migrator '{}' "select audit.bind_migration('core','test-a'); select audit.record_migration('demo.hello','0099_fake.sql','abc')"
equals "migrator is a member of no core or audit owner role" 0 sup "select count(*) from pg_auth_members m where m.member='migrator'::regrole and m.roleid::regrole::text in ('core_owner','audit_owner','audit_archiver')"

echo "# projections are checked against the column classes by the database itself (§6.2)"
# projection_check may read exactly the columns whose class comment is C0 or C1 and that carry no C2+ prefix.
# EXPLAIN runs the executor's permission checks, so any reference to another column, a whole row
# (to_jsonb(app_user)) or an unlisted function fails without reading data.
sup "do \$\$ begin if not exists (select 1 from pg_roles where rolname='projection_check') then create role projection_check nologin; end if; end \$\$;
     grant usage on schema core to projection_check; grant execute on function core.publish_media(uuid) to projection_check;" >/dev/null
sup "select format('grant select (%I) on core.%I to projection_check', a.attname, c.relname) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='core' and c.relkind='r' and a.attnum>0 and not a.attisdropped and col_description(c.oid,a.attnum) in ('class=C0','class=C1') and a.attname !~ '^(pii|phi|piim|enc)_'" | while read -r g; do sup "$g" >/dev/null; done
for f in "$ROOT"/packages/core-publish/projections/*.json; do
  case $f in *.schema.json) continue;; esac
  ok "projection $(basename "$f" .json) reads only C0/C1 columns" sup "begin; set local role projection_check; explain $(node "$ROOT/scripts/publish-demo.js" sql-unchecked "$f"); rollback"
done
for f in projection-pii projection-whole-row; do
  fails "negative fixture: $f is refused by the database" sup "begin; set local role projection_check; explain $(node "$ROOT/scripts/publish-demo.js" sql-unchecked "$ROOT/tests/fixtures/negative/$f.json"); rollback"
done

echo "# a module migration that leaves its owner role reaches nothing in core or audit (§7.2, database-enforced)"
# These run the runner's transaction by hand, so the static screen is not in the way: the database is the boundary.
MIG="select audit.bind_migration('demo.hello','escape-test'); set local role mod_hello_owner; set local search_path = mod_hello, pg_temp"
fails "set_config('role','core_owner') from a module migration" as migrator '{}' "$MIG; select set_config('role','core_owner',true)"
fails "after RESET ROLE a module migration cannot create in core" as migrator '{}' "$MIG; reset role; create table core.escaped(id int)"
fails "after RESET ROLE a module migration cannot record another migration" as migrator '{}' "$MIG; reset role; select audit.record_migration('demo.hello','0099_fake.sql','abc')"
equals "nothing escaped into core" 0 sup "select count(*) from pg_class where relname = 'escaped'"

echo "# migration runner (§7.2)"
MANDATO="node $ROOT/packages/core-config/bin/mandato.js"
equals "migrate is idempotent" "migrate: up to date" bash -c "$MANDATO migrate $ROOT/tenants/demo $DB"
equals "core and module migrations are recorded with hashes" 2 sup "select count(*) from audit.migration_log where (module_id, migration_id) in (('core','0001_core.sql'),('demo.hello','0001_hello.sql')) and sha256 ~ '^[0-9a-f]{64}\$'"
equals "the module migration ran as its owner role" mod_hello_owner sup "select pg_get_userbyid(relowner) from pg_class where oid = 'mod_hello.greeting_log'::regclass"
equals "migration actor in the audit trail is the migration" 0 sup "select count(*) from audit.event where db_role = 'migrator' and actor_kind <> 'migration'"
TMPT=$(mktemp -d); cp -r "$ROOT/tenants/demo/." "$TMPT/"; echo "-- edited after apply" >> "$TMPT/modules/hello/db/migrations/0001_hello.sql"
fails "an applied migration that changed aborts" bash -c "$MANDATO migrate $TMPT $DB 2>&1"
cp "$ROOT/tenants/demo/modules/hello/db/migrations/0001_hello.sql" "$TMPT/modules/hello/db/migrations/0001_hello.sql"
printf 'create function mod_hello.f() returns int language sql security definer as $f$ select 1 $f$;\n' > "$TMPT/modules/hello/db/migrations/0002_bad.sql"
fails "a module migration with SECURITY DEFINER is rejected" bash -c "$MANDATO migrate $TMPT $DB 2>&1"
equals "the rejected migration left nothing behind" 0 sup "select count(*) from pg_proc where proname = 'f' and pronamespace = 'mod_hello'::regnamespace"
MARK=$(mktemp -u); printf 'create table t_meta(id int);
\\! touch %s
' "$MARK" > "$TMPT/modules/hello/db/migrations/0002_bad.sql"
fails "a psql backslash command in a migration is not executed" bash -c "$MANDATO migrate $TMPT $DB 2>&1"
equals "the backslash command did not run" no bash -c "[ -e $MARK ] && echo yes || echo no"
rm -f "$TMPT/modules/hello/db/migrations/0002_bad.sql" "$TMPT/modules/hello/db/migrations/0001_hello.sql"
fails "an applied migration whose file was deleted aborts" bash -c "$MANDATO migrate $TMPT $DB 2>&1"
rm -rf "$TMPT"

echo "# staff authentication (design 0002, 0003_core.sql)"
NOW=$(date +%s); OLD=$((NOW - 3600))
totp_at() { printf '{"sub":"%s","aal":"aal2","amr":[{"method":"totp","timestamp":%s},{"method":"password","timestamp":%s}]}' "$1" "$2" "$OLD"; }
old_claims() { printf '{"sub":"%s","aal":"aal2"}' "$1"; }
sms_claims() { printf '{"sub":"%s","aal":"aal2","amr":[{"method":"sms","timestamp":%s}]}' "$1" "$NOW"; }
equals "aal2 without a totp amr entry is not aal2 (contract 0.1.1)" f as api_rt "$(old_claims $CHIEF)" "select core.is_aal2()"
equals "aal2 from an SMS factor holds no role" f as api_rt "$(sms_claims $CHIEF)" "select core.has_role('chefe_gabinete')"
equals "aal2 with totp holds the role" t as api_rt "$(totp_at $CHIEF $NOW)" "select core.has_role('chefe_gabinete')"
equals "recent_totp: fresh" t as api_rt "$(totp_at $CHIEF $NOW)" "select core.recent_totp('15 minutes')"
equals "recent_totp: 20 minutes old" f as api_rt "$(totp_at $CHIEF $((NOW - 1200)))" "select core.recent_totp('15 minutes')"
equals "recent_totp: from the future" f as api_rt "$(totp_at $CHIEF $((NOW + 600)))" "select core.recent_totp('15 minutes')"
fails "grant_role with a stale TOTP" as api_rt "$(totp_at $CHIEF $((NOW - 1200)))" "select core.grant_role('$NEWU','comunicacao')"

BI=decode\(\'b1b1\',\'hex\'\); BI2=decode\(\'b2b2\',\'hex\'\); X=decode\(\'01\',\'hex\'\)
fails "a non-chief cannot invite" as api_rt "$(totp_at $COMM $NOW)" "select core.create_invitation(core.uuid7(),$X,$X,$BI)"
fails "a chief with a stale TOTP cannot invite" as api_rt "$(totp_at $CHIEF $((NOW - 1200)))" "select core.create_invitation(core.uuid7(),$X,$X,$BI)"
fails "an existing member of staff cannot be invited" as api_rt "$(totp_at $CHIEF $NOW)" "select core.create_invitation(core.uuid7(),$X,$X,decode('11','hex'))"
ok "the chief invites" as api_rt "$(totp_at $CHIEF $NOW)" "select core.create_invitation(core.uuid7(),$X,$X,$BI)"
equals "the sign-up hook sees the open invitation" t as api_rt '{}' "select core.invitation_open($BI)"
equals "the sign-up hook refuses an e-mail without invitation" f as api_rt '{}' "select core.invitation_open($BI2)"
equals "anonymous reads no invitation row" 0 as api_rt '{}' "select count(*) from core.staff_invitation"
equals "a non-chief reads no invitation row" 0 as api_rt "$(totp_at $COMM $NOW)" "select count(*) from core.staff_invitation"
INV=00000000-0000-7000-8000-0000000000e1
equals "my_invitation: aal1 sees nothing" 0 as api_rt "{\"sub\":\"$INV\",\"aal\":\"aal1\"}" "select count(*) from core.my_invitation($BI)"
equals "my_invitation: the invitee (aal2) sees their invitation" 1 as api_rt "$(totp_at $INV $NOW)" "select count(*) from core.my_invitation($BI)"
equals "my_invitation: another index sees nothing" 0 as api_rt "$(totp_at $INV $NOW)" "select count(*) from core.my_invitation($BI2)"
fails "activation with aal1 is refused (SQL, not only the handler)" as api_rt "{\"sub\":\"$INV\",\"aal\":\"aal1\"}" "select core.activate_invitation($BI,$X,$X)"
fails "activation with aal2 but no TOTP is refused" as api_rt "$(old_claims $INV)" "select core.activate_invitation($BI,$X,$X)"
fails "activation without an invitation is refused" as api_rt "$(totp_at $INV $NOW)" "select core.activate_invitation($BI2,$X,$X)"
ok "the invitee activates" as api_rt "$(totp_at $INV $NOW)" "select core.activate_invitation($BI,$X,$X)"
fails "a second activation is refused" as api_rt "$(totp_at $INV $NOW)" "select core.activate_invitation($BI,$X,$X)"
equals "the invitation is used and the hook now refuses it" f as api_rt '{}' "select core.invitation_open($BI)"
equals "my_invitation: nothing once activated" 0 as api_rt "$(totp_at $INV $NOW)" "select count(*) from core.my_invitation($BI)"
equals "an activated user without a role reads exactly their own row" "1|$INV" as api_rt "$(totp_at $INV $NOW)" "select count(*), max(id::text) from core.app_user"
equals "... and not with aal1" 0 as api_rt "{\"sub\":\"$INV\",\"aal\":\"aal1\"}" "select count(*) from core.app_user"
equals "an invited user gets no role by activating" f as api_rt "$(totp_at $INV $NOW)" "select core.is_staff()"
fails "bootstrap is refused while a chief exists" as migrator '{}' "select audit.bind_migration('core','bootstrap-chief-test'); select core.create_bootstrap_invitation(core.uuid7(),$X,$X,$BI2)"
fails "api_rt cannot create a bootstrap invitation" as api_rt "$(totp_at $CHIEF $NOW)" "select core.create_bootstrap_invitation(core.uuid7(),$X,$X,$BI2)"

fails "a non-chief cannot change status" as api_rt "$(totp_at $COMM $NOW)" "select core.set_user_status('$INV','suspended')"
fails "the chief cannot change their own status" as api_rt "$(totp_at $CHIEF $NOW)" "select core.set_user_status('$CHIEF','suspended')"
fails "status change with a stale TOTP" as api_rt "$(totp_at $CHIEF $((NOW - 1200)))" "select core.set_user_status('$INV','suspended')"
ok "the chief suspends a user" as api_rt "$(totp_at $CHIEF $NOW)" "select core.set_user_status('$COMM','suspended')"
equals "a suspended user reads not even their own row (self_read)" 0 as api_rt "$(totp_at $COMM $NOW)" "select count(*) from core.app_user where id = '$COMM'"
equals "... nor their own role assignments" 0 as api_rt "$(totp_at $COMM $NOW)" "select count(*) from core.role_assignment where user_id = '$COMM'"
equals "a suspended user holds no role, whatever the JWT says" f as api_rt "$(totp_at $COMM $NOW)" "select core.has_role('comunicacao')"
ok "the chief reactivates" as api_rt "$(totp_at $CHIEF $NOW)" "select core.set_user_status('$COMM','active')"
ok "the chief removes a user" as api_rt "$(totp_at $CHIEF $NOW)" "select core.set_user_status('$INV','removed')"
fails "removed is final" as api_rt "$(totp_at $CHIEF $NOW)" "select core.set_user_status('$INV','active')"
equals "status changes are audited with states, not values" 1 sup "select count(*) from audit.event where action='set_status' and entity_id='$INV' and details->>'to_state'='removed'"

sup "set session_replication_role = replica; insert into core.data_key (key_id, purpose, data_class, version, enc_wrapped_key) values ('00000000-0000-7000-8000-0000000000b4','bi:email:v1','C2',1,'\\xbb')" >/dev/null
equals "index_key returns the wrapped e-mail index key to anyone in the API" 1 as api_rt '{}' "select count(*) from core.index_key('bi:email:v1')"
sup "set session_replication_role = replica; insert into core.data_key (key_id, purpose, data_class, version, enc_wrapped_key) values ('00000000-0000-7000-8000-0000000000b5','core.app_user.pii_name','C2',1,'\\xbb'), ('00000000-0000-7000-8000-0000000000b6','core.content_item.pii_other','C2',1,'\\xbb')" >/dev/null
equals "staff_keys returns nothing without aal2" 0 as api_rt '{}' "select count(*) from core.staff_keys()"
equals "staff_keys returns only the staff columns and the e-mail index key" "2" as api_rt "$(totp_at $COMM $NOW)" "select count(*) from core.staff_keys()"
fails "api_rt cannot register a staff key" as api_rt "$(totp_at $CHIEF $NOW)" "select core.add_staff_key(core.uuid7(),'core.app_user.pii_email','\\xbb')"
fails "the operator cannot register a key for a non-staff purpose" as migrator '{}' "select audit.bind_migration('core','keys-init-test'); select core.add_staff_key(core.uuid7(),'phi','\\xbb')"
equals "the operator does not replace an existing staff key" f as migrator '{}' "select audit.bind_migration('core','keys-init-test'); select core.add_staff_key(core.uuid7(),'core.app_user.pii_name','\\xbb')"
equals "index_key returns nothing for any other purpose" 0 as api_rt '{}' "select count(*) from core.index_key('pii')"
equals "no audit row carries a blind index value" 0 sup "select count(*) from audit.event where details::text ~* 'b1b1|b2b2' or coalesce(entity_id,'') ~* 'b1b1|b2b2'"

echo "# first chief (bootstrap invitation) on a fresh instance"
BOOT=${DB}_boot
psql -X -q -U postgres -d postgres -c "drop database if exists $BOOT" -c "create database $BOOT" >/dev/null
$PSQL -U postgres -d "$BOOT" -f supabase-shim.sql >/dev/null && $PSQL -U postgres -d "$BOOT" -f ../migrations/0001_core.sql >/dev/null 2>&1
$MANDATO bootstrap "$ROOT/tenants/demo" "$BOOT" >/dev/null 2>&1
bas() { local role=$1 cl=$2; shift 2; $PSQL -U "$role" -d "$BOOT" -c "begin; select set_config('request.jwt.claims', '$cl', true); $*; commit;" 2>&1; }
bsup() { $PSQL -U postgres -d "$BOOT" -c "$*" 2>&1; }
LEASE="select audit.bind_migration('core','bootstrap-chief')"
ok "the operator creates the bootstrap invitation" bas migrator '{}' "$LEASE; select core.create_bootstrap_invitation(core.uuid7(),$X,$X,$BI)"
fails "a second open bootstrap invitation is refused" bas migrator '{}' "$LEASE; select core.create_bootstrap_invitation(core.uuid7(),$X,$X,$BI2)"
bsup "set session_replication_role = replica; update core.staff_invitation set expires_at = now() - interval '1 day' where bootstrap" >/dev/null
ok "an expired bootstrap invitation does not block a new one" bas migrator '{}' "$LEASE; select core.create_bootstrap_invitation(core.uuid7(),$X,$X,$BI2)"
B1=00000000-0000-7000-8000-0000000000d1; B2=00000000-0000-7000-8000-0000000000d2
# two sessions race to activate the same bootstrap invitation: exactly one chief
( bas api_rt "$(totp_at $B1 $NOW)" "select core.activate_invitation($BI2,$X,$X)" >/dev/null & bas api_rt "$(totp_at $B2 $NOW)" "select core.activate_invitation($BI2,$X,$X)" >/dev/null & wait )
equals "concurrent bootstrap activations make exactly one chief" 1 bsup "select count(*) from core.role_assignment where role_id='chefe_gabinete' and revoked_at is null"
equals "the bootstrap chief is audited as bootstrap_chief" 1 bsup "select count(*) from audit.event where action='bootstrap_chief'"
fails "bootstrap is refused once the chief exists" bas migrator '{}' "$LEASE; select core.create_bootstrap_invitation(core.uuid7(),$X,$X,decode('b3b3','hex'))"
psql -X -q -U postgres -d postgres -c "drop database if exists $BOOT" >/dev/null

echo "# upgrade of an instance built before 0002 (forward migration, never an edit of 0001)"
UPG=${DB}_upgrade
psql -X -q -U postgres -d postgres -c "drop database if exists $UPG" -c "create database $UPG" >/dev/null
$PSQL -U postgres -d "$UPG" -f supabase-shim.sql >/dev/null && $PSQL -U postgres -d "$UPG" -f ../migrations/0001_core.sql >/dev/null 2>&1
equals "before the upgrade migrator is a member of core_owner (0001 as merged)" 1 bash -c "$PSQL -U postgres -d $UPG -c \"select count(*) from pg_auth_members where member='migrator'::regrole and roleid='core_owner'::regrole\""
fails "migrate refuses a core migration that bootstrap has not applied" bash -c "$MANDATO migrate $ROOT/tenants/demo $UPG 2>&1"
ok "bootstrap applies 0002 to the existing instance" bash -c "$MANDATO bootstrap $ROOT/tenants/demo $UPG 2>&1"
equals "after the upgrade migrator is a member of no core owner role" 0 bash -c "$PSQL -U postgres -d $UPG -c \"select count(*) from pg_auth_members where member='migrator'::regrole and roleid::regrole::text in ('core_owner','audit_owner','audit_archiver')\""
ok "migrate then applies the module migrations" bash -c "$MANDATO migrate $ROOT/tenants/demo $UPG 2>&1"
equals "a second bootstrap and migrate change nothing" "migrate: up to date" bash -c "$MANDATO bootstrap $ROOT/tenants/demo $UPG >/dev/null && $MANDATO migrate $ROOT/tenants/demo $UPG"
psql -X -q -U postgres -d postgres -c "drop database if exists $UPG" >/dev/null

echo "# job completion and recovery (design 0003 §6.3)"
enq() { sup "set session_replication_role = replica; insert into core.job (id, queue, data_class, payload, max_attempts) values ('$1','core.connector_run','C1','{}',${2:-5})" >/dev/null; }
claim() { $PSQL -U worker_c1 -d "$DB" -c "select lease_token from core.claim_job(array['core.connector_run'],'w1')" | tail -1; }
J1=00000000-0000-7000-8000-00000000e001; J2=00000000-0000-7000-8000-00000000e002; J3=00000000-0000-7000-8000-00000000e003; J4=00000000-0000-7000-8000-00000000e004
enq $J1; T1=$(claim)
fails "finish_job refuses free-text errors" as worker_c1 '{}' "select core.finish_job('$T1', false, 'Something broke for Maria')"
fails "finish_job refuses an ok job with an error" as worker_c1 '{}' "select core.finish_job('$T1', true, 'x')"
fails "finish_job refuses another pool" as worker_c2 '{}' "select core.finish_job('$T1', true, null)"
fails "finish_job refuses a forged token" as worker_c1 '{}' "select core.finish_job(repeat('cd',32), true, null)"
sup "update core.job set locked_at = now() - interval '1 hour' where id = '$J1'" >/dev/null
ok "heartbeat_job refreshes the lease" as worker_c1 '{}' "select core.heartbeat_job('$T1')"
equals "heartbeat moved locked_at forward" t sup "select locked_at > now() - interval '1 minute' from core.job where id = '$J1'"
equals "finish_job ok -> done" done as worker_c1 '{}' "select core.finish_job('$T1', true, null)"
fails "a finished lease cannot be used again" as worker_c1 '{}' "select core.finish_job('$T1', true, null)"
fails "nor bound for audit" as worker_c1 '{}' "select audit.bind_lease('$T1')"
enq $J2; T2=$(claim)
equals "a failure requeues with backoff" queued as worker_c1 '{}' "select core.finish_job('$T2', false, 'fetch_failed')"
equals "backoff is in the future and the lease is cleared" "t|t" sup "select run_after > now() + interval '1 minute', lease_hash is null and locked_by is null from core.job where id = '$J2'"
enq $J3 1; T3=$(claim)
equals "out of attempts -> dead" dead as worker_c1 '{}' "select core.finish_job('$T3', false, 'fetch_failed')"
enq $J4; T4=$(claim)
equals "a load-time code is dead at once" dead as worker_c1 '{}' "select core.finish_job('$T4', false, 'unknown_source')"
sup "update core.job set state='queued', run_after=now(), last_error=null where id='$J2'" >/dev/null; T2=$(claim)
fails "reclaim_jobs refuses a threshold under 2 minutes" as worker_c1 '{}' "select core.reclaim_jobs('30 seconds')"
equals "a fresh lease is not reclaimed" 0 as worker_c1 '{}' "select core.reclaim_jobs()"
sup "update core.job set locked_at = now() - interval '20 minutes' where id = '$J2'" >/dev/null
equals "worker_c2 does not reclaim C1 jobs" 0 bash -c "$PSQL -U worker_c2 -d $DB -c 'select core.reclaim_jobs()'"
equals "a stale C1 lease is reclaimed by worker_c1" 1 as worker_c1 '{}' "select core.reclaim_jobs()"
equals "the reclaimed job is queued with lease_expired" "queued|lease_expired|true" sup "select state||'|'||last_error||'|'||(lease_hash is null) from core.job where id = '$J2'"
fails "the reclaimed token is dead" as worker_c1 '{}' "select core.heartbeat_job('$T2')"

echo "# raw layer and provisioning grants (design 0003 §6.1, §6.2)"
fails "api_rt cannot read raw objects" as api_rt "$(claims $CHIEF aal2)" "select count(*) from core.raw_object"
fails "worker_c2 cannot read raw objects" as worker_c2 '{}' "select count(*) from core.raw_object"
fails "worker_c1 cannot insert a data_source" as worker_c1 '{}' "insert into core.data_source (source_id,name,terms_url,cadence) values ('x','x','','* * * * *')"
equals "raw_object and suppression are forced-RLS, C1 and audited" "2|2|2" sup "select count(*) filter (where relforcerowsecurity), count(*) filter (where obj_description(c.oid,'pg_class')='class=C1'), (select count(*) from pg_trigger t where t.tgrelid in ('core.raw_object'::regclass,'core.suppression'::regclass) and t.tgname='audit') from pg_class c where c.oid in ('core.raw_object'::regclass,'core.suppression'::regclass)"
equals "tenant connectors are provisioned by migrate" "ibge-municipios|0 6 1 * *" sup "select source_id||'|'||cadence from core.data_source"

echo "# instance runtime roles (design 0004 §5.4, §6, §8)"
equals "scheduler and fetch_c1 are hardened login roles without memberships" "2|0" sup "select count(*) filter (where rolcanlogin and not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolinherit)), (select count(*) from pg_auth_members am join pg_roles m on m.oid=am.member where m.rolname in ('scheduler','fetch_c1')) from pg_roles where rolname in ('scheduler','fetch_c1')"
SCHED_INS="insert into core.job (id, queue, data_class, idempotency_key, payload, run_after) values (core.uuid7(), 'core.connector_run', 'C1', 'sched:conn:ibge-municipios:2026-11-24T09:00Z', '{\"source_id\":\"ibge-municipios\"}', '2026-11-24T09:00Z') on conflict (queue, idempotency_key) do nothing"
ok "scheduler enqueues a sched: job" as scheduler '{}' "$SCHED_INS"
ok "a second scheduler insert of the same minute is a no-op" as scheduler '{}' "$SCHED_INS"
equals "the minute is enqueued once" 1 sup "select count(*) from core.job where idempotency_key = 'sched:conn:ibge-municipios:2026-11-24T09:00Z'"
equals "scheduler reads its own last minute" "2026-11-24 09:00:00+00" as scheduler '{}' "set local timezone = 'UTC'; select max(run_after) from core.job where queue = 'core.connector_run' and left(idempotency_key, 30) = 'sched:conn:ibge-municipios:202'"
fails "scheduler cannot enqueue a non-sched job" as scheduler '{}' "insert into core.job (id, queue, data_class, idempotency_key) values (core.uuid7(), 'core.connector_run', 'C1', 'manual:1')"
fails "scheduler cannot enqueue a running job" as scheduler '{}' "insert into core.job (id, queue, data_class, idempotency_key, state) values (core.uuid7(), 'core.connector_run', 'C1', 'sched:x:1', 'running')"
equals "scheduler sees no non-sched job" 0 as scheduler '{}' "select count(*) from core.job where left(coalesce(idempotency_key, ''), 6) <> 'sched:'"
fails "scheduler cannot read the job payload" as scheduler '{}' "select payload from core.job"
fails "scheduler cannot claim" as scheduler '{}' "select * from core.claim_job(array['core.connector_run'], 's')"
fails "scheduler cannot read C1 tables" as scheduler '{}' "select count(*) from core.data_source"
sup "update core.job set state = 'done', lease_hash = null where state in ('queued','running')" >/dev/null
JF=00000000-0000-7000-8000-00000000f001; JN=00000000-0000-7000-8000-00000000f002
sup "set session_replication_role = replica; insert into core.job (id, queue, data_class, payload) values ('$JF','core.connector_run','C1','{\"source_id\":\"ibge-municipios\"}')" >/dev/null
TF=$(claim)
equals "fetch_grant derives the source from the held lease" "$JF|ibge-municipios" as fetch_c1 '{}' "select job_id||'|'||source_id from core.fetch_grant('$TF')"
fails "fetch_grant refuses a forged lease" as fetch_c1 '{}' "select * from core.fetch_grant(repeat('ab',32))"
fails "fetch_grant refuses a malformed lease" as fetch_c1 '{}' "select * from core.fetch_grant('x')"
fails "worker_c1 cannot call fetch_grant" as worker_c1 '{}' "select * from core.fetch_grant('$TF')"
sup "update core.job set locked_at = now() - interval '11 minutes' where id = '$JF'" >/dev/null
fails "fetch_grant refuses a stale lease" as fetch_c1 '{}' "select * from core.fetch_grant('$TF')"
sup "update core.job set state = 'done', lease_hash = null where id = '$JF'" >/dev/null
sup "set session_replication_role = replica; insert into core.job (id, queue, data_class, payload) values ('$JN','hello.greet','C1','{\"source_id\":\"ibge-municipios\"}')" >/dev/null
TN=$($PSQL -U worker_c1 -d "$DB" -c "select lease_token from core.claim_job(array['hello.greet'],'w1')" | tail -1)
fails "fetch_grant refuses the lease of a non-connector job" as fetch_c1 '{}' "select * from core.fetch_grant('$TN')"
sup "update core.job set state = 'done', lease_hash = null where id = '$JN'" >/dev/null
fails "fetch_c1 reads no table" as fetch_c1 '{}' "select count(*) from core.job"
REG="import('$ROOT/packages/db/src/migrate.js').then(m => console.log(m.registerInstance(process.argv[1], '$ROOT/tenants/demo', process.argv[2])))"
equals "instance up sets env on an instance registered before 0005" updated node -e "$REG" "$DB" local
equals "a second registration changes nothing" unchanged node -e "$REG" "$DB" local
fails "registration as another env is refused" node -e "$REG" "$DB" staging
fails "env is fixed once set, even for migrator under a lease" as migrator '{}' "select audit.bind_migration('core','instance'); update core.instance set env = 'staging'"
equals "the instance row carries env local" local sup "select env from core.instance"

echo "# API against Postgres (design 0002 §9, test 5 and 7): operator CLI, hook, activation, staff, audit"
ok "core-api end to end (packages/core-api/test/api-pg.test.js)" bash -c "cd $ROOT && TEST_DB=$DB node --test packages/core-api/test/api-pg.test.js 2>&1"
psql -X -q -U postgres -d postgres -c "drop database if exists ${DB}_api" >/dev/null

echo "# connector kit against Postgres (design 0003 §8.5, §9): runner, raw layer, takedown, contract suite DB part"
ok "connector runner and raw layer (workers/core/tests/test_runner_pg.py)" bash -c "cd $ROOT && TEST_DB=$DB MANDATO_REQUIRE_DB=1 python3 -m unittest workers.core.tests.test_runner_pg 2>&1"
ok "contract suite, database part (reference connector)" bash -c "cd $ROOT && TEST_DB=$DB MANDATO_REQUIRE_DB=1 python3 -m unittest workers.core.tests.test_connector_contract 2>&1"

echo "# demo reset (E0.6): guards, rebuild, synthetic staff readable with the dev KEK, rerun"
ok "mandato demo reset (packages/core-api/test/demo-pg.test.js)" bash -c "cd $ROOT && TEST_DB=$DB node --test packages/core-api/test/demo-pg.test.js 2>&1"

echo "# summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
