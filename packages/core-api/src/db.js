// Request runner (design 0002 §7): one pooled connection as api_rt, one transaction, the verified claims as
// request.jwt.claims (transaction-local). Claims never come from anywhere but a verified token or the fixed anonymous
// claim of the sign-up hook.
export async function withRequest(pool, claims, fn, { statementTimeout } = {}) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('begin');
    if (statementTimeout) await client.query(`set local statement_timeout = ${Number(statementTimeout) | 0}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (e) {
    try { await client.query('rollback'); } catch { broken = true; }
    throw e;
  } finally {
    client.release(broken);
  }
}
