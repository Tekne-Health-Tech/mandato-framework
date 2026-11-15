-- Negative fixture: a module migration that adds a column without a class comment (design 0001 §3, §7.2).
-- run.sh applies it inside a transaction that is rolled back, and expects the classification check to find it.
create schema mod_bad;
create table mod_bad.note (id uuid primary key, body text);
comment on column mod_bad.note.id is 'class=C1';
