// Operator commands of E0.5 (design 0002 §4 step 0, §8). They run on the operator's machine, never in the API.
//   keys init         as migrator: wraps and registers the first DEKs of the staff columns and the e-mail index key
//   bootstrap-chief   as migrator: the one bootstrap invitation for the first chefe_gabinete
//   auth check        reads the hosted project's auth configuration (Management API, auth:read) and checks it
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import * as c from '../../crypto/src/envelope.js';
import { loadTenant } from '../../core-config/src/load.js';
import { uuid7 } from './keys.js';

export const STAFF_KEY_PURPOSES = ['core.app_user.pii_name', 'core.app_user.pii_email',
  'core.staff_invitation.pii_name', 'core.staff_invitation.pii_email', 'bi:email:v1'];

function slugOf(tenantDir) {
  const { config, errors } = loadTenant(tenantDir);
  if (errors.length) throw new Error(`tenant invalid: ${errors[0]}`);
  return config.instance.slug;
}

/** One transaction as migrator under a migration lease, so every audited row names the operation. */
async function asOperator(database, ref, fn) {
  const client = new pg.Client({ database, user: 'migrator' });
  await client.connect();
  try {
    await client.query('begin');
    await client.query("select audit.bind_migration('core', $1)", [ref]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { await client.end(); }
}

export async function keysInit(tenantDir, database, { kekId, env = process.env }) {
  await c.ready();
  const slug = slugOf(tenantDir);
  const kek = c.loadKek(kekId, env);
  return asOperator(database, `keys-init:${uuid7()}`, async (tx) => {
    const created = [];
    for (const purpose of STAFF_KEY_PURPOSES) {
      const keyId = uuid7();
      const dek = new Uint8Array(randomBytes(32));
      const wrapped = c.wrapDek(kek, kekId, dek, slug, purpose, keyId);
      dek.fill(0);
      const { rows } = await tx.query('select core.add_staff_key($1, $2, $3) as added', [keyId, purpose, wrapped]);
      if (rows[0].added) created.push(purpose);
    }
    return created;
  });
}

export const KEK_RECOVERY_STEPS = [
  'Recovery copy of the KEK (design 0001 §4.6), once per KEK version, before it is ever needed:',
  '  1. On an offline machine, encrypt the KEK to the public keys of two named people of the mandate:',
  '       printf %s "$MANDATO_KEK_<id>" | age -r <recipient-1> -r <recipient-2> > kek-<id>.age',
  '  2. Store kek-<id>.age offline with the mandate (either person can restore it).',
  '  3. Never commit, e-mail or paste the KEK; it lives only in the instance secret store.',
];

export async function bootstrapChief(tenantDir, database, { name, email, env = process.env }) {
  await c.ready();
  if (typeof name !== 'string' || !name.trim() || name.length > 200) throw new Error('--name is required');
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('--email is invalid');
  const slug = slugOf(tenantDir);
  return asOperator(database, `bootstrap-chief:${uuid7()}`, async (tx) => {
    const { rows } = await tx.query("select key_id, purpose, version, enc_wrapped_key from core.staff_keys() where state = 'active'");
    const key = (purpose) => {
      const k = rows.find((r) => r.purpose === purpose);
      if (!k) throw new Error(`no active key for ${purpose}: run mandato keys init first`);
      return { ...k, dek: c.unwrapDek(c.loadKek(c.keyIdOf(k.enc_wrapped_key), env), k.enc_wrapped_key, slug, purpose, k.key_id) };
    };
    const id = uuid7();
    const seal = (col, text) => { const k = key(col); return c.seal(k.dek, k.key_id, Buffer.from(text, 'utf8'), c.dataAad(slug, col, id)); };
    const bi = key('bi:email:v1');
    await tx.query('select core.create_bootstrap_invitation($1, $2, $3, $4)', [id,
      seal('core.staff_invitation.pii_name', name.trim()), seal('core.staff_invitation.pii_email', email.trim()),
      c.emailIndex(bi.dek, bi.version, email)]);
    return id;
  });
}

// ---------------------------------------------------------------- auth check
// Field names checked against Supabase's published OpenAPI (AuthConfigResponse_Output), 2026-11-23. A missing field
// fails: an unreadable setting is never a pass.
export function checkAuthConfig(cfg, { apiUrl }) {
  const hookUri = `${apiUrl.replace(/\/$/, '')}/api/v1/auth/hooks/before-user-created`;
  const rules = [
    ['hook_before_user_created_enabled', (v) => v === true, 'sign-up hook enabled'],
    ['hook_before_user_created_uri', (v) => v === hookUri, `sign-up hook points to ${hookUri}`],
    ['mailer_autoconfirm', (v) => v === false, 'e-mail confirmation required'],
    ['mfa_totp_enroll_enabled', (v) => v === true, 'TOTP enrolment enabled'],
    ['mfa_totp_verify_enabled', (v) => v === true, 'TOTP verification enabled'],
    ['mfa_phone_enroll_enabled', (v) => v === false, 'phone MFA enrolment disabled'],
    ['mfa_phone_verify_enabled', (v) => v === false, 'phone MFA verification disabled'],
    ['mfa_web_authn_enroll_enabled', (v) => v === false, 'WebAuthn MFA enrolment disabled'],
    ['mfa_web_authn_verify_enabled', (v) => v === false, 'WebAuthn MFA verification disabled'],
    ['external_anonymous_users_enabled', (v) => v === false, 'anonymous sign-in disabled'],
    ['jwt_exp', (v) => Number.isInteger(v) && v > 0 && v <= 900, 'JWT expiry at most 15 minutes'],
    ['sessions_inactivity_timeout', (v) => typeof v === 'number' && v > 0, 'inactivity timeout set (Supabase Pro)'],
    ['password_min_length', (v) => Number.isInteger(v) && v >= 12, 'password minimum length at least 12'],
  ];
  return rules.map(([field, ok, what]) => ({ field, what, pass: Object.hasOwn(cfg ?? {}, field) && ok(cfg[field]) }));
}

export async function authCheck({ projectRef, apiUrl, token, fetchFn = fetch, base = 'https://api.supabase.com' }) {
  if (!/^[a-z0-9]{20}$/.test(projectRef ?? '')) throw new Error('--project-ref is a 20-character Supabase project ref');
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(apiUrl ?? '')) throw new Error('--api-url must be the https URL of the instance API');
  if (!token) throw new Error('SUPABASE_ACCESS_TOKEN is not set (operator token, auth:read scope)');
  const res = await fetchFn(`${base}/v1/projects/${projectRef}/config/auth`,
    { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Management API answered HTTP ${res.status}`);
  return checkAuthConfig(await res.json(), { apiUrl });
}
