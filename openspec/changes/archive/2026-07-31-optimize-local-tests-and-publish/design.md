## Context

The canonical suite contains 295 black-box cases. Every case starts the bundled CLI in a child Node process, and Git-heavy cases create isolated repositories and start many additional Git processes. A measured run on the maintainer's M2 Mac took 349.63 seconds, while recent Linux GitHub Actions Test steps took 38–55 seconds. Static inspection found hundreds of direct CLI and Git helper invocations, and process-start microbenchmarks showed that local Node and Git process startup alone costs roughly 70–90 ms per invocation.

The suite is already split into six files with concurrency four, but the two 74–75-case commit and sync files remain active after the other workers finish. More file splitting can reduce that scheduling tail, but it cannot remove the dominant process and fixture cost.

Packaging repeats the cost. `prepack` currently runs `npm test`, so `npm pack` and `npm publish` execute the complete suite even when the same worktree content has just passed the canonical gate. The beta publisher also rewrites three package-version fields to a deterministic `<base>-beta.sha-<HEAD>` value before npm invokes `prepack`, which makes a byte-for-byte package metadata fingerprint differ from the preceding stable-version test run.

The source already has useful seams: almost all Git calls pass through `runGit` or `runSub`; state classifiers, manifest validation, redaction, aggregation, and formatting can become pure or runner-injected tests. `root-tx.ts` remains the highest-risk coupled component because it coordinates real Git refs, indexes, filesystem durability, recovery markers, and process input.

## Goals / Non-Goals

**Goals:**

- Preserve every observable contract represented by the 295-case baseline while moving most contracts out of full CLI-and-Git black-box processes.
- Complete `npm test`, including type-checking and the production build, with a three-run median of at most 60 seconds and no run above 75 seconds on the documented M2/Node 24 environment.
- Keep both Node 20.19 and Node 24 CI Test steps at or below 60 seconds.
- Reuse a canonical successful test result for matching package operations without reusing generated build artifacts.
- Fail safely: any uncertain verification state runs the complete suite, and any build or artifact-integrity failure blocks packaging.
- Keep direct `npm pack` and `npm publish`, beta release, and Changesets release paths protected by the same package lifecycle gate.
- Preserve auditable, focused test commands and explicit migration evidence.

**Non-Goals:**

- Changing public CLI behavior, workspace layout, package contents, Node support, or npm channel semantics.
- Trusting a focused subset as a complete package verification.
- Reusing `dist/` or another generated artifact across package operations.
- Sharing local verification across worktrees, clones, machines, or materially different runtimes.
- Using live network remotes in the canonical suite.
- Adding a TypeScript test runtime dependency.

## Decisions

### Use a layered canonical suite

`npm test` will run these phases in fail-fast order:

1. Type-check and build the production bundle.
2. Compile TypeScript test modules to disposable JavaScript with `tsc` and run pure unit tests.
3. Run shallow integration tests against per-test directories under file-owned temporary roots.
4. Run a bounded real CLI-and-Git black-box inventory.
5. Record successful verification only if the test-relevant inputs did not change during the run.

The repository will expose layer commands (`test:unit`, `test:integration`, `test:blackbox`) and feature commands such as `test:sync` and `test:commit`. These commands improve development feedback but never write a complete verification record.

Running all layers in parallel was rejected because fast failures would still spend time on expensive Git fixtures, and concurrent TypeScript, Git, and filesystem work can contend on macOS. TypeScript tests will be compiled with the existing compiler instead of adding `tsx`; esbuild test bundles were rejected because bundling would hide module boundaries that the tests should exercise.

### Separate a functional core from injected side effects

State classification, parsing, validation, redaction, formatting, and command planning will be expressed as pure input-to-output functions. Remaining orchestration will accept a small raw Git runner that receives `cwd`, arguments, and optional input and returns `GitResult`. Filesystem behavior will use real disposable directories when file semantics are the contract and injected Git results when Git itself is not under test.

