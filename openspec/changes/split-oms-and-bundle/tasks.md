## 1. Bundling on the monolithic file (no source split yet)

- [ ] 1.1 Add `esbuild` to `devDependencies`; move `commander`, `@clack/prompts`, `semver`, `yaml` from `dependencies` to `devDependencies`
- [ ] 1.2 Create `scripts/build.mjs` using the esbuild JS API: `entryPoints: ["scripts/oms.ts"]`, `outfile: "dist/oms.js"`, `bundle: true`, `platform: "node"`, `format: "esm"`, `target: "node20"`, `minify: false`, `keepNames: true`, no sourcemap, `legalComments: "eof"`, `metafile: true`, and the `createRequire` banner (`import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);`)
- [ ] 1.3 In `scripts/build.mjs`, after bundling: (a) fold in `gen-build-info.mjs` logic to write `dist/build-info.json`, preserving the git-absent `commit: null` fallback, then delete `scripts/gen-build-info.mjs`; (b) assert from the esbuild `metafile` that the only externals are `node:` builtins and all four deps appear in the bundle inputs — `process.exit(1)` otherwise; (c) explicitly `chmodSync('dist/oms.js', 0o755)` (do not rely on esbuild's implicit shebang exec bit)
- [ ] 1.4 Update `package.json` `build` script to `tsc --noEmit && node scripts/build.mjs` (type-check against base `tsconfig.json`); delete `tsconfig.build.json` (emit is now esbuild's job)
- [ ] 1.5 Run `npm test` — full black-box suite must pass against the bundled `dist/oms.js`
- [ ] 1.6 Verify `dist/oms.js` is ESM, has the shebang on line 1, is executable, and declares no runtime deps in `package.json`

## 2. Manual interactive smoke test (the test suite's blind spot)

- [ ] 2.1 In a real TTY, run a command that triggers an interactive `@clack/prompts` UI (e.g. `oms sync` with no alias) against the bundle and confirm select/multiselect/text render and accept input
- [ ] 2.2 Confirm `oms --version` reads the real package version (not the `0.0.0` fallback) and `oms doctor`/a docs-URL path resolves the build commit from `dist/build-info.json`

## 3. Source split into domain modules

- [ ] 3.1 Create `scripts/lib/types.ts`, `constants.ts`, `env.ts` (bottom-of-graph, no intra-lib deps) and move the corresponding declarations out of `oms.ts`. `env.ts` is the **single** module that calls `import.meta.url` (package root, the `findPackageRoot` module path, the `build-info.json` sibling lookup) and exports the results; no other module may call `import.meta.url`
- [ ] 3.2 Create `scripts/lib/git.ts` (runGit/runSub, version checks, branch/sha/dirty primitives) and `scripts/lib/manifest.ts` (validateSources, loadRepos, gitignore/legacy migration, gitmodules)
- [ ] 3.3 Create `scripts/lib/prompts.ts` (printList, selectInteractive, pickBranch, resolveRemotes, resolveCommandAlias)
- [ ] 3.4 Create `scripts/lib/repo-ops.ts` (sync/unsync/fetch/pull/push, printSummary), `scripts/lib/status.ts` (buildRepoStatus, runStatus, gitlink/pin/head state), `scripts/lib/commit.ts` (runCommit, runRecord, topology)
- [ ] 3.5 Create one module per meta command — `scripts/lib/agent.ts`, `skills.ts`, `init.ts`, `doctor.ts`, `update.ts` (flat under `scripts/lib/`) — and `scripts/lib/help.ts` (help strings)
- [ ] 3.6 Reduce `scripts/oms.ts` to the entry point: shebang, Commander wiring, `parseAsync`, importing runners from `lib/*`
- [ ] 3.7 Ensure every new relative import uses the `.js` extension (NodeNext) so `tsc --noEmit` passes; keep dependency direction one-way (no cycles)

## 4. Verification gate

- [ ] 4.1 Run `npm run build` — `tsc --noEmit` passes (type-checks reachable `lib/*`) and esbuild produces `dist/oms.js`
- [ ] 4.2 Run `npm test` — full suite passes against the bundle built from the split source
- [ ] 4.3 Re-run the manual interactive smoke test (task 2.1) against the post-split bundle
- [ ] 4.4 Add a **patch** changeset summary entry describing the build/packaging change (English, per repo policy) — e.g. "build: bundle the CLI into a single dependency-free `dist/oms.js`"
