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
