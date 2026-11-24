#!/usr/bin/env node
// mandato validate <tenantDir> [--strict]      exit 0 when valid, 1 when not, 2 on usage error
// mandato bootstrap <tenantDir> <database>      as a superuser (PG* env): core schema, module owners and schemas
// mandato migrate <tenantDir> <database>        as migrator: forward-only core and module migrations
// mandato keys init <tenantDir> <database> --kek-id <uuid>
//                                              as migrator: first DEKs of the staff columns (KEK from MANDATO_KEK_<id>)
// mandato staff bootstrap-chief <tenantDir> <database> --name <n> --email <e>
//                                              as migrator: the bootstrap invitation of the first chefe_gabinete
// mandato auth check <tenantDir> --project-ref <ref> --api-url <https url>
//                                              checks the hosted auth settings (SUPABASE_ACCESS_TOKEN, auth:read)
// mandato demo reset <tenantDir> <database>    rebuilds the fictitious mandate (database name must end in _demo/_dev)
import { loadTenant } from '../src/load.js';
import { bootstrap, migrate } from '../../db/src/migrate.js';

const argv = process.argv.slice(2);
const usage = () => {
  console.error('usage: mandato validate <tenantDir> [--strict] | bootstrap|migrate <tenantDir> <database>\n'
    + '       mandato keys init <tenantDir> <database> --kek-id <uuid>\n'
    + '       mandato staff bootstrap-chief <tenantDir> <database> --name <name> --email <email>\n'
    + '       mandato auth check <tenantDir> --project-ref <ref> --api-url <url>\n'
    + '       mandato demo reset <tenantDir> <database>');
  process.exit(2);
};
// Two-word operator commands; every flag takes a value and any unknown flag or extra argument is a usage error.
const TWO = { 'demo reset': [], 'keys init': ['kek-id'], 'staff bootstrap-chief': ['name', 'email'], 'auth check': ['project-ref', 'api-url'] };
const two = `${argv[0]} ${argv[1]}`;
if (TWO[two]) {
  const pos = []; const flags = {};
  for (let i = 2; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) { pos.push(argv[i]); continue; }
    if (!TWO[two].includes(m[1]) || i + 1 >= argv.length || m[1] in flags) usage();
    flags[m[1]] = argv[++i];
  }
  if (pos.length !== (two === 'auth check' ? 1 : 2) || TWO[two].some((f) => !(f in flags))) usage();
  const op = await import('../../core-api/src/operator.js');
  try {
    if (two === 'demo reset') {
      const { demoReset } = await import('../../core-api/src/demo.js');
      const r = await demoReset(pos[0], pos[1]);
      console.log(`demo reset: ${r.database} rebuilt with ${r.staff} synthetic staff${r.kekFile ? `; development KEK written to ${r.kekFile}` : ''}`);
    } else if (two === 'keys init') {
      const created = await op.keysInit(pos[0], pos[1], { kekId: flags['kek-id'] });
      console.log(created.length ? `keys init: created ${created.join(', ')}` : 'keys init: all staff keys already exist');
      for (const line of op.KEK_RECOVERY_STEPS) console.log(line);
    } else if (two === 'staff bootstrap-chief') {
      const id = await op.bootstrapChief(pos[0], pos[1], { name: flags.name, email: flags.email });
      console.log(`staff bootstrap-chief: invitation ${id} open for 7 days; the person signs up, enrols TOTP and activates`);
    } else {
      const results = await op.authCheck({ projectRef: flags['project-ref'], apiUrl: flags['api-url'], token: process.env.SUPABASE_ACCESS_TOKEN });
      for (const r of results) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.what} (${r.field})`);
      process.exit(results.every((r) => r.pass) ? 0 : 1);
    }
    process.exit(0);
  } catch (e) { console.error(`${two}: ${e.message}`); process.exit(1); }
}
const [cmd, dir, ...rest] = argv;
if (!dir) usage();
if (cmd === 'bootstrap' || cmd === 'migrate') {
  if (rest.length !== 1) usage();
  try {
    if (cmd === 'bootstrap') { bootstrap(rest[0], dir); console.log('bootstrap: done'); }
    else { const applied = migrate(rest[0], dir); console.log(applied.length ? `migrate: applied ${applied.join(', ')}` : 'migrate: up to date'); }
    process.exit(0);
  } catch (e) { console.error(`${cmd}: ${e.message}`); process.exit(1); }
}
if (cmd !== 'validate') usage();
// Any argument other than --strict is a usage error: a typo must not silently drop production validation.
if (rest.some((a) => a !== '--strict')) usage();
const { errors, pending } = loadTenant(dir, { strict: rest.includes('--strict') });
for (const p of pending) console.log(`pending: ${p}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(errors.length ? `${dir}: invalid (${errors.length} errors)` : `${dir}: valid`);
process.exit(errors.length ? 1 : 0);
