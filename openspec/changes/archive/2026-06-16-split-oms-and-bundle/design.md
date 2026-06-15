## Context

`scripts/oms.ts` is a single 3196-line file compiled by `tsc -p tsconfig.build.json` into `dist/oms.js` (the `oms` bin). The package is ESM-only (`"type": "module"`, no `main`/`exports`, bin-only). Runtime dependencies (`commander`, `@clack/prompts`, `semver`, `yaml`) are resolved from `node_modules` at runtime today.

Two runtime facts constrain any build change:
- `const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")` — assumes `dist/oms.js` sits one level under the package root; used to read `package.json` (version), detect dev mode (`scripts/oms.ts` existence), and locate docs.
- `readBuildCommit()` reads `dist/build-info.json` as a sibling of the running module.

The test suite (`tests/cli.test.js`) is a black box: it spawns `resolve("dist/oms.js")` via `spawnSync` and asserts on stdout/exit codes. It therefore validates any source layout or bundling strategy, provided `dist/oms.js` still works at the same path. A PoC esbuild bundle of the current monolithic file confirmed the approach (see Decisions).

## Goals / Non-Goals

**Goals:**
- Decompose `scripts/oms.ts` into a thin entry point plus cohesive `scripts/lib/*` domain modules.
- Ship a single self-contained `dist/oms.js` with the four runtime deps inlined; published package has zero runtime dependencies.
- Preserve all existing CLI behavior, the runtime path-resolution contract, and type safety.

**Non-Goals:**
- No CLI command/output/behavior changes.
- No CJS output, no `.d.ts`, no library/public API (this is a bin only) — which is why a multi-format bundler is unnecessary.
- No change to `tests/cli.test.js`.

## Decisions

### Bundler: raw esbuild via `scripts/build.mjs` (not tsup)
esbuild produces a working single-file ESM bundle (PoC verified `--help`/`--version`). tsup wraps the same esbuild engine but its differentiators — dual CJS+ESM output, `.d.ts` generation, multi-entry — are all unused here, and its default is to *externalize* dependencies, which fights the inline-deps goal. Raw esbuild's "bundle everything" default matches the goal and adds one fewer dev dependency. A small `scripts/build.mjs` (esbuild JS API) holds the config and chains the bundle + build-info generation.

esbuild options (PoC-verified): `bundle: true, platform: "node", format: "esm", target: "node20"`. Output-shape options (decided): `minify: false` and no sourcemap — this is a single self-contained CLI rebuilt every release, so bundle size is irrelevant and readable stack traces matter more; `keepNames: true` to preserve function/class names so any `error.name`/constructor-based branching survives transformation; `legalComments: "eof"` to collect the inlined deps' MIT/ISC notices at end-of-file (attribution preserved, single file kept). Build with `metafile: true` and assert from it that the only externals are `node:` builtins and that all four packages appear in the bundle inputs — fail the build (`process.exit(1)`) otherwise. This is the deterministic self-containment gate the black-box tests cannot provide: they run inside the repo where `node_modules` exists, so an accidentally-externalized dep would still resolve in tests yet break the zero-runtime-dep published package.

### CJS interop via `createRequire` banner (required)
Inlining CommonJS deps (e.g. `commander`) into an ESM bundle triggers `Error: Dynamic require of "node:events" is not supported` at runtime. The fix is an esbuild `banner.js`:
```
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);
```
This is an esbuild-engine-level issue, not tool-specific. esbuild keeps the source shebang on line 1 and inserts the banner after it. PoC confirmed the banner resolves the error and `import.meta.url` is preserved.

### Type-check via the base `tsconfig.json`; remove `tsconfig.build.json`
esbuild does not type-check. `tsconfig.build.json` existed only for emit settings (`outDir`/`rootDir`/`declaration:false`); now that esbuild owns emit, it is deleted. The `build` script becomes `tsc --noEmit && node scripts/build.mjs`, type-checking against the base `tsconfig.json` whose `include` is already `["scripts/**/*.ts"]`. This checks every module unconditionally — including orphan (not-yet-imported) modules that appear mid-split — closing the gap a narrow entry-only `include` would leave.

### NodeNext requires `.js` extensions on relative imports
With `moduleResolution: "NodeNext"`, new relative imports must use the `.js` extension (`import { runGit } from "./lib/git.js"`). esbuild tolerates extensionless imports, so this only bites at the `tsc --noEmit` step — every new intra-`scripts` import must carry `.js`.

