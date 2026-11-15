-- Demo tenant seed (design 0001 §11). Fictitious mandate, synthetic data only: no real person, place or case.
-- Loaded as the database owner after 0001_core.sql, with triggers off, so the fixed timestamps stay as written
-- and the published fixture in tenants/demo/published/ is reproducible.
set session_replication_role = replica;
set timezone = 'UTC';

insert into core.instance (slug, display_name, house_acronym, uf, config_version, framework_version)
  values ('demo', 'Mandato Dep. Exemplo', 'ALEX', 'EX', 'demo', '0.1.0');

-- Staff: one user per framework role. Personal fields hold placeholder bytes, not ciphertext of real data.
insert into core.app_user (id, pii_name, pii_email, bi_email, status, created_at, updated_at) values
  ('00000000-0000-7000-8000-00000000d001', '\x00', '\x00', '\xd1', 'active', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000d002', '\x00', '\x00', '\xd2', 'active', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000d003', '\x00', '\x00', '\xd3', 'active', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000d004', '\x00', '\x00', '\xd4', 'active', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z');
insert into core.role_assignment (id, user_id, role_id, granted_by, granted_at, created_at, updated_at) values
  ('00000000-0000-7000-8000-00000000da01', '00000000-0000-7000-8000-00000000d001', 'parlamentar',    '00000000-0000-7000-8000-00000000d002', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000da02', '00000000-0000-7000-8000-00000000d002', 'chefe_gabinete', '00000000-0000-7000-8000-00000000d002', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000da03', '00000000-0000-7000-8000-00000000d003', 'comunicacao',    '00000000-0000-7000-8000-00000000d002', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000da04', '00000000-0000-7000-8000-00000000d004', 'operador',       '00000000-0000-7000-8000-00000000d002', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z');

