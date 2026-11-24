// Staff API (design 0002 §7). Fetch-API handlers: `(Request) => Promise<Response>`; Next.js route handlers mount them
// as they are. The API checks; every definer function in the database checks again.
import { withRequest } from './db.js';
import { isAal2, recentTotp, AuthError } from './jwt.js';
import { staffKeyring, uuid7 } from './keys.js';
import { createSignupHook } from './hook.js';
import { P, Problem, problemResponse, json, fromDb } from './problem.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}\.[^\s@]{1,63}$/;
const STATUSES = ['active', 'suspended', 'removed'];
const MAX_BODY = 16 * 1024;
const BASE = '/api/v1';

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool       connects as api_rt
 * @param {(token: string) => Promise<object>} o.verify  from createVerifier
 * @param {string} [o.hookSecret]          the "v1,whsec_..." secret of the sign-up hook
 * @param {object} [o.env]                 holds MANDATO_KEK_<id>
 */
export function createApi({ pool, verify, hookSecret, env = process.env, nowSec = () => Date.now() / 1000, log = () => {} }) {
  const hook = hookSecret ? createSignupHook({ pool, secret: hookSecret, env, log }) : null;

  // ---------------------------------------------------------------- request helpers
  async function claimsOf(req, { recent = false } = {}) {
    const m = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(req.headers.get('authorization') ?? '');
    if (!m) throw P.unauthenticated();
    let claims;
    try { claims = await verify(m[1]); } catch (e) { if (e instanceof AuthError) throw P.unauthenticated(); throw e; }
    if (!isAal2(claims)) throw P.aal2();
    if (recent && !recentTotp(claims, 15 * 60, nowSec())) throw P.reauth();
    return claims;
  }
  async function bodyOf(req, { empty = false } = {}) {
    if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY) throw P.tooLarge();
    const text = await req.text();
    if (text.length > MAX_BODY) throw P.tooLarge();
    if (empty) { if (text.length) throw P.badRequest(); return null; }
    if (!/^application\/json(;|$)/.test(req.headers.get('content-type') ?? '')) throw P.badRequest();
    try { const v = JSON.parse(text); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* below */ }
    throw P.badRequest();
  }
  const only = (body, keys) => { if (Object.keys(body).some((k) => !keys.includes(k))) throw P.badRequest(); return body; };
  const run = (claims, fn) => withRequest(pool, claims, fn);
  async function requireChief(tx) {
    const { rows } = await tx.query("select core.has_permission('core.staff.manage') as ok");
    if (rows[0]?.ok !== true) throw P.forbidden();
  }
  function page(url) {
    const cursor = url.searchParams.get('cursor');
    const raw = url.searchParams.get('limit');
    const limit = raw === null ? 50 : Number(raw);
    if ((cursor !== null && !UUID.test(cursor)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw P.badRequest();
    return { cursor, limit };
  }
  async function rolesOf(tx, ids) {
    const { rows } = await tx.query(
      'select id, user_id, role_id, granted_at from core.role_assignment where revoked_at is null and user_id = any($1::uuid[]) order by granted_at',
      [ids]);
    const by = new Map(ids.map((i) => [i, []]));
    for (const r of rows) by.get(r.user_id)?.push({ assignment_id: r.id, role: r.role_id, granted_at: r.granted_at });
    return by;
  }

  // ---------------------------------------------------------------- handlers
  const routes = [
    ['GET', /^\/me$/, async (req) => {
      const claims = await claimsOf(req);
      return run(claims, async (tx) => {
        const { rows } = await tx.query('select id, status, pii_name from core.app_user where id = $1', [claims.sub]);
        if (!rows.length) throw new Problem(404, 'not_active', 'Conta não ativada ou inativa.');
        const keys = await staffKeyring(tx, env);
        const u = rows[0];
        const roles = (await rolesOf(tx, [u.id])).get(u.id);
        return json(200, { id: u.id, status: u.status, name: keys.decrypt('core.app_user.pii_name', u.id, u.pii_name), roles });
      });
    }],
    ['POST', /^\/me\/activate$/, async (req) => {
      const claims = await claimsOf(req);
      await bodyOf(req, { empty: true });
      if (typeof claims.email !== 'string' || !EMAIL.test(claims.email)) throw P.badRequest();
      return run(claims, async (tx) => {
        const keys = await staffKeyring(tx, env);
        const bi = keys.emailIndex(claims.email);
        const { rows } = await tx.query('select id, pii_name from core.my_invitation($1)', [bi]);
        if (rows.length !== 1) throw new Problem(403, 'no_invitation', 'Nenhum convite aberto para este e-mail.');
        const name = keys.decrypt('core.staff_invitation.pii_name', rows[0].id, rows[0].pii_name);
        await tx.query('select core.activate_invitation($1, $2, $3)', [bi,
          keys.encrypt('core.app_user.pii_name', claims.sub, name), keys.encrypt('core.app_user.pii_email', claims.sub, claims.email)]);
        return json(201, { id: claims.sub });
      });
    }],
    ['POST', /^\/staff\/invitations$/, async (req) => {
      const claims = await claimsOf(req, { recent: true });
      const { name, email } = only(await bodyOf(req), ['name', 'email']);
      if (typeof name !== 'string' || !name.trim() || name.length > 200) throw P.badRequest();
      if (typeof email !== 'string' || !EMAIL.test(email.trim())) throw P.badRequest();
      return run(claims, async (tx) => {
        await requireChief(tx);
        const keys = await staffKeyring(tx, env);
        const id = uuid7();
        await tx.query('select core.create_invitation($1, $2, $3, $4)', [id,
          keys.encrypt('core.staff_invitation.pii_name', id, name.trim()),
          keys.encrypt('core.staff_invitation.pii_email', id, email.trim()), keys.emailIndex(email)]);
        return json(201, { id });
      });
    }],
    ['DELETE', /^\/staff\/invitations\/([0-9a-f-]{36})$/, async (req, [id]) => {
      const claims = await claimsOf(req, { recent: true });
      return run(claims, async (tx) => {
        await requireChief(tx);
        await tx.query('select core.cancel_invitation($1)', [id]);
        return json(204);
      });
    }],
    ['GET', /^\/staff$/, async (req, _m, url) => {
      const claims = await claimsOf(req);
      const { cursor, limit } = page(url);
      return run(claims, async (tx) => {
        await requireChief(tx);
        const { rows } = await tx.query(
          'select id, status, pii_name, created_at from core.app_user where ($1::uuid is null or id > $1) order by id limit $2',
          [cursor, limit + 1]);
        const more = rows.length > limit; const list = rows.slice(0, limit);
        const keys = await staffKeyring(tx, env);
        const roles = await rolesOf(tx, list.map((u) => u.id));
        return json(200, {
          data: list.map((u) => ({ id: u.id, status: u.status, created_at: u.created_at,
            name: keys.decrypt('core.app_user.pii_name', u.id, u.pii_name), roles: roles.get(u.id) })),
          next_cursor: more ? list.at(-1).id : null,
        });
      });
    }],
    ['POST', /^\/staff\/([0-9a-f-]{36})\/roles$/, async (req, [id]) => {
      const claims = await claimsOf(req, { recent: true });
      const { role } = only(await bodyOf(req), ['role']);
      if (typeof role !== 'string' || !/^[a-z][a-z0-9_.]{0,80}$/.test(role)) throw P.badRequest();
      return run(claims, async (tx) => {
        await requireChief(tx);
        const { rows } = await tx.query('select core.grant_role($1, $2) as id', [id, role]);
        return json(201, { assignment_id: rows[0].id });
      });
    }],
    ['DELETE', /^\/staff\/roles\/([0-9a-f-]{36})$/, async (req, [id]) => {
      const claims = await claimsOf(req, { recent: true });
      return run(claims, async (tx) => {
        await requireChief(tx);
        await tx.query('select core.revoke_role($1)', [id]);
        return json(204);
      });
    }],
    ['POST', /^\/staff\/([0-9a-f-]{36})\/status$/, async (req, [id]) => {
      const claims = await claimsOf(req, { recent: true });
      const { status } = only(await bodyOf(req), ['status']);
      if (!STATUSES.includes(status)) throw P.badRequest();
      return run(claims, async (tx) => {
        await requireChief(tx);
        await tx.query('select core.set_user_status($1, $2)', [id, status]);
        return json(204);
      });
    }],
    ['GET', /^\/audit\/events$/, async (req, _m, url) => {
      const claims = await claimsOf(req);
      const { cursor, limit } = page(url);
      return run(claims, async (tx) => {
        await requireChief(tx);
        const { rows } = await tx.query(
          `select id, at, actor_kind, actor_id, action, entity, entity_id, details from audit.event
            where ($1::uuid is null or id < $1) order by id desc limit $2`, [cursor, limit + 1]);
        const more = rows.length > limit; const data = rows.slice(0, limit);
        return json(200, { data, next_cursor: more ? data.at(-1).id : null });
      });
    }],
  ];

  return async function handle(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(`${BASE}/`)) return problemResponse(P.notFound());
    const path = url.pathname.slice(BASE.length);
    if (path === '/auth/hooks/before-user-created') return hook ? hook(req) : problemResponse(P.notFound());
    let pathMatched = false;
    for (const [method, re, fn] of routes) {
      const m = re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (method !== req.method) continue;
      const params = m.slice(1);
      if (params.some((p) => !UUID.test(p))) return problemResponse(P.notFound());
      try { return await fn(req, params, url); } catch (e) {
        const p = fromDb(e);
        if (p.status >= 500) log(`api: ${req.method} ${re.source} failed: ${e?.code ?? e?.name ?? 'error'}`);
        return problemResponse(p);
      }
    }
    return problemResponse(pathMatched ? new Problem(405, 'method_not_allowed', 'Método não permitido.') : P.notFound());
  }
}
