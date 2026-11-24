# core-api

Staff authentication API of the framework (design `docs/designs/0002-staff-auth.md`, E0.5). Framework-agnostic handlers on
the Fetch API: `createApi(...)` returns `(Request) => Promise<Response>`, which a Next.js route handler can mount as is.

```js
import pg from 'pg';
import { createApi } from './src/api.js';
import { createVerifier } from './src/jwt.js';

const api = createApi({
  pool: new pg.Pool({ user: 'api_rt' }),                    // the only database role the API uses
  verify: createVerifier({ issuer: `${SUPABASE_URL}/auth/v1`, jwksUri: `${SUPABASE_URL}/auth/v1/.well-known/jwks.json` }),
  hookSecret: process.env.MANDATO_SIGNUP_HOOK_SECRET,       // "v1,whsec_..." from the Supabase hook settings
  // env defaults to process.env and must hold MANDATO_KEK_<kek id, - as _> (base64, 32 bytes)
});
```

Operator commands (`pnpm mandato ...`): `keys init`, `staff bootstrap-chief`, `auth check`. See `packages/core-config/bin/mandato.js`.

Tests: `tests/core-api.test.js` (no network or database) and `test/api-pg.test.js` (run by `packages/db/test/run.sh`).

## Demo instance (E0.6)

`pnpm mandato demo reset tenants/demo mandato_demo` drops and rebuilds a fictitious mandate: core and module migrations,
`tenants/demo/seed.sql`, staff keys under a development KEK, and four synthetic staff (one per role, `@example.org`) with
real ciphertext. It refuses any database whose name does not end in `_demo` or `_dev`, and any tenant without a `seed.sql`.
The development KEK comes from `MANDATO_KEK_00000000_0000_7000_8000_00000000deef` or is created in
`<tenantDir>/.mandato-demo.env` (mode 0600, git-ignored). Synthetic data only; never point it at a real mandate.
