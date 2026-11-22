#!/usr/bin/env node
// mandato validate <tenantDir> [--strict]      exit 0 when valid, 1 when not, 2 on usage error
// mandato bootstrap <tenantDir> <database>      as a superuser (PG* env): core schema, module owners and schemas
// mandato migrate <tenantDir> <database>        as migrator: forward-only core and module migrations
import { loadTenant } from '../src/load.js';
import { bootstrap, migrate } from '../../db/src/migrate.js';

const [cmd, dir, ...rest] = process.argv.slice(2);
const usage = () => { console.error('usage: mandato validate <tenantDir> [--strict] | bootstrap|migrate <tenantDir> <database>'); process.exit(2); };
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
