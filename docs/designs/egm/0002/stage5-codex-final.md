<!-- Codex (codex exec, read-only sandbox) report saved verbatim; only change: absolute local paths rewritten to repo-relative. -->

## Verdict
Closed.

2. **Closed** — [`hook.js:36`](packages/core-api/src/hook.js:36) uses owned reader; lines 39–50 cancel it on budget expiry or size overflow. [`hook.js:87`](packages/core-api/src/hook.js:87) aborts on timeout; line 91 also aborts during cleanup. Regression test at [`core-api.test.js:309`](tests/core-api.test.js:309) requires four abandoned reads to invoke cancellation at line 319. Reverting implementation makes `cancelled === 0`, failing expected `4`. Oversized-stream test at lines 323–333 also requires bounded reading and cancellation. `node --test tests/core-api.test.js` passed.

## New (diff-introduced only)

None.