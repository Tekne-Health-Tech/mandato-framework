// E0.4: static screening of module migrations (design 0001 §7.2). The database tests run the runner itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { forbiddenStatements } from '../packages/db/src/migrate.js';

const rejects = {
  'SECURITY DEFINER': 'create function mod_x.f() returns int language sql security definer as $$ select 1 $$;',
  'event trigger': 'create event trigger t on ddl_command_start execute function mod_x.f();',
  'CREATE EXTENSION': 'create extension if not exists pg_trgm;',
  'role DDL': 'create role sneaky login;',
  'SET ROLE': 'set role postgres;',
  'search_path change': 'set search_path = core;',
  'object outside the module schema': 'insert into core.role (id, label) values (\'x\', \'x\');',
  'grant to client roles': 'grant select on mod_x.t to anon;',
};
test('each forbidden statement is rejected', () => {
  for (const [why, sql] of Object.entries(rejects)) assert.ok(forbiddenStatements(sql).includes(why), `${why}: ${sql}`);
});
test('comments and string literals do not trigger, and FKs to core ids are allowed', () => {
  assert.deepEqual(forbiddenStatements("-- security definer\ncomment on table mod_x.t is 'set role x; core.role';"), []);
  assert.deepEqual(forbiddenStatements('create table mod_x.t (id uuid primary key, content_id uuid references core.content_item(id));'), []);
});
test('the demo module migration passes', () =>
  assert.deepEqual(forbiddenStatements(readFileSync(new URL('../tenants/demo/modules/hello/db/migrations/0001_hello.sql', import.meta.url), 'utf8')), []));
test('only the audit row trigger may be named in audit (design 0003 §6.4)', () => {
  assert.deepEqual(forbiddenStatements('create trigger audit after insert on mod_x.t for each row execute function audit.row_trigger();'), []);
  for (const sql of ['create trigger a after insert on mod_x.t for each row execute function audit.write();',
    "select audit.write('x','mod_x.t',null,'{}');", 'create trigger a after insert on mod_x.t for each row execute function audit.row_trigger(); delete from audit.event;'])
    assert.ok(forbiddenStatements(sql).includes('object outside the module schema'), sql);
});