### Module boundaries (one-way dependency direction)
Entry `scripts/oms.ts` keeps the shebang, Commander wiring, and `parseAsync`. Domain modules under `scripts/lib/` (flat, no sub-directories): `types`, `constants`, `help`, `env`, `git`, `manifest`, `prompts`, `repo-ops`, `status`, `commit`, and the meta commands split one-file-per-command from the start — `agent`, `skills`, `init`, `doctor`, `update` ("meta" is a conceptual label, not a directory). Dependency direction stays one-way with `types`/`constants`/`env` at the bottom to avoid ESM init-order cycles. All `import.meta.url`-based path resolution (package root, the module path fed to `findPackageRoot`, the `build-info.json` sibling lookup) is called in exactly one module — `lib/env.ts` — and its results are exported for reuse; no other module calls `import.meta.url`. Bundling collapses everything into `dist/oms.js`, so every `import.meta.url` resolves to that one file regardless of source module; centralizing it keeps the runtime path contract a single anchor and removes any split-time confusion about the resolution base.

### Dependencies move to devDependencies
Since the four deps are inlined, they move from `dependencies` to `devDependencies`, and `esbuild` is added as a dev dependency. The published package ships only `dist/` and declares no runtime dependencies. Bundling vendors third-party code into `dist/oms.js`; all four are MIT/ISC, so license-compatible.

## Risks / Trade-offs

- **Interactive `@clack/prompts` I/O is not covered by `npm test`** (tests use non-TTY stdin and fail-fast on omitted aliases). The scope is narrow, though: `commander`/`@clack/prompts` are top-level static imports, so any command (even `--version`) module-evals the whole bundle — the most likely bundling failures (load-time `Dynamic require`/CJS-interop errors) are therefore already caught automatically by the existing black-box suite. The genuine blind spot is only the interactive runtime I/O (raw mode, keypress handling, select/multiselect rendering), which is impractical to automate cheaply (would need a native PTY dep). Mitigation: a mandatory manual TTY smoke test (e.g. `oms sync` with no alias) against the bundle before archiving — no new automated gate is added.
- **A bug could be introduced by either the bundling change or the source split** → Mitigation: sequence them — bundle the monolithic file first and pass `npm test`, then split and re-pass `npm test`, using the black-box suite as a checkpoint to localize any regression.
- **`import.meta.url`-based resolution could break if output format/location changed** → Mitigation: lock `format: "esm"` and the `dist/oms.js` output path; PoC confirmed resolution survives.
- **Vendored dep upgrades now require a rebuild** (no transitive runtime resolution) → acceptable for a CLI; rebuilds happen on every release anyway.

## Migration Plan

1. Introduce `scripts/build.mjs` + esbuild bundling on the **unsplit** `oms.ts`; update `package.json` build/deps; run `npm test` → must pass.
2. Manual TTY smoke test of the bundle (interactive prompt path).
3. Split `oms.ts` into `scripts/lib/*` modules incrementally; run `npm test` after the split → must pass.
4. Add a changeset entry (build/packaging change).

Rollback: the bundle and the source split land as two separate commits (bundle first, split second), each gated on a passing black-box `npm test`. The split commit can be reverted alone (returns to the monolithic-but-bundled file). The bundle commit cannot be reverted in isolation once the split sits on top — reverting it while keeping the split would feed split sources to a `tsc`-emit build and produce multiple broken `dist/*.js`; revert the split first. The real safety net is the per-commit black-box test gate that localizes any regression, not symmetric independent reverts.

## Resolved Questions

- Meta-command module granularity: **one file per command from the start** (`lib/agent.ts`, `lib/skills.ts`, `lib/init.ts`, `lib/doctor.ts`, `lib/update.ts`), flat under `scripts/lib/`. "meta" stays a conceptual label, not a directory.
- Explicit `chmod 0o755`: **kept** in `build.mjs` as a safety belt rather than relying on esbuild's shebang-triggered exec bit — a missing exec bit on the published `bin` is a fatal regression and the guard costs one line.
- Bundle output shape: **not minified, no sourcemap, `keepNames: true`, `legalComments: "eof"`** (see Bundler decision).
- Type-check config: **base `tsconfig.json` with `tsc --noEmit`; `tsconfig.build.json` deleted** (see type-check decision).
- Changeset bump: **patch** — no user-observable CLI behavior changes; inlining deps is a transparent packaging improvement.
