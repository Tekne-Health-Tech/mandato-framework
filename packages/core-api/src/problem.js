// RFC 9457 problem details. Titles are fixed strings: never an e-mail, a name or a database message.
export class Problem extends Error {
  constructor(status, type, title) { super(type); this.status = status; this.type = type; this.title = title; }
}
export const problemResponse = (p) => new Response(
  JSON.stringify({ type: `urn:mandato:error:${p.type}`, title: p.title, status: p.status }),
  { status: p.status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } });
export const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body),
  { status, headers: body === undefined ? { 'cache-control': 'no-store' } : { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export const P = {
  unauthenticated: () => new Problem(401, 'unauthenticated', 'Sessão inválida ou expirada.'),
  aal2: () => new Problem(403, 'aal2_required', 'Confirme o segundo fator (aplicativo autenticador).'),
  reauth: () => new Problem(403, 'reauth_required', 'Confirme o código do autenticador novamente.'),
  forbidden: () => new Problem(403, 'forbidden', 'Sem permissão.'),
  notFound: () => new Problem(404, 'not_found', 'Não encontrado.'),
  badRequest: () => new Problem(400, 'bad_request', 'Requisição inválida.'),
  conflict: () => new Problem(409, 'conflict', 'A operação não é permitida no estado atual.'),
  tooLarge: () => new Problem(413, 'too_large', 'Requisição grande demais.'),
  internal: () => new Problem(500, 'internal', 'Erro interno.'),
};

/** Maps a database error to a problem without leaking its message. */
export function fromDb(e) {
  if (e instanceof Problem) return e;
  const m = String(e?.message ?? '');
  if (e?.code === 'P0001' && /: not allowed$/.test(m)) return P.forbidden();
  if (e?.code === 'P0001' || e?.code === '23505' || e?.code === '23514') return P.conflict();
  if (e?.code === '42501') return P.forbidden();
  if (e?.code === '22P02') return P.badRequest();
  return P.internal();
}
