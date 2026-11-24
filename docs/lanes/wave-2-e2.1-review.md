# Wave 2 · E2.1 review (reviewer: Claude, cross-provider; executor: Codex)

Commit reviewed: `0aa9373` on `wave2-e2.1`, against `docs/lanes/wave-2-e2.1-brief.md` and design 0001 §6.3
(lockfile body skipped). Checks re-run by the reviewer: `pnpm install --frozen-lockfile`, `pnpm test` (104/104),
`npx tsc -p .`, `scripts/check-boundaries.sh`, mobile typecheck and `expo export --platform web`: all pass.

Mutation checks (each applied, test run, then reverted):

| Mutation | Result |
|---|---|
| remove the sha256 comparison (`src/sync/index.ts:100`) | `sync.test.ts` fails (1 test) — guarded |
| make the takedown filter keep everything (`src/sync/index.ts:106-107`) | `sync.test.ts` fails (1 test) — guarded |
| remove the `expires_at` check (`src/sync/verify.ts:48`) | `verify.test.ts` still passes — **not guarded** (S3) |

## Blockers

**B1 — Takedowns are applied only when every bundle downloads and verifies.**
`apps/mobile/src/sync/index.ts:98-107`. The takedown filter runs after the bundle loop, and any bundle failure
returns `failed` before reaching it. Design 0001 §6.3 step 3 applies `takedowns[]` before any version check and
independently of bundle downloads ("even an unsupported app removes withdrawn content").
Scenario: the office withdraws record X; the new manifest lists X in `takedowns[]` and also changes one partition.
The device is on a flaky connection, so that partition's download fails (or its hash does not match because a CDN
serves a stale object). Sync returns `failed`, the stored snapshot is untouched, and X stays visible on the device
for as long as the bundle keeps failing.
Required: after signature and generation checks, apply `takedowns[]` to the stored snapshot in its own
transaction, then proceed with bundles. Add a test where the takedown is present and a bundle fetch fails.

**B2 — No `min_generation_at_build`: a fresh install accepts an older signed manifest.**
`apps/mobile/src/build-config.ts` (no such field), `apps/mobile/src/sync/index.ts:87`. Stored generation starts at
0, so any validly signed, unexpired manifest is accepted on first sync. Design 0001 §6.3 (Freshness): "The build
also embeds `min_generation_at_build`, so a fresh install rejects anything older than the build."
Scenario: a cache or a hostile network serves a manifest signed 5 days ago (still inside the 7-day `expires_at`),
before a withdrawal. A newly installed app accepts it and shows the withdrawn record, which the newer manifest's
`takedowns[]` would have removed.
Required: embed `min_generation_at_build` from the tenant/published manifest at build time and reject manifests
below it. Test: a fresh store refuses a manifest with `generation < min_generation_at_build`.

**B3 — The base URL is not forced to HTTPS; production builds default to plain HTTP localhost.**
`apps/mobile/src/build-config.ts:33`. `MANDATO_PUBLISH_BASE_URL ?? 'http://127.0.0.1:4173'`, with no scheme check.
Scenario 1: a release build made without the variable ships pointing at `http://127.0.0.1:4173`; the app silently
never syncs. Scenario 2: an `http://` public URL is accepted, so every request (which reveals what a citizen reads,
and when) travels in clear text; integrity holds only because of the signature.
Required: accept `https://` always and `http://` only for `localhost`/`127.0.0.1` in development; fail the build
otherwise; no silent default for release builds. Test both refusals in `build-config`.

## Non-blocking

**S1 — `min_app_version` is ignored.** `src/sync/index.ts` (`isManifest`, no check). §6.3 step 4: above the app
version, stop after takedowns, keep cached data and show the update banner. Scenario: a breaking bundle change
(new `schema_version`) is applied by an old app. Can wait for E2.2 if recorded.

