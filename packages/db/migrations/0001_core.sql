-- 0001_core.sql — core contract 0.1.0 (docs/designs/0001-core-contracts.md, §4 and Appendix A).
-- Runs once, at instance bootstrap, as the database owner. Later migrations run through `mandato migrate`.
-- Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only

begin;

-- ---------------------------------------------------------------- roles (§4.1)
do $$
declare r text;
begin
  foreach r in array array['core_owner','audit_owner','audit_archiver'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I nologin', r);
    end if;
    -- A role that already existed is reset too: attributes are enforced, never assumed (§4.1).
    execute format('alter role %I nologin noinherit nosuperuser nobypassrls nocreaterole nocreatedb noreplication', r);
  end loop;
  foreach r in array array['api_rt','worker_c1','worker_c2','worker_c3','migrator'] loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I login', r);
    end if;
    execute format('alter role %I login noinherit nosuperuser nobypassrls nocreaterole nocreatedb noreplication', r);
  end loop;
  -- Drop every membership these roles hold; the only one the contract grants is re-added below.
  for r in select format('revoke %I from %I granted by %I', g.rolname, m.rolname, gr.rolname)
             from pg_auth_members am join pg_roles g on g.oid = am.roleid join pg_roles m on m.oid = am.member
             join pg_roles gr on gr.oid = am.grantor
            where m.rolname in ('core_owner','audit_owner','audit_archiver','api_rt','worker_c1','worker_c2','worker_c3','migrator') loop
    execute r;
  end loop;
end $$;

alter role api_rt    set statement_timeout = '60s';
alter role worker_c1 set statement_timeout = '60s';
alter role worker_c2 set statement_timeout = '60s';
alter role worker_c3 set statement_timeout = '60s';
alter role api_rt    set idle_in_transaction_session_timeout = '5min';
alter role worker_c1 set idle_in_transaction_session_timeout = '5min';
alter role worker_c2 set idle_in_transaction_session_timeout = '5min';
alter role worker_c3 set idle_in_transaction_session_timeout = '5min';
-- migrator is a member of no core or audit owner role: core migrations run at bootstrap as the superuser, and a
-- module migration that leaves its owner role (set_config('role', ...), RESET ROLE) gains nothing in core or audit.

-- ---------------------------------------------------------------- schemas
create schema core  authorization core_owner;
create schema audit authorization audit_owner;
create schema api   authorization core_owner;
revoke all on schema core, audit, api from public;
revoke create on schema public from public;
revoke all on schema public from public, anon, authenticated;   -- PostgREST must see nothing outside `api` (§4.1)
do $$ begin
  -- Supabase's PostgREST reads its exposed schemas from this setting. Without the role, bootstrap fails at the end.
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    execute 'alter role authenticator set pgrst.db_schemas = ''api''';
  end if;
end $$;
grant usage on schema api to anon, authenticated, api_rt;
grant usage on schema core to api_rt, worker_c1, worker_c2, worker_c3;
grant usage on schema audit to api_rt, worker_c1, worker_c2, worker_c3, migrator;

-- ---------------------------------------------------------------- helpers
create function core.uuid7() returns uuid language plpgsql volatile as $$
declare
  ms bigint := floor(extract(epoch from clock_timestamp()) * 1000);
  b bytea := uuid_send(gen_random_uuid());
begin
  b := overlay(b placing substring(int8send(ms) from 3 for 6) from 1 for 6);
  b := set_byte(b, 6, (get_byte(b, 6) & 15) | 112);   -- version 7
  b := set_byte(b, 8, (get_byte(b, 8) & 63) | 128);   -- variant 10
  return encode(b, 'hex')::uuid;
end $$;

create function core.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

-- ---------------------------------------------------------------- audit schema (§4.5)
create table audit.event (
  id          uuid        not null default core.uuid7() primary key,
  at          timestamptz not null default now(),
  db_role     text        not null default session_user,
  actor_kind  text        not null check (actor_kind in ('user','worker','migration','system')),
  actor_id    text        not null,
  action      text        not null,
  entity      text        not null,
  entity_id   text,
  details     jsonb       not null default '{}'
);
create table audit.tx_lease (
  txid      xid8        not null default pg_current_xact_id() primary key,
  kind      text        not null check (kind in ('worker','migration')),
  ref       text        not null,
  bound_at  timestamptz not null default now()
);
-- Closed vocabulary for audit actions, states and projection names (§4.5): free text cannot pass as an identifier.
-- Framework terms are seeded here; a module registers its own through `mandato migrate` (audit.register_term).
create table audit.term (
  term        text        not null,
  kind        text        not null check (kind in ('action','state','projection')),
  module_id   text        not null,
  created_at  timestamptz not null default now(),
  primary key (kind, term),
  check (term ~ '^[a-z][a-z0-9_.:-]{0,63}$')
);
create table audit.migration_log (
  module_id     text        not null,
  migration_id  text        not null,
  sha256        text        not null,
  applied_at    timestamptz not null default now(),
  primary key (module_id, migration_id)
);

create function audit.refuse_change() returns trigger language plpgsql as $$
begin raise exception '% on %.% is not allowed', tg_op, tg_table_schema, tg_table_name; end $$;
create trigger no_update_delete before update or delete on audit.event         for each row execute function audit.refuse_change();
create trigger no_truncate      before truncate         on audit.event         for each statement execute function audit.refuse_change();
create trigger no_update_delete before update or delete on audit.migration_log for each row execute function audit.refuse_change();
create trigger no_truncate      before truncate         on audit.migration_log for each statement execute function audit.refuse_change();

-- ---------------------------------------------------------------- core tables (Appendix A)
create table core.instance (
  id                smallint    not null default 1 primary key check (id = 1),
  slug              text        not null check (slug ~ '^[a-z][a-z0-9-]{1,30}$'),
  display_name      text        not null,
  house_acronym     text        not null,
  uf                char(2)     not null,
  config_version    text        not null,
  framework_version text        not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table core.module_registry (
  module_id    text        not null primary key,
  short        text        not null unique,
  version      text        not null,
  enabled      boolean     not null default true,
  installed_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table core.app_user (
  id            uuid        not null primary key,
  pii_name      bytea       not null,
  pii_email     bytea       not null,
  bi_email      bytea       not null unique,
  bi_email_next bytea       unique,
  status        text        not null default 'active' check (status in ('active','suspended','removed')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table core.role (
  id         text        not null primary key,
  label      text        not null,
  module_id  text        references core.module_registry(module_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.permission (
  id         text        not null primary key,
  label      text        not null,
  module_id  text        references core.module_registry(module_id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.role_permission (
  role_id       text        not null references core.role(id) on delete cascade,
  permission_id text        not null references core.permission(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table core.role_assignment (
  id         uuid        not null primary key,
  user_id    uuid        not null references core.app_user(id) on delete restrict,
  role_id    text        not null references core.role(id) on delete restrict,
  granted_by uuid        not null references core.app_user(id) on delete restrict,
  granted_at timestamptz not null default now(),
  revoked_by uuid        references core.app_user(id) on delete restrict,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index role_assignment_active on core.role_assignment (user_id, role_id) where revoked_at is null;

create table core.cause (
  slug       text        not null primary key,
  name       text        not null,
  icon       text        not null,
  sort       smallint    not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.municipality (
  ibge_code           char(7)     not null primary key,
  name                text        not null,
  uf                  char(2)     not null,
  health_region       text,
  population          int,
  population_ref_date date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check ((population is null) = (population_ref_date is null))
);

create table core.data_source (
  source_id       text        not null primary key,
  name            text        not null,
  terms_url       text        not null,
  cadence         text        not null,
  last_success_at timestamptz,
  cursor          jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table core.data_source_run (
  id          uuid        not null primary key,
  source_id   text        not null references core.data_source(source_id) on delete restrict,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  status      text        not null default 'running' check (status in ('running','ok','failed','rejected')),
  stats       jsonb       not null default '{}',
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table core.job (
  id              uuid        not null primary key,
  queue           text        not null check (queue ~ '^[a-z][a-z0-9]{1,15}\.[a-z][a-z0-9_]{0,40}$'),
  data_class      text        not null check (data_class in ('C0','C1','C2','C3')),
  idempotency_key text,
  payload         jsonb       not null default '{}',
  state           text        not null default 'queued' check (state in ('queued','running','done','failed','dead')),
  attempts        smallint    not null default 0,
  max_attempts    smallint    not null default 5,
  run_after       timestamptz not null default now(),
  locked_by       text,
  locked_at       timestamptz,
  lease_hash      bytea,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (queue, idempotency_key)
);
create index job_ready on core.job (state, queue, run_after);

create table core.ai_provenance (
  id              uuid        not null primary key,
  task            text        not null,
  effective_class text        not null check (effective_class in ('C0','C1','C2','C3')),
  provider_id     text        not null,
  locality        text        not null check (locality in ('local','external')),
  model           text        not null,
  prompt_ref      text        not null,
  input_sha256    text        not null,
  tokens_in       int         not null default 0,
  tokens_out      int         not null default 0,
  job_id          uuid        references core.job(id) on delete restrict,
  reviewed_by     uuid        references core.app_user(id) on delete restrict,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table core.content_item (
  id                uuid        not null primary key,
  type              text        not null check (type in ('noticia','nota','artigo','balanco','posicionamento','card_dado','video_link')),
  state             text        not null default 'draft' check (state in ('draft','in_review','approved','published','withdrawn','archived')),
  current_version   int         not null default 1,
  published_version int,
  published_at      timestamptz,
  author_id         uuid        not null references core.app_user(id) on delete restrict,
  approver_id       uuid        references core.app_user(id) on delete restrict check (approver_id is distinct from author_id),
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table core.content_version (
  content_id       uuid        not null references core.content_item(id) on delete restrict,
  n                int         not null,
  title            text        not null,
  summary          text        not null default '',
  body_md          text        not null default '',
  figures          jsonb       not null default '[]',
  created_by       uuid        not null references core.app_user(id) on delete restrict,
  ai_provenance_id uuid        references core.ai_provenance(id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (content_id, n)
);
alter table core.content_item add constraint content_item_published_version_fk
  foreign key (id, published_version) references core.content_version (content_id, n) on delete restrict;

create table core.content_cause (
  content_id uuid        not null references core.content_item(id) on delete cascade,
  cause_slug text        not null references core.cause(slug) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (content_id, cause_slug)
);

create table core.media_asset (
  id            uuid        not null primary key,
  kind          text        not null check (kind in ('image','video_link','document')),
  storage_key   text        not null unique,
  sha256        text        not null,
  bytes         int         not null,
  width         int,
  height        int,
  variants      jsonb       not null default '[]',
  alt_text      text        not null default '',
  exif_stripped boolean     not null check (exif_stripped),
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table core.content_media (
  content_id uuid        not null references core.content_item(id) on delete cascade,
  media_id   uuid        not null references core.media_asset(id) on delete restrict,
  position   smallint    not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (content_id, media_id)
);

create table core.agenda_event (
  id                uuid        not null primary key,
  starts_at         timestamptz not null,
  ends_at           timestamptz check (ends_at is null or ends_at >= starts_at),
  title             text        not null,
  kind              text        not null,
  municipality_ibge char(7)     references core.municipality(ibge_code) on delete restrict,
  place             text        not null default '',
  visibility        text        not null default 'internal' check (visibility in ('public','internal')),
  status            text        not null default 'planned' check (status in ('planned','done','cancelled')),
  deleted_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table core.data_key (
  key_id          uuid        not null primary key,
  purpose         text        not null,
  data_class      text        not null check (data_class in ('C2','C3')),
  version         int         not null,
  enc_wrapped_key bytea       not null,
  state           text        not null default 'active' check (state in ('active','decrypt_only','retired')),
  retired_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (purpose, version)
);
create unique index data_key_one_active on core.data_key (purpose) where state = 'active';

create table core.publish_generation (
  generation      bigint      not null primary key,
  at              timestamptz not null default now(),
  manifest_sha256 text        not null,
  min_generation  bigint      not null,
  triggered_by    text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table core.idempotency (
  key_hash    bytea       not null primary key,
  body_sha256 bytea       not null,
  status      smallint    not null,
  receipt_id  uuid        not null,
  expires_at  timestamptz not null default now() + interval '24 hours'
);

create unlogged table core.rate_counter (
  key          bytea       not null,
  endpoint     text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (key, endpoint, window_start)
);

-- updated_at triggers
do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at'
           where n.nspname = 'core' and c.relkind = 'r' loop
    execute format('create trigger touch before update on core.%I for each row execute function core.touch_updated_at()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- classes (Appendix A; §3, §4.3)
do $$
declare
  r record;
  c0_tables text[] := array['instance','cause','municipality'];
begin
  for r in select n.nspname s, c.relname t, a.attname col
           from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('core','audit') and c.relkind in ('r','u') and a.attnum > 0 and not a.attisdropped loop
    execute format('comment on column %I.%I.%I is %L', r.s, r.t, r.col,
      'class=' || case
        when r.col like 'pii\_%' then 'C2'
        when r.col like 'phi\_%' or r.col like 'piim\_%' or r.col like 'enc\_%' then 'C3'
        when r.s = 'core' and r.t = any(c0_tables) then 'C0'
        when r.s = 'core' and r.t = 'data_source' and r.col in ('source_id','name','terms_url','cadence','last_success_at') then 'C0'
        else 'C1' end);
  end loop;
  for r in select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('core','audit') and c.relkind in ('r','u') loop
    execute format('comment on table %I.%I is %L', r.s, r.t, 'class=' || case
      when r.s = 'core' and r.t = 'app_user' then 'C2'
      when r.s = 'core' and r.t = 'data_key' then 'C3'
      when r.s = 'core' and r.t = any(c0_tables) then 'C0'
      else 'C1' end);
  end loop;
end $$;

-- ---------------------------------------------------------------- ownership
do $$
declare r record;
begin
  for r in select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'core' and c.relkind in ('r','u') loop
    execute format('alter table core.%I owner to core_owner', r.t);
  end loop;
  for r in select c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'audit' and c.relkind = 'r' loop
    execute format('alter table audit.%I owner to audit_owner', r.t);
  end loop;
end $$;
alter function core.uuid7() owner to core_owner;
alter function core.touch_updated_at() owner to core_owner;
alter function audit.refuse_change() owner to audit_owner;

-- ---------------------------------------------------------------- authorization helpers (§4.1, §4.4)
create function core.is_aal2() returns boolean language sql stable
  set search_path = pg_catalog, pg_temp as
  $$ select coalesce(auth.jwt() ->> 'aal', '') = 'aal2' $$;

create function core.has_role(p_role text) returns boolean language sql stable security definer
  set search_path = pg_catalog, core, pg_temp as $$
  select core.is_aal2() and exists (
    select 1 from core.role_assignment ra
      join core.app_user u on u.id = ra.user_id and u.status = 'active'
      join core.role r on r.id = ra.role_id
      left join core.module_registry m on m.module_id = r.module_id
     where ra.user_id = auth.uid() and ra.role_id = p_role and ra.revoked_at is null
       and (r.module_id is null or m.enabled))
$$;

create function core.has_permission(p_permission text) returns boolean language sql stable security definer
  set search_path = pg_catalog, core, pg_temp as $$
  select core.is_aal2() and exists (
    select 1 from core.role_permission rp
     where rp.permission_id = p_permission and core.has_role(rp.role_id))
$$;

create function core.is_staff() returns boolean language sql stable security definer
  set search_path = pg_catalog, core, pg_temp as $$
  select core.is_aal2() and exists (
    select 1 from core.role_assignment ra join core.app_user u on u.id = ra.user_id and u.status = 'active'
     where ra.user_id = auth.uid() and ra.revoked_at is null)
$$;

-- ---------------------------------------------------------------- audit functions (§4.5)
-- Appendix A: `details` holds ids and field names only. Allowed keys and what each may hold:
--   fields: column names of the audited table; ids: uuids; from_state/to_state: registered states;
--   projection: a registered projection; count: a number. Anything else is refused, so a value such as
--   {"patient":"mariasilva"} or {"fields":["mariasilva"]} cannot reach the five-year trail.
create function audit.details_ok(p jsonb, p_entity text) returns boolean language sql stable
  set search_path = pg_catalog, audit, pg_temp as $$
  select jsonb_typeof(p) = 'object' and not exists (
    select 1 from jsonb_each(p) e(k, v)
     where case e.k
       when 'fields' then jsonb_typeof(e.v) <> 'array' or exists (
              select 1 from jsonb_array_elements(e.v) x
               where jsonb_typeof(x) <> 'string' or not exists (
                 select 1 from pg_attribute a
                  where a.attrelid = to_regclass(p_entity) and a.attnum > 0 and not a.attisdropped
                    and a.attname = x #>> '{}'))
       when 'ids' then jsonb_typeof(e.v) <> 'array' or exists (
              select 1 from jsonb_array_elements(e.v) x
               where (x #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       when 'from_state' then not exists (select 1 from audit.term t where t.kind = 'state' and t.term = e.v #>> '{}')
       when 'to_state'   then not exists (select 1 from audit.term t where t.kind = 'state' and t.term = e.v #>> '{}')
       when 'projection' then not exists (select 1 from audit.term t where t.kind = 'projection' and t.term = e.v #>> '{}')
       when 'count' then jsonb_typeof(e.v) <> 'number'
       else true end)
$$;

create function audit.register_term(p_kind text, p_term text, p_module_id text) returns void language plpgsql security definer
  set search_path = pg_catalog, audit, pg_temp as $$
begin
  if session_user <> 'migrator' then raise exception 'audit: only migrator registers terms'; end if;
  insert into audit.term (kind, term, module_id) values (p_kind, p_term, p_module_id) on conflict do nothing;
end $$;

create function audit.write(p_action text, p_entity text, p_entity_id text, p_details jsonb)
returns void language plpgsql security definer set search_path = pg_catalog, audit, pg_temp as $$
declare
  v_kind text; v_id text; v_lease audit.tx_lease;
begin
  if session_user = 'api_rt' then
    v_kind := 'user';
    v_id := coalesce(auth.uid()::text, 'anon');
  elsif session_user in ('worker_c1','worker_c2','worker_c3','migrator') then
    select * into v_lease from audit.tx_lease where txid = pg_current_xact_id();
    if not found then
      raise exception 'audit: no lease bound to this transaction for %', session_user;
    end if;
    if (session_user = 'migrator') <> (v_lease.kind = 'migration') then
      raise exception 'audit: lease kind % does not match %', v_lease.kind, session_user;
    end if;
    v_kind := v_lease.kind;
    v_id := v_lease.ref;
  else
    raise exception 'audit: role % may not write audit events', session_user;
  end if;
  if to_regclass(p_entity) is null or p_entity !~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' then
    raise exception 'audit: entity must be an existing schema.table';
  end if;
  if not exists (select 1 from audit.term t where t.kind = 'action' and t.term = p_action) then
    raise exception 'audit: action % is not registered', p_action;
  end if;
  if not audit.details_ok(coalesce(p_details, '{}'), p_entity) then
    raise exception 'audit: details may hold ids and field names only';
  end if;
  -- Direct callers name rows by uuid only. Composite or text keys come only from audit.row_trigger, which derives
  -- them from the row's primary key, so a caller cannot smuggle free text in as an "id".
  if p_entity_id is not null and p_entity_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and not (pg_trigger_depth() > 0 and p_entity_id ~ '^[A-Za-z0-9_.:|-]{1,200}$') then
    raise exception 'audit: entity_id must be a uuid';
  end if;
  insert into audit.event (actor_kind, actor_id, action, entity, entity_id, details, db_role)
  values (v_kind, v_id, p_action, p_entity, p_entity_id, coalesce(p_details, '{}'), session_user);
end $$;

create function audit.pool_classes(p_role name) returns text[] language sql immutable as $$
  select case p_role when 'worker_c1' then array['C0','C1'] when 'worker_c2' then array['C2']
                     when 'worker_c3' then array['C3'] else array[]::text[] end
$$;

create function audit.bind_lease(p_token text) returns uuid language plpgsql security definer
  set search_path = pg_catalog, audit, core, pg_temp as $$
declare v_job uuid;
begin
  select j.id into strict v_job from core.job j
   where j.lease_hash = sha256(decode(p_token, 'hex')) and j.state = 'running'
     and j.data_class = any(audit.pool_classes(session_user));
  insert into audit.tx_lease (kind, ref) values ('worker', v_job::text);
  return v_job;
exception when no_data_found or too_many_rows then
  raise exception 'audit: invalid lease';
end $$;

create function audit.bind_migration(p_module_id text, p_migration_id text) returns void language plpgsql security definer
  set search_path = pg_catalog, audit, pg_temp as $$
begin
  if session_user <> 'migrator' then raise exception 'audit: only migrator binds migrations'; end if;
  insert into audit.tx_lease (kind, ref) values ('migration', p_module_id || ':' || p_migration_id);
end $$;

create function audit.record_migration(p_module_id text, p_migration_id text, p_sha256 text) returns void language plpgsql security definer
  set search_path = pg_catalog, audit, pg_temp as $$
begin
  if session_user <> 'migrator' then raise exception 'audit: only migrator records migrations'; end if;
  -- only the migration bound to this transaction, so a migration cannot pre-record or fake another one
  if not exists (select 1 from audit.tx_lease l where l.txid = pg_current_xact_id() and l.kind = 'migration'
                 and l.ref = p_module_id || ':' || p_migration_id) then
    raise exception 'audit: record_migration needs the migration lease of %:%', p_module_id, p_migration_id;
  end if;
  insert into audit.migration_log (module_id, migration_id, sha256) values (p_module_id, p_migration_id, p_sha256);
end $$;

create function audit.row_trigger() returns trigger language plpgsql as $$
declare v_row record;
begin
  v_row := case when tg_op = 'DELETE' then old else new end;
  perform audit.write(lower(tg_op), tg_table_schema || '.' || tg_table_name,
    (select string_agg(to_jsonb(v_row) ->> a.attname, '|' order by k.n)
       from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, n)
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indrelid = tg_relid and i.indisprimary),
    jsonb_build_object('fields', case when tg_op = 'UPDATE'
      then (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(to_jsonb(new)) k
             where to_jsonb(new) -> k is distinct from to_jsonb(old) -> k and k <> 'updated_at')
      else '[]'::jsonb end));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['app_user','role_assignment','role_permission','content_item','content_version','content_cause',
                           'media_asset','content_media','agenda_event','data_key','module_registry','publish_generation',
                           'role','permission','data_source','data_source_run','ai_provenance'] loop
    -- not audited row by row: core.job (lease and state churn; claims are audited by the worker lease),
    -- core.idempotency and core.rate_counter (hashes and counters only, deleted within 24 h).
    execute format('create trigger audit after insert or update or delete on core.%I for each row execute function audit.row_trigger()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------- role administration (§4.4)
create function core.grant_role(p_target uuid, p_role text) returns uuid language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
declare v_id uuid := core.uuid7(); v_me uuid := auth.uid();
begin
  if v_me is null or not core.has_role('chefe_gabinete') then raise exception 'grant_role: not allowed'; end if;
  if p_target = v_me then raise exception 'grant_role: cannot change own roles'; end if;
  if not exists (select 1 from core.app_user where id = p_target and status = 'active') then raise exception 'grant_role: target not active'; end if;
  if not exists (select 1 from core.role r left join core.module_registry m on m.module_id = r.module_id
                  where r.id = p_role and (r.module_id is null or m.enabled)) then raise exception 'grant_role: unknown role'; end if;
  insert into core.role_assignment (id, user_id, role_id, granted_by) values (v_id, p_target, p_role, v_me);
  return v_id;
end $$;

create function core.revoke_role(p_assignment uuid) returns void language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
declare v_me uuid := auth.uid(); v_target uuid;
begin
  if v_me is null or not core.has_role('chefe_gabinete') then raise exception 'revoke_role: not allowed'; end if;
  select user_id into v_target from core.role_assignment where id = p_assignment and revoked_at is null;
  if not found then raise exception 'revoke_role: no active assignment'; end if;
  if v_target = v_me then raise exception 'revoke_role: cannot change own roles'; end if;
  update core.role_assignment set revoked_at = now(), revoked_by = v_me where id = p_assignment;
end $$;

-- ---------------------------------------------------------------- queue (§7.4)
create function core.claim_job(p_queues text[], p_worker text)
returns table (job_id uuid, queue text, payload jsonb, lease_token text)
language plpgsql security definer set search_path = pg_catalog, core, audit, pg_temp as $$
declare v_token bytea := sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')); v_job core.job;
begin
  select * into v_job from core.job j
   where j.state = 'queued' and j.run_after <= now() and j.queue = any(p_queues)
     and j.data_class = any(audit.pool_classes(session_user))
   order by j.run_after limit 1 for update skip locked;
  if not found then return; end if;
  update core.job set state = 'running', attempts = attempts + 1, locked_by = p_worker, locked_at = now(),
                      lease_hash = sha256(v_token) where id = v_job.id;
  return query select v_job.id, v_job.queue, v_job.payload, encode(v_token, 'hex');
end $$;

-- ---------------------------------------------------------------- publish (§6.2, §6.3)
-- Media references for the content projection. SECURITY INVOKER: it reads through the caller's grants and RLS.
create function core.publish_media(p_content uuid) returns jsonb language sql stable
set search_path = pg_catalog, core, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('url', 'm/' || a.sha256, 'width', a.width, 'height', a.height,
                                               'sha256', a.sha256, 'bytes', a.bytes) order by cm.position, a.id), '[]')
    from core.content_media cm join core.media_asset a on a.id = cm.media_id
   where cm.content_id = p_content and a.deleted_at is null and a.exif_stripped
$$;

-- function ownership and execute rights
do $$
declare r record;
begin
  for r in select p.oid::regprocedure f, n.nspname s from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('core','audit') loop
    execute format('alter function %s owner to %I', r.f, case r.s when 'core' then 'core_owner' else 'audit_owner' end);
    execute format('revoke all on function %s from public', r.f);
  end loop;
end $$;
grant execute on function core.uuid7(), core.is_aal2(), core.has_role(text), core.has_permission(text), core.is_staff()
  to api_rt, worker_c1, worker_c2, worker_c3;
grant execute on function core.uuid7() to audit_owner, core_owner, migrator;
grant execute on function core.grant_role(uuid, text), core.revoke_role(uuid) to api_rt;
grant execute on function core.publish_media(uuid) to worker_c1;
grant execute on function core.claim_job(text[], text), audit.bind_lease(text) to worker_c1, worker_c2, worker_c3;
grant execute on function audit.bind_migration(text, text), audit.record_migration(text, text, text), audit.register_term(text, text, text) to migrator;
-- Trigger functions need no EXECUTE grant for the roles whose writes fire them (checked at trigger creation).
grant execute on function audit.write(text, text, text, jsonb) to api_rt, worker_c1, worker_c2, worker_c3, migrator, core_owner;
grant execute on function audit.pool_classes(name) to core_owner, audit_owner, worker_c1, worker_c2, worker_c3;
grant usage on schema core to audit_owner;
grant usage on schema audit to core_owner;
grant select (id, lease_hash, state, data_class) on core.job to audit_owner;

-- ---------------------------------------------------------------- RLS (§4.4): forced everywhere, owner policies for definer functions
do $$
declare r record;
begin
  for r in select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname in ('core','audit') and c.relkind in ('r','u') loop
    execute format('alter table %I.%I enable row level security', r.s, r.t);
    execute format('alter table %I.%I force row level security', r.s, r.t);
    execute format('create policy owner_all on %I.%I to %I using (true) with check (true)', r.s, r.t,
                   case r.s when 'core' then 'core_owner' else 'audit_owner' end);
  end loop;
end $$;

create policy audit_read on core.job for select to audit_owner using (true);

-- C0 tables: readable by the API (public pages) and every worker pool
create policy read_all on core.instance     for select to api_rt, worker_c1, worker_c2, worker_c3 using (true);
create policy read_all on core.cause        for select to api_rt, worker_c1, worker_c2, worker_c3 using (true);
create policy read_all on core.municipality for select to api_rt, worker_c1, worker_c2, worker_c3 using (true);
create policy read_all on core.data_source  for select to api_rt, worker_c1, worker_c2, worker_c3 using (true);
grant select on core.instance, core.cause, core.municipality to api_rt, worker_c1, worker_c2, worker_c3;
grant select (source_id, name, terms_url, cadence, last_success_at, created_at, updated_at) on core.data_source to api_rt, worker_c2, worker_c3;
grant select, update on core.data_source to worker_c1;
create policy write_c1 on core.data_source for update to worker_c1 using (true) with check (true);
create policy write_c1 on core.data_source_run for all to worker_c1 using (true) with check (true);
grant select, insert, update on core.data_source_run to worker_c1;

-- staff reads of C1 content (aal2 required through is_staff/has_permission)
do $$
declare t text;
begin
  foreach t in array array['content_item','content_version','content_cause','media_asset','content_media','agenda_event','role','permission','role_permission','module_registry','ai_provenance'] loop
    execute format('create policy staff_read on core.%I for select to api_rt using (core.is_staff())', t);
    execute format('grant select on core.%I to api_rt', t);
  end loop;
  foreach t in array array['content_item','content_version','content_cause','media_asset','content_media'] loop
    execute format('create policy edit_insert on core.%I for insert to api_rt with check (core.has_permission(''core.content.edit''))', t);
    execute format('create policy edit_update on core.%I for update to api_rt using (core.has_permission(''core.content.edit'')) with check (core.has_permission(''core.content.edit''))', t);
    execute format('grant insert, update on core.%I to api_rt', t);
  end loop;
end $$;
create policy edit_insert on core.agenda_event for insert to api_rt with check (core.has_permission('core.agenda.edit'));
create policy edit_update on core.agenda_event for update to api_rt using (core.has_permission('core.agenda.edit')) with check (core.has_permission('core.agenda.edit'));
grant insert, update on core.agenda_event to api_rt;

-- users: C1 columns to staff; C2 columns only to API and C2/C3 pools
create policy staff_read on core.app_user for select to api_rt using (core.is_staff());
grant select on core.app_user to api_rt;
create policy staff_read on core.role_assignment for select to api_rt using (core.is_staff());
grant select on core.role_assignment to api_rt;
create policy pool_read on core.app_user for select to worker_c1, worker_c2, worker_c3 using (true);
grant select (id, bi_email, status, created_at, updated_at) on core.app_user to worker_c1;
grant select on core.app_user to worker_c2, worker_c3;

-- worker pools: C1 content read; jobs; provenance
do $$
declare t text;
begin
  foreach t in array array['content_item','content_version','content_cause','media_asset','content_media','agenda_event'] loop
    execute format('create policy pool_read on core.%I for select to worker_c1, worker_c2, worker_c3 using (true)', t);
    execute format('grant select on core.%I to worker_c1, worker_c2, worker_c3', t);
  end loop;
end $$;
create policy pool_jobs on core.job for all to worker_c1, worker_c2, worker_c3
  using (data_class = any(audit.pool_classes(current_user))) with check (data_class = any(audit.pool_classes(current_user)));
grant select (id, queue, data_class, payload, state, attempts, max_attempts, run_after, last_error), update (state, last_error, run_after) on core.job to worker_c1, worker_c2, worker_c3;
grant insert on core.job to api_rt, worker_c1, worker_c2, worker_c3;
create policy enqueue on core.job for insert to api_rt with check (state = 'queued' and lease_hash is null);
create policy provenance_insert on core.ai_provenance for insert to worker_c1, worker_c2, worker_c3 with check (true);
grant insert on core.ai_provenance to worker_c1, worker_c2, worker_c3;

-- data keys: each reader sees only keys up to its class
create policy key_read on core.data_key for select to api_rt using (data_class = 'C2' and core.is_staff());
create policy key_read_c2 on core.data_key for select to worker_c2 using (data_class = 'C2');
create policy key_read_c3 on core.data_key for select to worker_c3 using (true);
grant select on core.data_key to api_rt, worker_c2, worker_c3;

-- public-write stores (no personal data; §9)
create policy api_all on core.idempotency  for all to api_rt using (true) with check (true);
create policy api_all on core.rate_counter for all to api_rt using (true) with check (true);
grant select, insert, update, delete on core.idempotency, core.rate_counter to api_rt;

-- audit: chefe_gabinete can read the trail
create policy chief_read on audit.event for select to api_rt using (core.has_role('chefe_gabinete'));
grant select on audit.event to api_rt;

-- migration history: migrator reads it to refuse changed files at boot (§7.2); it can never write it directly
create policy migrator_read on audit.migration_log for select to migrator using (true);
grant select on audit.migration_log to migrator;

-- nothing outside `api` for Supabase client roles
revoke all on all tables in schema core, audit from anon, authenticated;
revoke all on all functions in schema core, audit from anon, authenticated;

-- ---------------------------------------------------------------- seeds that belong to the framework
-- Bootstrap runs as the database owner, which may not write audit events (§4.5); its own seeds are
-- recorded through audit.migration_log by the runner instead.
set local session_replication_role = replica;
insert into core.role (id, label) values
  ('parlamentar', 'Parlamentar'), ('chefe_gabinete', 'Chefe de gabinete'),
  ('comunicacao', 'Comunicação'), ('operador', 'Operador');
insert into core.permission (id, label) values
  ('core.content.edit', 'Editar conteúdo'), ('core.content.publish', 'Publicar conteúdo'), ('core.agenda.edit', 'Editar agenda');
insert into core.role_permission (role_id, permission_id) values
  ('parlamentar', 'core.content.publish'), ('chefe_gabinete', 'core.content.publish'), ('chefe_gabinete', 'core.content.edit'),
  ('chefe_gabinete', 'core.agenda.edit'), ('comunicacao', 'core.content.edit'), ('comunicacao', 'core.agenda.edit');
insert into audit.term (kind, term, module_id)
  select 'action', t, 'core' from unnest(array['insert','update','delete','grant_role','revoke_role','publish','withdraw','claim','export','erase']) t
  union all select 'state', t, 'core' from unnest(array['draft','in_review','approved','published','withdrawn','archived',
    'planned','done','cancelled','public','internal','active','suspended','removed','queued','running','failed','succeeded']) t
  union all select 'projection', t, 'core' from unnest(array['content','agenda','causes','municipalities']) t;
set local session_replication_role = origin;

-- ---------------------------------------------------------------- fail closed on what this file cannot reset (§4.1)
-- Attributes and memberships were reset above. Direct grants or ownership that a pre-existing role holds outside the
-- contract's schemas cannot be revoked safely by this file, so bootstrap refuses to finish until an operator removes them.
do $$
declare v_roles text[] := array['core_owner','audit_owner','audit_archiver','api_rt','worker_c1','worker_c2','worker_c3','migrator'];
        v_found text;
begin
  select string_agg(distinct x, ', ') into v_found from (
    select format('%s on %s.%s', a.privilege_type, n.nspname, c.relname) x
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
     where r.rolname = any(v_roles) and n.nspname not in ('core','audit','api') and n.nspname not like 'mod\_%'
    union all
    select format('%s on schema %s', a.privilege_type, n.nspname)
      from pg_namespace n cross join lateral aclexplode(n.nspacl) a join pg_roles r on r.oid = a.grantee
     where r.rolname = any(v_roles) and n.nspname not in ('core','audit','api') and n.nspname not like 'mod\_%'
    union all
    select format('%s on function %s', a.privilege_type, p.oid::regprocedure)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join lateral aclexplode(p.proacl) a join pg_roles r on r.oid = a.grantee
     where r.rolname = any(v_roles) and n.nspname not in ('core','audit','api','auth') and n.nspname not like 'mod\_%'
    union all
    select format('owns %s.%s', n.nspname, c.relname)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_roles r on r.oid = c.relowner
     where r.rolname = any(v_roles) and n.nspname not in ('core','audit','api','pg_toast') and n.nspname not like 'mod\_%'
    union all
    select format('%s on database %s', a.privilege_type, d.datname)
      from pg_database d cross join lateral aclexplode(d.datacl) a join pg_roles r on r.oid = a.grantee
     where d.datname = current_database() and r.rolname = any(v_roles) and a.privilege_type <> 'CONNECT'
    union all
    select format('%s on large object %s', a.privilege_type, lo.oid)
      from pg_largeobject_metadata lo cross join lateral aclexplode(lo.lomacl) a join pg_roles r on r.oid = a.grantee
     where r.rolname = any(v_roles)
    union all
    select format('owns large object %s', lo.oid)
      from pg_largeobject_metadata lo join pg_roles r on r.oid = lo.lomowner where r.rolname = any(v_roles)
    union all
    select format('default privileges of %s', r.rolname)
      from pg_default_acl da join pg_roles r on r.oid = da.defaclrole where r.rolname = any(v_roles)
  ) s;
  if v_found is not null then
    raise exception 'bootstrap refused: contract roles hold privileges outside the contract: %', v_found;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    raise exception 'bootstrap refused: role authenticator (Supabase PostgREST) must exist so its exposed schemas can be pinned to api';
  end if;
end $$;

commit;
