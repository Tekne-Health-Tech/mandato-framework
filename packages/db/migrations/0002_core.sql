-- 0002_core.sql — core contract 0.1.x, forward migration (design 0001 §7.2; answer to the Wave 1 review).
-- Applied by `mandato bootstrap` as the superuser, in one transaction that also records it in audit.migration_log.
-- Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only

-- migrator is a member of no core or audit owner role: core migrations run at bootstrap as the superuser, and a
-- module migration that leaves its owner role (set_config('role', ...), RESET ROLE) gains nothing in core or audit.
revoke core_owner from migrator;

-- only the migration bound to this transaction may be recorded, so a migration cannot pre-record or fake another one
create or replace function audit.record_migration(p_module_id text, p_migration_id text, p_sha256 text) returns void
  language plpgsql security definer set search_path = pg_catalog, audit, pg_temp as $$
begin
  if session_user <> 'migrator' then raise exception 'audit: only migrator records migrations'; end if;
  if not exists (select 1 from audit.tx_lease l where l.txid = pg_current_xact_id() and l.kind = 'migration'
                 and l.ref = p_module_id || ':' || p_migration_id) then
    raise exception 'audit: record_migration needs the migration lease of %:%', p_module_id, p_migration_id;
  end if;
  insert into audit.migration_log (module_id, migration_id, sha256) values (p_module_id, p_migration_id, p_sha256);
end $$;

-- migration history: migrator reads it to refuse changed or missing files at boot; it can never write it directly
create policy migrator_read on audit.migration_log for select to migrator using (true);
grant select on audit.migration_log to migrator;
