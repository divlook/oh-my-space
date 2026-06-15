## Why

`scripts/oms.ts` has grown to a single 3196-line / 120KB file, making it hard to navigate and maintain. While restructuring it into domain modules, we also want the published artifact to stay a single self-contained file. The current `tsc` step only transpiles one file; once the source is split it would emit many `dist/*.js` files and still rely on `node_modules` at runtime. Switching to an esbuild bundle lets us split the source freely while shipping one dependency-free executable.

## What Changes

- Split `scripts/oms.ts` into a thin entry point (shebang + Commander wiring + `parseAsync`) plus domain modules under `scripts/lib/` (types, constants, help, env, git, manifest, prompts, repo-ops, status, commit, and the meta commands).
- Replace the `tsc`-emit build with an esbuild bundle (`scripts/build.mjs`) that produces a single `dist/oms.js`, inlining the runtime dependencies (`commander`, `@clack/prompts`, `semver`, `yaml`). The bundle is not minified and ships no sourcemap (`keepNames: true` for readable stack traces), preserves inlined-dep license notices via `legalComments: "eof"`, and asserts self-containment from the esbuild `metafile` (only `node:` builtins external) so an accidentally-externalized dep fails the build.
- Keep type safety by running `tsc --noEmit` against the base `tsconfig.json` (which already includes all of `scripts/**/*.ts`) as a dedicated type-check step before bundling. The emit-only `tsconfig.build.json` is removed since esbuild now owns emit.
- Move the four runtime dependencies to `devDependencies` and add `esbuild` as a dev dependency (they are inlined into the bundle, so consumers install nothing).
- Preserve the existing runtime contract: `dist/oms.js` stays at the same path, ESM format (so `import.meta.url` resolution holds), with shebang and executable bit intact; `dist/build-info.json` continues to be generated as a sibling.

No user-facing CLI behavior, command surface, or output changes. This is an internal restructuring plus a build/packaging change.

## Capabilities

### New Capabilities
- `cli-bundle-packaging`: The published `oms` CLI is distributed as a single self-contained ESM bundle at `dist/oms.js` with no runtime `node_modules` dependencies, while preserving the runtime path-resolution contract (package root, build-info, dev-mode detection) and passing the full black-box test suite.

### Modified Capabilities
<!-- None: no spec-level CLI behavior requirements change. The source split is an internal refactor with no requirement impact. -->

## Impact

- **Source**: `scripts/oms.ts` decomposed into `scripts/oms.ts` (entry) + `scripts/lib/*.ts` domain modules.
- **Build**: new `scripts/build.mjs` (esbuild API) that also writes `dist/build-info.json` (the `gen-build-info.mjs` logic is folded in and the standalone file deleted, preserving the git-absent `commit: null` fallback) and explicitly `chmod`s the output to `0o755`; `package.json` `build` script becomes `tsc --noEmit && node scripts/build.mjs`. The emit-only `tsconfig.build.json` is deleted.
- **Dependencies**: `commander`, `@clack/prompts`, `semver`, `yaml` moved to `devDependencies`; `esbuild` added to `devDependencies`. Published package ships only `dist/`.
- **Tests**: `tests/cli.test.js` is unchanged — it spawns `dist/oms.js` as a black box and serves as the regression gate. Note it does not exercise interactive (`@clack/prompts`) code paths, which need a separate manual smoke check.
- **Distribution**: bundle vendors third-party code into `dist/oms.js` (all MIT/ISC — license-compatible); `legalComments: "eof"` preserves each dep's required copyright/permission notice at end-of-file, satisfying attribution while keeping a single file.
