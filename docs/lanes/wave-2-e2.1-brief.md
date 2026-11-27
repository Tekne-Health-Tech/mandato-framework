# Wave 2 · E2.1 brief: citizen app shell (executor: Codex, reviewer: Claude)

Repository: `Tekne-Health-Tech/mandato-framework` (AGPL-3.0-only). Read `AGENTS.md` first and follow it.

## Goal

Create `apps/mobile`: an Expo (React Native) app with Expo Router. It has one codebase and two build variants: `citizen` (this item) and `gabinete` (later, E8.1, so only leave the switch). The app shows a mandate's published content offline. Screens with real content come in E2.2. E2.1 delivers the shell those screens plug into.

## Inputs you must use (read them)

- `docs/designs/0001-core-contracts.md`: §6.2–§6.3 (published bundles and manifest), §7.6 (TypeScript contracts: `Screen`, `Route`, guarded by permission), §8 (design tokens).
- `packages/core-contracts/src/index.ts`: import the types from here and do not redefine them.
- `packages/core-theme/src/native.js`: generate the React Native theme from `tenants/<tenant>/theme/tokens.json`, never hard-code colours.
- `packages/core-publish/schema/bundle.schema.json`, `packages/core-publish/src/manifest.js` and `tenants/demo/published/`: the manifest and bundle format, and real demo bundles to read.
- `tenants/demo/tenant.yaml`: tenant config (name, causes, feature flags).

## Scope

1. `apps/mobile` with a pinned Expo SDK. Use exact versions in `package.json`, each release at least 2 weeks old. Add it to the pnpm workspace, and keep `pnpm install --frozen-lockfile` working (commit the lockfile).
2. Tenant at build time: `MANDATO_TENANT=tenants/demo` (default demo) is read by `app.config.ts`. Name, slug, theme tokens and the enabled-module list come from the tenant, and nothing is mandate-specific in code.
3. Five tabs (Expo Router): `inicio`, `mandato`, `causas`, `agenda`, `participe`. Use placeholder screens that render data from the local store (list of titles is enough). Labels are in pt-BR. Icons come from `@expo/vector-icons`.
4. Offline store: `expo-sqlite`, using a sync module `src/sync/` with three steps:
   - fetch `manifest.json` from a configured base URL with `If-None-Match` (ETag);
   - verify each bundle's sha256 against the manifest before storing;
   - apply only changed bundles, honour takedowns and tombstones (records removed), and keep the last good data when offline or on any verification failure.

   The base URL comes from the tenant config or env. For dev and tests, it serves `tenants/demo/published/`.
5. Variant switch `APP_VARIANT=citizen|gabinete`. Only `citizen` is built now, and `gabinete` throws "not in E2.1".
6. No analytics, trackers, ads, remote fonts or third-party SDKs that send data. No user identity in the citizen app. Accessibility: every touchable has a label, and the app respects system font scaling.

## Tests (definition of done; write each to fail first)

- The sync logic is pure TypeScript and is tested in Node with `node --test` or vitest, without a device:
  - accepts the demo manifest;
  - refuses a bundle with a wrong sha256 and keeps the previous data;
  - a 304 (ETag) does nothing;
  - a takedown removes the record;
  - a failed fetch keeps the old data.
- Theme: the generated RN theme equals `native.js` output for the demo tokens.
- `npx expo export --platform web` (or `expo-doctor` plus a TypeScript check) runs in CI without errors. Add a CI step in `.github/workflows/ci.yml` (contracts job or a new `mobile` job).
- `pnpm test`, `npx tsc -p .` and `scripts/check-boundaries.sh` still pass.

## Out of scope

Real screen content (E2.2), push and PWA (E2.3), store builds (E2.4), the gabinete variant (E8.1), and any login.

## Deliver

Commit on a local branch. Add `docs/lanes/wave-2-e2.1.md` with three things:
- what was built;
- the exact versions chosen, with their release dates;
- the test list with results.

The reviewer is Claude (cross-provider).