A large domain-specific Git abstraction was rejected because it would duplicate Git semantics and expand the maintenance surface. Per-command dependency bags were rejected because they would create inconsistent seams. The raw runner keeps the production path close to today's `runGit`/`runSub` boundary while permitting deterministic orchestration tests.

### Preserve contracts through explicit migration evidence

Every existing test name will map to one or more replacement unit, integration, or black-box tests. Multiple old names may map to one replacement only when that replacement asserts every former observable outcome. The completed mapping and count reconciliation will be retained in this change's verification evidence; it will not become a permanent source file.

This makes silent coverage deletion detectable while allowing the implementation to choose the cheapest boundary that still preserves each contract.

### Bound the real CLI-and-Git layer by measured runtime

The completed suite retains all 295 bundled-CLI contracts because immutable template fixtures and deterministic sharding brought the full layer under the acceptance target without deleting real-process coverage. Pure and injected tests still cover decision boundaries directly, while the bundled layer remains the compatibility backstop.

The four largest inventories are stored once as contract modules and loaded through deterministic shard entry points: branch list uses two shards; branch, commit, and sync use three shards each. Every contract runs exactly once, shard processes remain isolated, and the canonical runner uses an explicit concurrency of six selected by local measurement.

All remote behavior uses local `file://` bare repositories. High-fan-out Git parsing and classifiers use the injected raw runner, while root transaction crash stages and data-integrity failures retain their real Git and bundled-CLI coverage. Immutable bare/workspace templates replace repeated recursive clones without sharing mutable state between tests.

This measured design preserves more process-boundary assurance than the planned 25–35-case migration while still meeting the 60-second median and 75-second worst-run limits.

### Record only complete, unchanged verification

A dependency-free fingerprint tool shared by local verification and CI will cover path, content, and mode for every relevant tracked input. Local calculation will also include relevant untracked files. Generated output, dependency directories, and the marker itself are excluded. The existing conservative CI exclusions are the initial common list; a new path may be excluded only with evidence that it cannot affect any test outcome. Test-read records such as `skills/*/SKILL.md` remain included.

The verification key combines the fingerprint with exact Node version, Git version, OS name and version, and architecture. Tests will normalize outcome-affecting ambient state such as external Git configuration, hooks, and Node options rather than trying to encode unbounded user configuration into the key.

Only canonical `npm test` may write the record. It snapshots inputs before execution, invalidates a matching prior record when a new run fails, and writes only when the post-run fingerprint still matches. A write failure emits a warning without failing the suite; package operations then safely fall back to a complete run.

The record is gitignored, excluded from the npm package, local to one worktree, retains only the latest successful key, and has no time expiry. Cross-worktree or global caches were rejected because they complicate ownership and accidental reuse for little benefit in the immediate test-then-publish workflow.

### Make prepack verification-aware but artifact-strict

Every `npm pack` and `npm publish`, whether direct or reached through repository scripts, will execute a verification-aware `prepack` gate:

- Missing, malformed, mismatched, or force-disabled record: run canonical `npm test`.
- Exact record: skip only the suite, then always type-check and rebuild the production bundle.
- After either path: execute the bundle, compare its reported version with package metadata, and inspect the package metadata needed to prove the artifact reflects the current package state.

A build or smoke-check failure invalidates the record and blocks packaging. Registry, authentication, or network failures after local verification preserve the record because they do not refute the tested content. `OMS_FORCE_TEST=1` disables reuse. Normal output reports reuse in one line; `OMS_VERIFICATION_VERBOSE=1` reports the verification time, fingerprint, environment identity, and originating command.

Allowing a marker hit to skip the build was rejected because `dist/` may be missing or stale even when source inputs match. Limiting reuse to repository scripts was rejected in favor of one predictable prepack contract for direct npm commands as well.

### Normalize only the deterministic beta version transform

The logical fingerprint may treat the stable metadata and beta-prepared metadata as equivalent only when:

- The prerelease is exactly `<base>-beta.sha-<current HEAD short hash>`.
- The only normalized differences are `package.json.version`, `package-lock.json.version`, and `package-lock.json.packages[""].version`.
- Every other test-relevant byte is unchanged.

