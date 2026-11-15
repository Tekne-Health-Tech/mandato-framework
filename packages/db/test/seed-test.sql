-- Synthetic test users and data (no real people). Loaded as the database owner with triggers off.
set session_replication_role = replica;
insert into core.instance (slug, display_name, house_acronym, uf, config_version, framework_version)
  values ('demo', 'Mandato Dep. Exemplo', 'ALEX', 'EX', 'test', '0.1.0');
insert into core.app_user (id, pii_name, pii_email, bi_email, status) values
  ('00000000-0000-7000-8000-000000000001', '\x01', '\x01', '\x11', 'active'),
  ('00000000-0000-7000-8000-000000000002', '\x01', '\x01', '\x12', 'active'),
  ('00000000-0000-7000-8000-000000000003', '\x01', '\x01', '\x13', 'active'),
  ('00000000-0000-7000-8000-000000000004', '\x01', '\x01', '\x14', 'active'),
  ('00000000-0000-7000-8000-000000000005', '\x01', '\x01', '\x15', 'removed'),
  ('00000000-0000-7000-8000-000000000006', '\x01', '\x01', '\x16', 'active');
insert into core.role_assignment (id, user_id, role_id, granted_by) values
  ('00000000-0000-7000-8000-0000000000a1', '00000000-0000-7000-8000-000000000001', 'chefe_gabinete', '00000000-0000-7000-8000-000000000001'),
  ('00000000-0000-7000-8000-0000000000a2', '00000000-0000-7000-8000-000000000002', 'comunicacao',    '00000000-0000-7000-8000-000000000001'),
  ('00000000-0000-7000-8000-0000000000a3', '00000000-0000-7000-8000-000000000003', 'parlamentar',    '00000000-0000-7000-8000-000000000001'),
  ('00000000-0000-7000-8000-0000000000a4', '00000000-0000-7000-8000-000000000004', 'operador',       '00000000-0000-7000-8000-000000000001');
insert into core.content_item (id, type, state, author_id) values
  ('00000000-0000-7000-8000-0000000000c1', 'noticia', 'draft', '00000000-0000-7000-8000-000000000002');
insert into core.content_version (content_id, n, title, created_by) values
  ('00000000-0000-7000-8000-0000000000c1', 1, 'Notícia de teste', '00000000-0000-7000-8000-000000000002');
insert into core.job (id, queue, data_class, payload) values
  ('00000000-0000-7000-8000-0000000000f1', 'hello.greet', 'C1', '{}'),
  ('00000000-0000-7000-8000-0000000000f2', 'test.c2',     'C2', '{}'),
  ('00000000-0000-7000-8000-0000000000f3', 'test.c3',     'C3', '{}');
set session_replication_role = origin;
