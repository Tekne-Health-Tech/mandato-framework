-- 0005_core.sql — instance runtime (design 0004): instance environment, scheduler role, fetch sidecar grant.
-- Applied by `mandato bootstrap` as the superuser, in one transaction that also records it in audit.migration_log.
-- Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only

-- ---------------------------------------------------------------- roles (design 0004 §5.4, §6)
do $$
declare r text;
begin
  foreach r in array array['scheduler','fetch_c1'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I login', r);
    end if;
    execute format('alter role %I login noinherit nosuperuser nobypassrls nocreaterole nocreatedb noreplication', r);
  end loop;
  for r in select format('revoke %I from %I granted by %I', g.rolname, m.rolname, gr.rolname)
             from pg_auth_members am join pg_roles g on g.oid = am.roleid join pg_roles m on m.oid = am.member
             join pg_roles gr on gr.oid = am.grantor
            where m.rolname in ('scheduler','fetch_c1') loop
    execute r;
  end loop;
end $$;
alter role scheduler set statement_timeout = '30s';
alter role fetch_c1  set statement_timeout = '10s';
alter role scheduler set idle_in_transaction_session_timeout = '1min';
alter role fetch_c1  set idle_in_transaction_session_timeout = '1min';

-- ---------------------------------------------------------------- instance environment (design 0004 §8)
alter table core.instance add column env text check (env in ('local','staging','production'));
comment on column core.instance.env is 'class=C0';

create function core.instance_env_fixed() returns trigger language plpgsql
  set search_path = pg_catalog, core, pg_temp as $$
begin
  if old.env is not null and new.env is distinct from old.env then
    raise exception 'instance: env is fixed once set (%)', old.env;
  end if;
  return new;
end $$;
create trigger instance_env_fixed before update on core.instance for each row execute function core.instance_env_fixed();

-- ---------------------------------------------------------------- scheduler (design 0004 §5.4)
grant usage on schema core to scheduler;
grant insert (id, queue, data_class, idempotency_key, payload, run_after) on core.job to scheduler;
grant select (queue, idempotency_key, run_after) on core.job to scheduler;
create policy scheduler_insert on core.job for insert to scheduler
  with check (state = 'queued' and lease_hash is null and attempts = 0 and left(idempotency_key, 6) = 'sched:');
create policy scheduler_read on core.job for select to scheduler using (left(idempotency_key, 6) = 'sched:');
grant execute on function core.uuid7() to scheduler;

-- ---------------------------------------------------------------- fetch sidecar grant (design 0004 §6)
-- The capability is the lease the worker holds: the sidecar learns which source it may fetch for from the job itself.
create function core.fetch_grant(p_lease text)
returns table (job_id uuid, source_id text) language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
declare v core.job;
begin
  if session_user <> 'fetch_c1' then raise exception 'fetch_grant: only the fetch sidecar'; end if;
  if p_lease !~ '^[0-9a-f]{64}$' then raise exception 'fetch_grant: invalid lease'; end if;
  select * into v from core.job j
   where j.lease_hash = sha256(decode(p_lease, 'hex')) and j.state = 'running' and j.queue = 'core.connector_run'
     and j.locked_at >= now() - interval '10 minutes';
  if not found then raise exception 'fetch_grant: invalid lease'; end if;
  if not exists (select 1 from core.data_source d where d.source_id = v.payload->>'source_id') then
    raise exception 'fetch_grant: source not provisioned';
  end if;
  return query select v.id, v.payload->>'source_id';
end $$;
alter function core.instance_env_fixed() owner to core_owner;
alter function core.fetch_grant(text) owner to core_owner;
revoke all on function core.instance_env_fixed(), core.fetch_grant(text) from public;
grant usage on schema core to fetch_c1;
grant execute on function core.fetch_grant(text) to fetch_c1;

-- ---------------------------------------------------------------- instance registration (design 0004 §8)
-- `mandato instance up` registers the instance row as migrator under a migration lease (audited), sets env once,
-- and may refresh the version columns; slug, house and env never change through this path.
create policy migrator_register on core.instance for insert to migrator with check (env is not null);
create policy migrator_refresh on core.instance for update to migrator using (true) with check (env is not null);
create policy migrator_read on core.instance for select to migrator using (true);
grant select on core.instance to migrator;
grant insert (slug, display_name, house_acronym, uf, config_version, framework_version, env) on core.instance to migrator;
grant update (display_name, config_version, framework_version, env) on core.instance to migrator;