On a reuse hit, beta dry-run and publish still rewrite the metadata, rebuild, run the executable, and verify that CLI and package versions exactly match the expected beta. A matching dry-run verification may therefore serve the subsequent publish, but the later publish repeats the inexpensive build and artifact checks.

Ignoring every prerelease version or whole package files was rejected because dependency, script, and package-content changes could otherwise bypass verification.

### Share fingerprint logic while keeping storage roles separate

Local prepack verification and CI verification markers will use the same dependency-free fingerprint implementation and exclusion configuration. Their stores and surrounding workflow remain distinct: CI requires an exact cache key before dependency installation, while local prepack needs a worktree-owned latest record after `npm test`.

The release workflow's explicit `npm test` will create a same-job record, allowing a subsequent Changesets-driven `npm publish` to reuse the suite while still rebuilding and smoke-checking. Pull-request cache hits remain governed by the existing CI marker policy.

## Risks / Trade-offs

- **[Injected tests accidentally validate mocks instead of behavior]** -> Keep pure classifiers fed by raw Git results, retain every real-Git contract shard as the compatibility backstop, and map every old observable contract explicitly.
- **[The 60-second goal conflicts with real-Git safety coverage]** -> Optimize fixtures and scheduling first, then lower non-destructive process boundaries, and finally retain representative real-Git crash stages without deleting behavior assertions.
- **[A stale marker skips necessary tests]** -> Hash all non-excluded tracked and relevant untracked inputs, key exact environment identity, compare before and after the suite, retain only exact matches, and fall back on any parse or lookup error.
- **[Beta normalization hides a real package change]** -> Recognize only the publisher's exact HEAD-derived version and three named fields; rebuild and verify the exact artifact version every time.
- **[Ambient developer configuration makes tests non-repeatable]** -> Clear or replace outcome-affecting Node and Git configuration in the test environment while retaining explicit compatibility tests where configuration behavior is itself a contract.
- **[The local marker becomes a packaging input]** -> Gitignore it, exclude it from fingerprint and package files, and verify package contents independently.
- **[Sharding accidentally skips or duplicates contracts]** -> Keep contract declarations single-sourced, select by deterministic ordinal, assert the 295-name inventory, and run every shard in the canonical gate.
- **[CI performance varies near the 60-second boundary]** -> Benchmark cache misses on both matrix entries, retain bounded concurrency, and record three comparable local runs plus representative CI step timings before acceptance.

## Migration Plan

1. Capture the synchronized 295-test baseline, local three-run timing, representative CI timings, and old-name contract inventory.
2. Introduce the shared fingerprint/exclusion implementation and local marker format without changing prepack behavior; prove sensitivity, exclusions, untracked handling, environment separation, and before/after stability.
3. Make canonical `npm test` record successful verification and invalidate it on subsequent test, build, or artifact-check failures.
4. Replace `prepack` with the verification-aware gate, cover direct pack/publish, beta normalization, dry-run-to-publish reuse, force mode, audit output, and safe fallback; verify the existing CI and release paths.
5. Add the TypeScript test build and pure/injected boundaries, then retain the explicit 295-name mapping as the suite evolves.
6. Replace repeated recursive fixture cloning with immutable templates and partition the four largest contract inventories into deterministic shards.
7. Retain real-Git root transaction and data-integrity coverage while injecting high-fan-out Git parsing and classification boundaries.
8. Benchmark Git-layer concurrency two, four, and six, select the stable winner, then run three complete local Node 24 measurements and both CI matrix entries.
9. If performance misses the target, reduce non-destructive process boundaries without deleting mapped behavior contracts.
10. Verify direct and scripted stable/beta packaging, package contents, artifact version parity, marker fallback, and registry-failure retention before release.

Rollback is fail-safe: restoring `prepack` to unconditional `npm test` disables reuse immediately, while the layered suite can remain canonical if its contract map and compatibility matrix pass. The local marker is disposable and carries no migration state.
