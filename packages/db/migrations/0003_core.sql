-- 0003_core.sql — staff authentication (design 0002, E0.5); core contract 0.1.1.
-- Applied by `mandato bootstrap` as the superuser, in one transaction that also records it in audit.migration_log.
-- Copyright (C) 2026 Tekne Health Tech Ltda. — AGPL-3.0-only

-- ---------------------------------------------------------------- second factor: TOTP only (design 0002 §3)
-- Narrows the frozen is_aal2: aal2 alone may come from phone or WebAuthn factors; the framework accepts TOTP only.
create or replace function core.is_aal2() returns boolean language sql stable
  set search_path = pg_catalog, pg_temp as $$
  select coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
     and jsonb_typeof(auth.jwt() -> 'amr') = 'array'
     and exists (select 1 from jsonb_array_elements(auth.jwt() -> 'amr') e where e ->> 'method' = 'totp')
$$;

-- The most recent TOTP entry of `amr` is at most p_max old and not more than 60 s in the future.
create function core.recent_totp(p_max interval) returns boolean language sql stable
  set search_path = pg_catalog, pg_temp as $$
  select coalesce((
    select to_timestamp((e ->> 'timestamp')::double precision) between now() - p_max and now() + interval '60 seconds'
      from jsonb_array_elements(case when jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr' else '[]' end) e
     where e ->> 'method' = 'totp' and jsonb_typeof(e -> 'timestamp') = 'number'
     order by (e ->> 'timestamp')::double precision desc limit 1), false)
$$;

-- ---------------------------------------------------------------- invitations (design 0002 §4, §6)
create table core.staff_invitation (
  id           uuid        not null default core.uuid7() primary key,
  pii_name     bytea       not null,
  pii_email    bytea       not null,
  bi_email     bytea       not null,
  bootstrap    boolean     not null default false,
  invited_by   uuid        references core.app_user(id) on delete restrict,
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_by      uuid        references core.app_user(id) on delete restrict,
  cancelled_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((invited_by is null) = bootstrap),
  check (used_at is null or cancelled_at is null),
  check ((used_at is null) = (used_by is null))
);
create unique index staff_invitation_open_email on core.staff_invitation (bi_email) where used_at is null and cancelled_at is null;
create unique index staff_invitation_open_bootstrap on core.staff_invitation (bootstrap)
  where bootstrap and used_at is null and cancelled_at is null;

comment on table core.staff_invitation is 'class=C2';
do $$
declare c text;
begin
  foreach c in array array['id','bi_email','bootstrap','invited_by','expires_at','used_at','used_by','cancelled_at','created_at','updated_at'] loop
    execute format('comment on column core.staff_invitation.%I is %L', c, 'class=C1');
  end loop;
end $$;
comment on column core.staff_invitation.pii_name  is 'class=C2';
comment on column core.staff_invitation.pii_email is 'class=C2';

alter table core.staff_invitation owner to core_owner;
alter table core.staff_invitation enable row level security;
alter table core.staff_invitation force row level security;
create trigger touch before update on core.staff_invitation for each row execute function core.touch_updated_at();
create trigger audit after insert or update or delete on core.staff_invitation for each row execute function audit.row_trigger();
create policy owner_all on core.staff_invitation to core_owner using (true) with check (true);
create policy chief_read on core.staff_invitation for select to api_rt using (core.has_role('chefe_gabinete'));
grant select on core.staff_invitation to api_rt;

-- One lock serializes every decision about "is there a chief yet" (bootstrap invitation and activation).
create function core.lock_bootstrap() returns void language sql volatile
  set search_path = pg_catalog, pg_temp as $$ select pg_advisory_xact_lock(hashtext('mandato:core:bootstrap_chief')) $$;

create function core.active_chief_exists() returns boolean language sql stable
  set search_path = pg_catalog, core, pg_temp as $$
  select exists (select 1 from core.role_assignment ra join core.app_user u on u.id = ra.user_id and u.status = 'active'
                  where ra.role_id = 'chefe_gabinete' and ra.revoked_at is null)
$$;

-- Read by the sign-up hook as the anonymous claim: a boolean, nothing else.
create function core.invitation_open(p_bi bytea) returns boolean language sql stable security definer
  set search_path = pg_catalog, core, pg_temp as $$
  select exists (select 1 from core.staff_invitation
                  where bi_email = p_bi and used_at is null and cancelled_at is null and expires_at > now())
$$;

create function core.create_invitation(p_name bytea, p_email bytea, p_bi bytea) returns uuid language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
declare v_me uuid := auth.uid(); v_id uuid := core.uuid7();
begin
  if v_me is null or not core.has_role('chefe_gabinete') or not core.recent_totp('15 minutes') then
    raise exception 'create_invitation: not allowed';
  end if;
  if exists (select 1 from core.app_user where bi_email = p_bi or bi_email_next = p_bi) then
    raise exception 'create_invitation: already staff';
  end if;
  update core.staff_invitation set cancelled_at = now()
   where bi_email = p_bi and used_at is null and cancelled_at is null and expires_at <= now();
  insert into core.staff_invitation (id, pii_name, pii_email, bi_email, invited_by, expires_at)
  values (v_id, p_name, p_email, p_bi, v_me, now() + interval '7 days');
  return v_id;
end $$;

create function core.cancel_invitation(p_id uuid) returns void language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
begin
  if auth.uid() is null or not core.has_role('chefe_gabinete') or not core.recent_totp('15 minutes') then
    raise exception 'cancel_invitation: not allowed';
  end if;
  update core.staff_invitation set cancelled_at = now() where id = p_id and used_at is null and cancelled_at is null;
  if not found then raise exception 'cancel_invitation: no open invitation'; end if;
end $$;

-- Operator only (`mandato staff bootstrap-chief`), as migrator under a migration lease, so the audit actor is derived.
create function core.create_bootstrap_invitation(p_name bytea, p_email bytea, p_bi bytea) returns uuid language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
declare v_id uuid := core.uuid7();
begin
  if session_user <> 'migrator' then raise exception 'create_bootstrap_invitation: operator only'; end if;
  perform core.lock_bootstrap();
  update core.staff_invitation set cancelled_at = now()
   where bootstrap and used_at is null and cancelled_at is null and expires_at <= now();
  if core.active_chief_exists() then raise exception 'create_bootstrap_invitation: a chief already exists'; end if;
  if exists (select 1 from core.staff_invitation where bootstrap and used_at is null and cancelled_at is null) then
    raise exception 'create_bootstrap_invitation: an open bootstrap invitation exists';
  end if;
  update core.staff_invitation set cancelled_at = now()
   where bi_email = p_bi and used_at is null and cancelled_at is null;
  insert into core.staff_invitation (id, pii_name, pii_email, bi_email, bootstrap, expires_at)
  values (v_id, p_name, p_email, p_bi, true, now() + interval '7 days');
  return v_id;
end $$;

-- The API computes p_bi from the JWT's verified e-mail and encrypts name and e-mail for app_user; the request body is empty.
create function core.activate_invitation(p_bi bytea, p_name bytea, p_email bytea) returns uuid language plpgsql security definer
  set search_path = pg_catalog, core, audit, pg_temp as $$
declare v_me uuid := auth.uid(); v_inv core.staff_invitation; v_assignment uuid;
begin
  if v_me is null or not core.is_aal2() then raise exception 'activate_invitation: not allowed'; end if;
  perform core.lock_bootstrap();
  if exists (select 1 from core.app_user where id = v_me) then raise exception 'activate_invitation: already active'; end if;
  select * into v_inv from core.staff_invitation
   where bi_email = p_bi and used_at is null and cancelled_at is null and expires_at > now() for update;
  if not found then raise exception 'activate_invitation: no open invitation'; end if;
  if v_inv.bootstrap and core.active_chief_exists() then raise exception 'activate_invitation: a chief already exists'; end if;
  insert into core.app_user (id, pii_name, pii_email, bi_email) values (v_me, p_name, p_email, p_bi);
  update core.staff_invitation set used_at = now(), used_by = v_me where id = v_inv.id;
  if v_inv.bootstrap then
    v_assignment := core.uuid7();
    insert into core.role_assignment (id, user_id, role_id, granted_by) values (v_assignment, v_me, 'chefe_gabinete', v_me);
    perform audit.write('bootstrap_chief', 'core.role_assignment', v_assignment::text, '{}');
  end if;
  perform audit.write('activate', 'core.staff_invitation', v_inv.id::text, '{}');
  return v_me;
end $$;

create function core.set_user_status(p_target uuid, p_status text) returns void language plpgsql security definer
  set search_path = pg_catalog, core, audit, pg_temp as $$
declare v_me uuid := auth.uid(); v_from text;
begin
  if v_me is null or not core.has_role('chefe_gabinete') or not core.recent_totp('15 minutes') then
    raise exception 'set_user_status: not allowed';
  end if;
  if p_target = v_me then raise exception 'set_user_status: cannot change own status'; end if;
  select status into v_from from core.app_user where id = p_target for update;
  if not found then raise exception 'set_user_status: unknown user'; end if;
  if not ((v_from = 'active' and p_status in ('suspended','removed')) or (v_from = 'suspended' and p_status in ('active','removed'))) then
    raise exception 'set_user_status: % to % is not allowed', v_from, p_status;
  end if;
  update core.app_user set status = p_status where id = p_target;
  perform audit.write('set_status', 'core.app_user', p_target::text, jsonb_build_object('from_state', v_from, 'to_state', p_status));
end $$;

-- The wrapped blind-index key for e-mail, to the API process only. Without the KEK, which only the API holds, the bytes
-- are useless; the frozen key_read policy on data DEKs is unchanged.
create function core.index_key(p_purpose text) returns table (key_id uuid, version int, enc_wrapped_key bytea)
  language sql stable security definer set search_path = pg_catalog, core, pg_temp as $$
  select k.key_id, k.version, k.enc_wrapped_key from core.data_key k
   where p_purpose = 'bi:email:v1' and k.purpose = p_purpose and k.state = 'active'
$$;

-- ---------------------------------------------------------------- frozen role functions, tightened (recent TOTP)
create or replace function core.grant_role(p_target uuid, p_role text) returns uuid language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
declare v_id uuid := core.uuid7(); v_me uuid := auth.uid();
begin
  if v_me is null or not core.has_role('chefe_gabinete') or not core.recent_totp('15 minutes') then raise exception 'grant_role: not allowed'; end if;
  if p_target = v_me then raise exception 'grant_role: cannot change own roles'; end if;
  if not exists (select 1 from core.app_user where id = p_target and status = 'active') then raise exception 'grant_role: target not active'; end if;
  if not exists (select 1 from core.role r left join core.module_registry m on m.module_id = r.module_id
                  where r.id = p_role and (r.module_id is null or m.enabled)) then raise exception 'grant_role: unknown role'; end if;
  insert into core.role_assignment (id, user_id, role_id, granted_by) values (v_id, p_target, p_role, v_me);
  return v_id;
end $$;

create or replace function core.revoke_role(p_assignment uuid) returns void language plpgsql security definer
  set search_path = pg_catalog, core, pg_temp as $$
declare v_me uuid := auth.uid(); v_target uuid;
begin
  if v_me is null or not core.has_role('chefe_gabinete') or not core.recent_totp('15 minutes') then raise exception 'revoke_role: not allowed'; end if;
  select user_id into v_target from core.role_assignment where id = p_assignment and revoked_at is null;
  if not found then raise exception 'revoke_role: no active assignment'; end if;
  if v_target = v_me then raise exception 'revoke_role: cannot change own roles'; end if;
  update core.role_assignment set revoked_at = now(), revoked_by = v_me where id = p_assignment;
end $$;

-- ---------------------------------------------------------------- ownership and grants
do $$
declare f text;
begin
  foreach f in array array['core.recent_totp(interval)','core.lock_bootstrap()','core.active_chief_exists()',
    'core.invitation_open(bytea)','core.create_invitation(bytea,bytea,bytea)','core.cancel_invitation(uuid)',
    'core.create_bootstrap_invitation(bytea,bytea,bytea)','core.activate_invitation(bytea,bytea,bytea)',
    'core.set_user_status(uuid,text)','core.index_key(text)'] loop
    execute format('alter function %s owner to core_owner', f);
    execute format('revoke all on function %s from public', f);
  end loop;
end $$;
grant execute on function core.recent_totp(interval) to api_rt;
grant execute on function core.invitation_open(bytea), core.create_invitation(bytea,bytea,bytea), core.cancel_invitation(uuid),
  core.activate_invitation(bytea,bytea,bytea), core.set_user_status(uuid,text), core.index_key(text) to api_rt;
grant usage on schema core to migrator;   -- to call the one operator function below; no table rights
grant execute on function core.create_bootstrap_invitation(bytea,bytea,bytea) to migrator;

-- ---------------------------------------------------------------- seeds
set local session_replication_role = replica;
insert into core.permission (id, label) values ('core.staff.manage', 'Gerenciar equipe');
insert into core.role_permission (role_id, permission_id) values ('chefe_gabinete', 'core.staff.manage');
insert into audit.term (kind, term, module_id)
  select 'action', t, 'core' from unnest(array['invite','cancel_invite','activate','bootstrap_chief','set_status']) t;
set local session_replication_role = origin;
