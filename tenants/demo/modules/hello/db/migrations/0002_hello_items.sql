-- demo.hello: a fictitious public list written by the reference connector of the connector kit (design 0003 §6.4).
create table mod_hello.exemplo_item (
  codigo     text        not null,
  nome       text        not null,
  valor      int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exemplo_item_codigo unique (codigo)
);
comment on table mod_hello.exemplo_item is 'class=C0';
comment on column mod_hello.exemplo_item.codigo is 'class=C0';
comment on column mod_hello.exemplo_item.nome is 'class=C0';
comment on column mod_hello.exemplo_item.valor is 'class=C0';
comment on column mod_hello.exemplo_item.created_at is 'class=C0';
comment on column mod_hello.exemplo_item.updated_at is 'class=C0';
alter table mod_hello.exemplo_item enable row level security;
alter table mod_hello.exemplo_item force row level security;
create policy connector_c1 on mod_hello.exemplo_item for all to worker_c1 using (true) with check (true);
grant usage on schema mod_hello to worker_c1;
grant select, insert, update, delete on mod_hello.exemplo_item to worker_c1;
create trigger audit after insert or update or delete on mod_hello.exemplo_item for each row execute function audit.row_trigger();