insert into core.cause (slug, name, icon, sort, created_at, updated_at) values
  ('saude',        'Saúde',        'stethoscope', 1, '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('educacao',     'Educação',     'book',        2, '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('fiscalizacao', 'Fiscalização', 'search',      3, '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z');

-- Fictitious municipalities in the fictitious state "EX" (codes outside the real IBGE range for any UF).
insert into core.municipality (ibge_code, name, uf, health_region, population, population_ref_date, created_at, updated_at) values
  ('9900001', 'Vila Exemplo',   'EX', 'Região Exemplo 1', 52000, '2025-07-01', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('9900002', 'Serra Modelo',   'EX', 'Região Exemplo 1', 18500, '2025-07-01', '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('9900003', 'Praia Fictícia', 'EX', 'Região Exemplo 2', null,  null,         '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z');

-- Content: one item per state. Author = comunicação (d003), approver = chefe de gabinete (d002).
insert into core.content_item (id, type, state, current_version, published_version, published_at, author_id, approver_id, deleted_at, created_at, updated_at) values
  ('00000000-0000-7000-8000-00000000c001', 'nota',           'draft',     1, null, null,                   '00000000-0000-7000-8000-00000000d003', null,                                   null, '2026-11-03T12:00:00Z', '2026-11-03T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c002', 'artigo',         'in_review', 1, null, null,                   '00000000-0000-7000-8000-00000000d003', null,                                   null, '2026-11-03T12:00:00Z', '2026-11-03T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c003', 'balanco',        'approved',  1, null, null,                   '00000000-0000-7000-8000-00000000d003', '00000000-0000-7000-8000-00000000d002', null, '2026-11-04T12:00:00Z', '2026-11-04T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c004', 'noticia',        'published', 2, 2,    '2026-11-05T13:00:00Z', '00000000-0000-7000-8000-00000000d003', '00000000-0000-7000-8000-00000000d002', null, '2026-11-04T12:00:00Z', '2026-11-05T13:00:00Z'),
  ('00000000-0000-7000-8000-00000000c005', 'posicionamento', 'withdrawn', 1, 1,    '2026-11-02T13:00:00Z', '00000000-0000-7000-8000-00000000d003', '00000000-0000-7000-8000-00000000d002', null, '2026-11-02T12:00:00Z', '2026-11-10T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c006', 'card_dado',      'archived',  1, null, null,                   '00000000-0000-7000-8000-00000000d003', null,                                   null, '2026-10-20T12:00:00Z', '2026-10-30T12:00:00Z');
insert into core.content_version (content_id, n, title, summary, body_md, figures, created_by, created_at, updated_at) values
  ('00000000-0000-7000-8000-00000000c001', 1, 'Rascunho de nota', '', 'Texto em elaboração.', '[]', '00000000-0000-7000-8000-00000000d003', '2026-11-03T12:00:00Z', '2026-11-03T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c002', 1, 'Artigo em revisão', 'Resumo do artigo.', 'Corpo do artigo.', '[]', '00000000-0000-7000-8000-00000000d003', '2026-11-03T12:00:00Z', '2026-11-03T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c003', 1, 'Balanço aprovado', 'Resumo do balanço.', 'Corpo do balanço.', '[]', '00000000-0000-7000-8000-00000000d003', '2026-11-04T12:00:00Z', '2026-11-04T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c004', 1, 'Visita à unidade de saúde (versão 1)', 'Primeira versão.', 'Texto inicial.', '[]', '00000000-0000-7000-8000-00000000d003', '2026-11-04T12:00:00Z', '2026-11-04T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c004', 2, 'Visita à unidade de saúde de Vila Exemplo', 'O mandato visitou a unidade e registrou a fila de espera.',
     'Durante a visita, a equipe conversou com profissionais e registrou a situação da fila.',
     '[{"value":120,"unit":"pessoas","source_id":"demo-registro-visita","source_url":"https://example.org/fontes/visita","reference_date":"2026-11-05"}]',
     '00000000-0000-7000-8000-00000000d003', '2026-11-05T12:00:00Z', '2026-11-05T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c005', 1, 'Posicionamento retirado', 'Conteúdo retirado do ar.', 'Este texto foi retirado.', '[]', '00000000-0000-7000-8000-00000000d003', '2026-11-02T12:00:00Z', '2026-11-02T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c006', 1, 'Card arquivado', '', '', '[]', '00000000-0000-7000-8000-00000000d003', '2026-10-20T12:00:00Z', '2026-10-20T12:00:00Z');
insert into core.content_cause (content_id, cause_slug, created_at, updated_at) values
  ('00000000-0000-7000-8000-00000000c004', 'saude',        '2026-11-04T12:00:00Z', '2026-11-04T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c004', 'fiscalizacao', '2026-11-04T12:00:00Z', '2026-11-04T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000c005', 'saude',        '2026-11-02T12:00:00Z', '2026-11-02T12:00:00Z');

-- Agenda: two public events (published), one internal (never published), one public but deleted (tombstone).
insert into core.agenda_event (id, starts_at, ends_at, title, kind, municipality_ibge, place, visibility, status, deleted_at, created_at, updated_at) values
  ('00000000-0000-7000-8000-00000000e001', '2026-11-20T12:00:00Z', '2026-11-20T14:00:00Z', 'Audiência pública sobre saúde', 'audiencia', '9900001', 'Câmara Municipal de Vila Exemplo', 'public',   'planned', null, '2026-11-06T12:00:00Z', '2026-11-06T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000e002', '2026-11-08T13:00:00Z', null,                   'Visita à escola estadual',     'visita',    '9900002', 'Escola Exemplo',                   'public',   'done',    null, '2026-11-01T12:00:00Z', '2026-11-08T18:00:00Z'),
  ('00000000-0000-7000-8000-00000000e003', '2026-11-12T12:00:00Z', null,                   'Reunião interna de equipe',    'reuniao',   null,      '',                                 'internal', 'planned', null, '2026-11-01T12:00:00Z', '2026-11-01T12:00:00Z'),
  ('00000000-0000-7000-8000-00000000e004', '2026-11-25T12:00:00Z', null,                   'Evento removido',              'visita',    '9900003', 'Praça Central',                    'public',   'planned', '2026-11-12T12:00:00Z', '2026-11-06T12:00:00Z', '2026-11-12T12:00:00Z');

set session_replication_role = origin;
