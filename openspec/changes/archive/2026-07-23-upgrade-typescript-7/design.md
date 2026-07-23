## Context

`npm run build` runs `tsc --noEmit` as a type-check gate before esbuild bundles the CLI. TypeScript is a dev-only dependency (currently `^5.9.3`); it never emits — esbuild produces `dist/oms.js`. TypeScript 7.0 (a native Go rewrite of the compiler) is now GA and becomes the compiler line Microsoft carries forward; the `typescript@5` line will eventually stop receiving updates. The project's `tsconfig.json` is already written to TS7's defaults, which makes the upgrade a near drop-in replacement of the type-check engine. The advertised ~8–12x type-check speedup is immaterial at this project's scale (30 `.ts` files, sub-second type-check; measured TS5-vs-TS7 difference ~0.1–0.2s), so the motivation is staying on the maintained compiler line, not build speed.

## Goals / Non-Goals

**Goals:**

- Upgrade the `typescript` devDependency to `^7.0.2` so the project tracks the maintained TypeScript compiler line, keeping `tsc --noEmit` as the build's type-check gate.
- Keep the change scoped to a dependency bump plus lockfile refresh, releasable as a `patch`.
- Preserve the existing type-check gate behavior (a type error still fails the build).

**Non-Goals:**

- No changes to `tsconfig.json`, `@types/node`, source under `scripts/`, or CI workflows.
- No change to build output — `dist/oms.js` remains byte-identical (esbuild owns emit).
- Not adopting TS7-specific emit features or the language-service plugin surface (unused here).

## Decisions

- **Range `^7.0.2` rather than a pin.** Matches the existing caret-range convention for devDependencies and lets patch/minor TS7 fixes flow in. The current published version is `7.0.2`.
- **Rely on TS7's native binaries via optional dependencies.** TS7 ships platform-specific compiler binaries (`@typescript/typescript-*`) as optional deps. Verified the binaries required for this project exist: `@typescript/typescript-linux-x64` (CI `ubuntu-latest`) and `@typescript/typescript-darwin-arm64` (local dev). No manual binary handling needed.
- **`patch` changeset.** TypeScript is dev-only and emit is esbuild's; the published artifact does not change, so there is no minor/major surface change for consumers of `oms`.
- **No `tsconfig.json` migration.** The config already matches TS7 defaults (`target`/`lib` ES2023, `module`/`moduleResolution` NodeNext, `strict: true`, explicit `types: ["node"]`) and uses none of TS7's removed options (`baseUrl`, `downlevelIteration`, `alwaysStrict: false`, legacy `module`/`moduleResolution`/`target` values). Alternative considered — a staged 5→6→7 migration — is unnecessary because there are no deprecated options to retire.

## Risks / Trade-offs

- **Subtle type-checking divergence in the native port** → Mitigated by verification: `tsc --noEmit` on TS7 already passes with 0 errors across all 30 `.ts` files. CI re-runs the gate on every push.
- **Native binary unavailable on a contributor/CI platform** → Mitigated: the two platforms this project builds on (CI `linux-x64`, dev `darwin-arm64`) both have published binaries, and TS7's engine requirement (`node >=16.20.0`) is met by the CI minimum (20.19.0) and dev (`.nvmrc` = 24).
- **Rollback** → Trivial: revert the `package.json` range and lockfile to `typescript@^5.9.3`. No source or config depends on the compiler version.

## Migration Plan

1. Update the `typescript` range in `package.json` to `^7.0.2`.
2. Run `npm install` to refresh `package-lock.json` (pulls TS7 + native binaries).
3. Run `npm test` (build + type-check + black-box tests) to confirm the gate stays green.
4. Add a `patch` changeset.
