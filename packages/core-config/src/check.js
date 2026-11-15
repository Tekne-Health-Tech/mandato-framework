// Semantic checks JSON Schema cannot express (design 0001 §5, §6.3, §7.1). Each returns a list of problems.

// §5: a credential is always a `*_secret_ref`. Any other key that names a credential, or a value that looks like one,
// is refused anywhere in tenant.yaml, including module settings. The list errs on the side of refusing.
const CREDENTIAL_KEY = /(secret|token|passw|pwd|pin$|api_?key|apikey|credential|authorization|bearer|cookie|private_?key|client_?secret|access_?key|(^|_)key$|^key_|signature|salt)/i;
const CREDENTIAL_VALUE = /^\s*(bearer|basic|token|digest)\s+\S|-----BEGIN [A-Z ]*PRIVATE KEY-----|^(sk|pk|rk)_(live|test)_|^gh[pousr]_[A-Za-z0-9]{20,}|^xox[abpr]-|^AKIA[0-9A-Z]{16}$|^eyJ[A-Za-z0-9_-]+\.eyJ/i;

// Contract fields that hold public, non-secret material (publish_keys: Ed25519 public keys and their ids).
const PUBLIC_KEYS = new Set(['public_key', 'key_id']);

function credentials(value, path, problems) {
  if (Array.isArray(value)) value.forEach((v, i) => credentials(v, `${path}/${i}`, problems));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (CREDENTIAL_KEY.test(k) && !k.endsWith('_secret_ref') && !PUBLIC_KEYS.has(k)) problems.push(`${path}/${k} looks like an inline credential; use a *_secret_ref`);
      credentials(v, `${path}/${k}`, problems);
    }
  } else if (typeof value === 'string' && CREDENTIAL_VALUE.test(value)) problems.push(`${path} holds a value that looks like a credential; use a *_secret_ref`);
}

/** tenant.yaml: one current key, at most one next, unique ids; modules, providers, connectors, causes unique; no inline credentials. */
export function checkTenant(t) {
  const problems = [];
  const dup = (list, what) => {
    const seen = new Set();
    for (const id of list) { if (seen.has(id)) problems.push(`duplicate ${what} ${id}`); seen.add(id); }
  };
  const keys = t.publish_keys ?? [];
  dup(keys.map((k) => k.key_id), 'publish key id');
  dup(keys.map((k) => k.public_key), 'publish public key');
  if (keys.filter((k) => k.role === 'current').length !== 1) problems.push('publish_keys needs exactly one current key');
  if (keys.filter((k) => k.role === 'next').length > 1) problems.push('publish_keys allows at most one next key');
  dup((t.modules ?? []).map((m) => m.id), 'module');
  dup((t.ai?.providers ?? []).map((p) => p.id), 'AI provider');
  dup((t.connectors ?? []).map((c) => c.source_id), 'connector source_id');
  dup((t.causes ?? []).map((c) => c.slug), 'cause slug');
  credentials(t, '', problems);
  return problems;
}

/** mandato.module.json: roles and permissions live in the module's own namespace (no authority collisions). */
export function checkModule(m) {
  const problems = [];
  for (const r of m.roles ?? []) if (!r.id.startsWith(`${m.id}.`)) problems.push(`role ${r.id} is outside ${m.id}.*`);
  for (const p of m.permissions ?? []) if (!p.id.startsWith(`${m.id}.`)) problems.push(`permission ${p.id} is outside ${m.id}.*`);
  return problems;
}

/** Minimal range check for `requires_framework`: x.y.z, ^x.y.z, ~x.y.z, >=x.y.z. Returns null for other syntax. */
export function satisfies(version, range) {
  const m = /^(\^|~|>=)?(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  if (!m) return null;
  const v = version.split('.').map(Number); const r = [m[2], m[3], m[4]].map(Number);
  const cmp = v[0] - r[0] || v[1] - r[1] || v[2] - r[2];
  if (!m[1]) return cmp === 0;
  if (m[1] === '>=') return cmp >= 0;
  if (cmp < 0) return false;
  if (m[1] === '~') return v[0] === r[0] && v[1] === r[1];
  return r[0] > 0 ? v[0] === r[0] : r[1] > 0 ? v[0] === 0 && v[1] === r[1] : v[0] === 0 && v[1] === 0 && v[2] === r[2];
}