**S2 — No `keyring_update` handling; `role` is ignored and `revoked` is never set.** `src/sync/verify.ts:6,49`.
Key rotation works only by shipping a new build. Acceptable for E2.1 if recorded as deferred.

**S3 — Freshness and key checks are not tested.** `test/verify.test.ts` covers only the valid and tampered demo
manifest. Removing the expiry check passes all tests. Add: expired manifest refused, unknown `key_id` refused,
wrong `alg` refused. `sync.test.ts` uses `verify: () => true`, so no test covers a refused signature inside the
sync flow either (one test with `verify: () => false` keeping old data).

**S4 — Generation rollback and `min_generation` drop are untested.** `src/sync/index.ts:87-88`. Add: a manifest
with a lower generation is ignored; `min_generation` above the stored generation drops cached partitions.

**S5 — Sync errors are swallowed without a trace, and `openStore` failures are unhandled.**
`src/store.tsx:14` (`void openStore().then(...)` with no `catch`); `src/sync/index.ts:114-115` (`catch {}` returns
`failed` without a reason). Scenario: SQLite open fails on a device; an unhandled rejection is raised and the user
sees an empty app with no message. Return a reason code (no data) and catch in the provider.

**S6 — Theme tokens are used for colours only.** `src/PlaceholderScreen.tsx:28-30` hard-codes `fontSize` 24/16,
padding 24 and `paddingVertical` 12 instead of the token `typography.scale` and `spacing`. Colours are correct
(all from `tenant.theme`, generated by `core-theme/native.js`).

**S7 — Whole dataset stored as one JSON row.** `src/sync/sqlite.ts` (single `sync_state` row). Atomic and fine for
the demo; with a year of content and agenda partitions every sync rewrites and every screen re-parses the full
blob. Partition rows can come in E2.2.

**S8 — Cached bundles keep takedown-filtered records under the original hash.** `src/sync/index.ts:93-96,107`.
The stored records of a reused bundle no longer match its `sha256`. Harmless today (bundles are replaced on any
hash change), but a later integrity re-check would fail. Store the filter result separately or document it.

## Checked and fine

- sha256 is computed and compared before anything is stored; one `replace` per sync, inside one SQLite
  transaction; any failure before it leaves the previous snapshot intact (including partial bundle sets).
- 304 returns before any write; ETag sent as `If-None-Match` and stored from the response.
- Ed25519 over an RFC 8785-style canonical form (sorted keys, `JSON.stringify` numbers and strings), base64url,
  key chosen by `key_id` from the build keyring taken from `tenant.yaml publish_keys`.
- Partitions absent from the manifest are dropped (the snapshot is rebuilt from the manifest's bundle list), so
  full-snapshot tombstones work.
- Dependencies, one by one: `expo`, `expo-router`, `expo-sqlite`, `expo-crypto`, `expo-constants`, `expo-font`,
  `expo-linking`, `expo-status-bar`, `@expo/metro-runtime`, `@expo/vector-icons` (icon fonts bundled, not
  remote), `react`, `react-dom`, `react-native`, `react-native-web`, `react-native-screens`,
  `react-native-safe-area-context`, `tweetnacl`, `yaml` (build-time only, used by `app.config.ts`). No analytics,
  crash reporting, ads, push, remote fonts or `expo-updates`. No user identity anywhere. The only runtime
  network calls are the two GETs in `src/sync/index.ts` to the configured base URL.
- Accessibility: tabs carry `tabBarAccessibilityLabel` and icon labels; there are no other touchables; every
  `Text` keeps font scaling (`allowFontScaling`, no `maxFontSizeMultiplier`).
- `APP_VARIANT=gabinete` throws `not in E2.1`; unknown variants throw.
- Note: the `start` script does not set `EXPO_NO_TELEMETRY=1` (only `export:web` does). That is Expo CLI telemetry
  on the developer machine, not the app, but consistent with the no-tracker rule it should be set too.

Verdict: **3 blockers (B1–B3)**, 8 non-blocking.
