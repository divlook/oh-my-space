## Why

TypeScript 7.0 — the native Go compiler that Microsoft carries forward as the default `tsc` — reached general availability, and the current `typescript@5` line will eventually stop receiving updates. The project's `tsconfig.json` is already fully aligned with TS7's defaults, so moving to the maintained compiler line now is a low-risk, near drop-in change with no behavioral cost. Note: the advertised ~8–12x type-check speedup does not apply at this scale — `tsc --noEmit` on this 30-file project already runs in under a second, and measured TS5-vs-TS7 times are within ~0.1–0.2s — so build speed is not the motivation; staying on the supported compiler line is.

## What Changes

- Bump the `typescript` devDependency from `^5.9.3` to `^7.0.2` in `package.json`.
- Refresh `package-lock.json` to install `typescript@7` and its platform-specific native compiler binaries (`@typescript/typescript-*` optional deps).
- Add a `patch` changeset recording the dependency bump.

Explicitly **out of scope** (no changes needed): `tsconfig.json`, `@types/node`, application source under `scripts/`, and CI workflows.

Not a breaking change: `typescript` is a dev-only dependency and emit is handled by esbuild, so the published `dist/oms.js` is unaffected.

## Capabilities

### New Capabilities

<!-- None. This is a build-tooling dependency bump with no new capability. -->

### Modified Capabilities

- `cli-bundle-packaging`: adds a requirement guaranteeing the `tsc --noEmit` type-check gate behavior is preserved across the `typescript` devDependency upgrade. The existing "Type checking gate retained" requirement is unchanged, and no runtime or emit behavior changes (esbuild owns the emit).

## Impact

- **Dependencies**: `typescript` `^5.9.3` → `^7.0.2` (devDependency); lockfile updated to pull native compiler binaries.
- **Build/CI**: `tsc --noEmit` runs on the TS7 native compiler. Verified the required native binaries exist for CI (`linux-x64`) and local dev (`darwin-arm64`); TS7 engine requirement (`node >=16.20.0`) is satisfied by the CI minimum (20.19.0) and the dev version (`.nvmrc` = 24).
- **Type-check compatibility**: `tsc --noEmit` passes with 0 errors across all 30 `.ts` files under `scripts/`. The current `tsconfig.json` already matches TS7 defaults (`target`/`lib` ES2023, `module`/`moduleResolution` NodeNext, `strict: true`, explicit `types: ["node"]`, no deprecated options such as `baseUrl`, `downlevelIteration`, or legacy module/target values).
- **Published artifact**: none — `dist/oms.js` is produced by esbuild and remains byte-identical, so there is no user-facing change (hence a `patch` release).
