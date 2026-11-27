-- 0004_core.sql — connector kit (design 0003): raw layer, suppressions, job completion and recovery, source provisioning.
-- Applied by `mandato bootstrap` as the superuser, in one transaction that also records it in audit.migration_log.
-- Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only

-- ---------------------------------------------------------------- runs know their job (design 0003 §6.3)
alter table core.data_source_run add column job_id uuid references core.job(id) on delete restrict;
comment on column core.data_source_run.job_id is 'class=C1';

-- ---------------------------------------------------------------- raw layer (design 0003 §4, §6.2)
create table core.raw_object (
  id           uuid        not null default core.uuid7() primary key,
  run_id       uuid        not null references core.data_source_run(id) on delete restrict,
  source_id    text        not null references core.data_source(source_id) on delete restrict,
  url_host     text        not null check (url_host ~ '^[a-z0-9.-]{1,253}$'),
  url_path     text        not null check (length(url_path) <= 300 and url_path !~ '[?#]'),
  sha256       text        not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size         int         not null check (size between 0 and 52428800),
  content_type text        check (length(content_type) <= 200),
  storage_key  text        not null check (length(storage_key) between 1 and 300),
  fetched_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index raw_object_sha256 on core.raw_object (sha256);
create index raw_object_source_fetched on core.raw_object (source_id, fetched_at);

-- ---------------------------------------------------------------- suppressions (design 0003 §4, §6.3a)
create table core.suppression (
  id         uuid        not null default core.uuid7() primary key,
  source_id  text        not null references core.data_source(source_id) on delete restrict,
  key_sha256 text        not null check (key_sha256 ~ '^[0-9a-f]{64}$'),
  lifted_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, key_sha256)
);

do $$
declare t text; c record;
begin
  foreach t in array array['raw_object','suppression'] loop
    execute format('comment on table core.%I is %L', t, 'class=C1');
    for c in select a.attname from pg_attribute a where a.attrelid = ('core.' || t)::regclass and a.attnum > 0 and not a.attisdropped loop
      execute format('comment on column core.%I.%I is %L', t, c.attname, 'class=C1');
    end loop;
    execute format('alter table core.%I owner to core_owner', t);
    execute format('alter table core.%I enable row level security', t);
    execute format('alter table core.%I force row level security', t);
    execute format('create policy owner_all on core.%I to core_owner using (true) with check (true)', t);
    execute format('create trigger touch before update on core.%I for each row execute function core.touch_updated_at()', t);
    execute format('create trigger audit after insert or update or delete on core.%I for each row execute function audit.row_trigger()', t);
  end loop;
end $$;

create policy pool_c1 on core.raw_object for all to worker_c1 using (true) with check (true);
grant select, insert, delete on core.raw_object to worker_c1;
create policy pool_c1 on core.suppression for all to worker_c1 using (true) with check (true);
grant select, insert, update on core.suppression to worker_c1;

-- ---------------------------------------------------------------- source provisioning (design 0003 §6.1)
-- `mandato migrate` inserts a row per tenant.yaml connector; the runner fills name and terms_url from the manifest.
create policy migrator_provision on core.data_source for insert to migrator with check (last_success_at is null and cursor is null);
create policy migrator_read_ids on core.data_source for select to migrator using (true);
grant insert (source_id, name, terms_url, cadence), select (source_id) on core.data_source to migrator;   -- select: ON CONFLICT arbiter

-- ---------------------------------------------------------------- job completion and recovery (design 0003 §6.3)
create function core.job_by_token(p_token text) returns core.job language plpgsql security definer
  set search_path = pg_catalog, core, audit, pg_temp as $$
declare v core.job;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then raise exception 'job: invalid lease'; end if;
  select * into v from core.job j
   where j.lease_hash = sha256(decode(p_token, 'hex')) and j.state = 'running'
     and j.data_class = any(audit.pool_classes(session_user))
   for update;
  if not found then raise exception 'job: invalid lease'; end if;
  return v;
end $$;

create function core.finish_job(p_token text, p_ok boolean, p_error text) returns text language plpgsql security definer
  set search_path = pg_catalog, core, audit, pg_temp as $$
declare v core.job; v_state text; v_after timestamptz := now();
begin
  if p_error is not null and p_error !~ '^[a-z][a-z0-9_]{0,40}$' then raise exception 'finish_job: error must be a code'; end if;
  if p_ok and p_error is not null then raise exception 'finish_job: an ok job carries no error'; end if;
  v := core.job_by_token(p_token);
  if p_ok then
    v_state := 'done';
  elsif p_error = any(array['unknown_source','invalid_manifest','invalid_params','source_not_provisioned'])
        or v.attempts >= v.max_attempts then
    v_state := 'dead';
  else
    v_state := 'queued';
    v_after := now() + least(make_interval(mins => power(2, v.attempts)::int), interval '6 hours');
  end if;
  update core.job set state = v_state, last_error = p_error, run_after = v_after,
                      lease_hash = null, locked_by = null, locked_at = null
   where id = v.id;
  return v_state;
end $$;

create function core.heartbeat_job(p_token text) returns void language plpgsql security definer
  set search_path = pg_catalog, core, audit, pg_temp as $$
declare v core.job;
begin
  v := core.job_by_token(p_token);
  update core.job set locked_at = now() where id = v.id;
end $$;

-- Requeues jobs whose lease went stale. It does not touch data_source_run: those rows are audited, and this caller
-- holds no lease. The next run of the source closes its orphaned 'running' runs inside its own lease (runner tx 1).
create function core.reclaim_jobs(p_stale interval default '10 minutes') returns int language plpgsql security definer
  set search_path = pg_catalog, core, audit, pg_temp as $$
declare r record; n int := 0;
begin
  if p_stale < interval '2 minutes' then raise exception 'reclaim_jobs: stale threshold too short'; end if;
  for r in select id, attempts, max_attempts from core.job
            where state = 'running' and locked_at < now() - p_stale and data_class = any(audit.pool_classes(session_user))
            for update skip locked loop
    update core.job set state = case when r.attempts >= r.max_attempts then 'dead' else 'queued' end,
                        last_error = 'lease_expired', run_after = now(), lease_hash = null, locked_by = null, locked_at = null
     where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array['core.job_by_token(text)','core.finish_job(text,boolean,text)','core.heartbeat_job(text)',
                           'core.reclaim_jobs(interval)'] loop
    execute format('alter function %s owner to core_owner', f);
    execute format('revoke all on function %s from public', f);
  end loop;
end $$;
grant execute on function core.finish_job(text,boolean,text), core.heartbeat_job(text), core.reclaim_jobs(interval)
  to worker_c1, worker_c2, worker_c3;

-- ---------------------------------------------------------------- seeds
set local session_replication_role = replica;
insert into audit.term (kind, term, module_id)
  select 'action', t, 'core' from unnest(array['takedown_takedown','takedown_error','takedown_legal','takedown_lift']) t;
set local session_replication_role = origin;
