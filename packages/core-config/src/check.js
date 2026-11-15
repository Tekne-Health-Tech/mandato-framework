// Semantic checks JSON Schema cannot express (design 0001 §5, §6.3, §7.1). Each returns a list of problems.

/** tenant.yaml: one current key, at most one next, unique ids; modules and providers unique. */
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
  return problems;
}

/** mandato.module.json: roles and permissions live in the module's own namespace (no authority collisions). */
export function checkModule(m) {
  const problems = [];
  for (const r of m.roles ?? []) if (!r.id.startsWith(`${m.id}.`)) problems.push(`role ${r.id} is outside ${m.id}.*`);
  for (const p of m.permissions ?? []) if (!p.id.startsWith(`${m.id}.`)) problems.push(`permission ${p.id} is outside ${m.id}.*`);
  return problems;
}
