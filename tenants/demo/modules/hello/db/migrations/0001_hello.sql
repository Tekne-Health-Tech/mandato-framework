-- demo.hello: runs as mod_hello_owner in schema mod_hello (design 0001 §7.2).
create table mod_hello.greeting_log (
  id         uuid        not null primary key,
  greeting   text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table mod_hello.greeting_log is 'class=C1';
comment on column mod_hello.greeting_log.id is 'class=C1';
comment on column mod_hello.greeting_log.greeting is 'class=C1';
comment on column mod_hello.greeting_log.created_at is 'class=C1';
comment on column mod_hello.greeting_log.updated_at is 'class=C1';
alter table mod_hello.greeting_log enable row level security;
alter table mod_hello.greeting_log force row level security;
