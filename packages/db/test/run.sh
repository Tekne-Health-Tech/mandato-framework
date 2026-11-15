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
claims() { printf '{"sub":"%s","aal":"%s"}' "$1" "$2"; }
# as ROLE CLAIMS SQL -> runs SQL in one transaction as login ROLE with JWT claims
as() { local role=$1 cl=$2; shift 2
  $PSQL -U "$role" -d "$DB" -c "begin; select set_config('request.jwt.claims', '$cl', true); $*; commit;" 2>&1; }
ok()   { local name=$1; shift; if out=$("$@"); then pass=$((pass+1)); echo "ok   - $name"; else fail=$((fail+1)); echo "FAIL - $name: $out"; fi; }
fails(){ local name=$1; shift; if out=$("$@"); then fail=$((fail+1)); echo "FAIL - $name (expected an error): $out"; else pass=$((pass+1)); echo "ok   - $name"; fi; }
equals(){ local name=$1 want=$2; shift 2; out=$("$@" | tail -1); if [ "$out" = "$want" ]; then pass=$((pass+1)); echo "ok   - $name"; else fail=$((fail+1)); echo "FAIL - $name: got '$out', want '$want'"; fi; }
sup() { $PSQL -U postgres -d "$DB" -c "$*" 2>&1; }

psql -X -q -U postgres -d postgres -c "drop database if exists $DB" -c "create database $DB" >/dev/null
$PSQL -U postgres -d "$DB" -f supabase-shim.sql >/dev/null || { echo "shim failed"; exit 1; }
$PSQL -U postgres -d "$DB" -f ../migrations/0001_core.sql >/dev/null 2>&1 || { echo "migration failed"; exit 1; }
$PSQL -U postgres -d "$DB" -f seed-test.sql >/dev/null || { echo "seed failed"; exit 1; }

echo "# structure"
UNCLASSIFIED="select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where (n.nspname in ('core','audit') or n.nspname like 'mod\\_%') and c.relkind in ('r','u') and a.attnum>0 and not a.attisdropped and coalesce(col_description(c.oid,a.attnum),'') !~ '^class=C[0-3]\$'"
equals "every core/audit/module column has a class comment" 0 sup "$UNCLASSIFIED"
equals "negative fixture: an unclassified module column is caught" 1 sup "begin; $(cat fixtures/unclassified-column.sql) $UNCLASSIFIED; rollback"
equals "prefixed columns meet their minimum class" 0 sup "select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('core','audit') and a.attnum>0 and ((a.attname like 'pii\\_%' and col_description(c.oid,a.attnum) < 'class=C2') or (a.attname ~ '^(phi|piim|enc)_' and col_description(c.oid,a.attnum) <> 'class=C3'))"
equals "C2+ columns carry a prefix" 0 sup "select count(*) from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('core','audit') and a.attnum>0 and col_description(c.oid,a.attnum) in ('class=C2','class=C3') and a.attname !~ '^(pii|phi|piim|enc)_'"
equals "RLS enabled and forced on every table" 0 sup "select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('core','audit') and c.relkind in ('r','u') and not (c.relrowsecurity and c.relforcerowsecurity)"
equals "no runtime role bypasses RLS" 0 sup "select count(*) from pg_roles where rolname in ('api_rt','worker_c1','worker_c2','worker_c3','migrator','core_owner','audit_owner') and (rolbypassrls or rolsuper)"
equals "anon/authenticated hold nothing in core or audit" 0 sup "select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_schema in ('core','audit')"
equals "no SECURITY DEFINER in api" 0 sup "select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='api' and p.prosecdef"
equals "worker_c1 cannot read any C2/C3 column" 0 sup "select count(*) from information_schema.column_privileges cp join pg_namespace n on n.nspname=cp.table_schema join pg_class c on c.relnamespace=n.oid and c.relname=cp.table_name join pg_attribute a on a.attrelid=c.oid and a.attname=cp.column_name where cp.grantee='worker_c1' and cp.privilege_type='SELECT' and col_description(c.oid,a.attnum) in ('class=C2','class=C3')"
equals "worker_c2 cannot read any C3 column" 0 sup "select count(*) from information_schema.column_privileges cp join pg_namespace n on n.nspname=cp.table_schema join pg_class c on c.relnamespace=n.oid and c.relname=cp.table_name join pg_attribute a on a.attrelid=c.oid and a.attname=cp.column_name where cp.grantee='worker_c2' and cp.privilege_type='SELECT' and col_description(c.oid,a.attnum)='class=C3' and not (c.relname='data_key')"

echo "# access (aal2, staff)"
equals "aal2 staff reads C1 content" 1 as api_rt "$(claims $COMM aal2)" "select count(*) from core.content_item"
equals "aal1 session reads no C1 content" 0 as api_rt "$(claims $COMM aal1)" "select count(*) from core.content_item"
equals "anonymous reads no C1 content" 0 as api_rt '{}' "select count(*) from core.content_item"
equals "anonymous reads C0 causes table" 0 as api_rt '{}' "select count(*) from core.cause"
fails "aal1 session cannot insert content" as api_rt "$(claims $COMM aal1)" "insert into core.content_item (id,type,author_id) values (core.uuid7(),'nota','$COMM')"
ok "editor with aal2 inserts content (audited)" as api_rt "$(claims $COMM aal2)" "insert into core.content_item (id,type,author_id) values (core.uuid7(),'nota','$COMM')"
fails "approver equal to author is rejected" as api_rt "$(claims $COMM aal2)" "update core.content_item set approver_id = author_id where id='00000000-0000-7000-8000-0000000000c1'"

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
ok "migrator records a migration" as migrator '{}' "select audit.record_migration('core','0001_core.sql','abc')"
fails "migrator acting as core_owner cannot rewrite migration_log" as migrator '{}' "set role core_owner; delete from audit.migration_log"

echo "# summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
