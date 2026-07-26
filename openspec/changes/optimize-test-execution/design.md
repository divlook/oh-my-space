## Context

The repository has one 4,500-line black-box test file containing more than 260 cases. The cases synchronously spawn the bundled CLI and real Git commands, and many independently initialize a bare upstream, seed repository, root repository, and submodule. Node can parallelize test files in separate processes, but the single-file layout leaves the suite serial.

The CI and release workflows run `npm test` and then `npm pack --dry-run`. npm executes the package's `prepack` lifecycle during the dry run, and `prepack` calls `npm test`, so each job repeats the full build and suite. Recent CI jobs spend roughly the same 70-120 seconds in each of those two steps; dependency installation and type checking are comparatively negligible.

The test suite is intentionally black-box and validates the built `dist/oms.js`. Optimization must preserve process boundaries, real Git behavior, the supported Node.js matrix, and the `prepack` safety gate used by real packaging and publishing.

## Goals / Non-Goals

**Goals:**

- Run the full suite at most once in each CI validation job before inspecting package contents.
- Enable bounded file-level parallel execution while preserving isolated Git state and black-box CLI invocation.
- Make focused local verification discoverable without weakening `npm test` as the complete gate.
- Measure before and after execution times on comparable environments and achieve a material reduction rather than relying on structural changes alone.
- Remove temporary test workspaces in batches so repeated local runs do not accumulate repositories.

**Non-Goals:**

- Changing production CLI behavior or package contents.
- Removing real Git or child-process coverage from the black-box suite.
- Dropping either the minimum-supported or development Node.js CI coverage in this change.
- Changing push versus pull-request trigger policy; that runner-usage decision is independent of per-job execution time.
- Replacing the Node test runner or adding a test framework dependency.

## Decisions

### Keep the publish safety gate and bypass it only for redundant CI inspection

`prepack: npm test` remains unchanged so direct `npm pack`, beta packaging, and `npm publish` retain the established safety gate. After an explicit successful `npm test`, CI package inspection will use `npm pack --dry-run --ignore-scripts`. This still validates the package file list generated from the just-built workspace without rerunning lifecycle scripts.

Removing `prepack` was rejected because it would make manual and publish flows depend entirely on callers remembering to test. Removing the explicit CI test step was also rejected because failures would be hidden inside a step named for packaging and would couple test reporting to npm lifecycle behavior.

### Split by execution balance, not only by source headings

Shared environment, CLI, Git, manifest, and fixture helpers will move to test helper modules. Cases will be divided into a small number of feature-oriented files, then adjusted so the slow Git-heavy groups have comparable durations. The initial runner concurrency will be explicitly bounded at four and benchmarked; it may be lowered when a two-worker run is faster or more stable on hosted CI.

Using top-level `concurrency: true` in the existing file was rejected because synchronous `spawnSync` and `execFileSync` calls block one event loop. Creating one file for every existing heading was rejected because excessive Git process and filesystem contention can erase parallelism gains.

### Preserve test isolation across worker processes

Each test keeps a unique workspace and must not mutate a repository shared with another test. Helpers will allocate temporary paths beneath a worker-owned temporary root and remove that root after the file completes. Immutable Git objects may be reused only through an isolated local clone; refs, indexes, configs, worktrees, and bare push targets remain test-owned.

Combining several behavioral cases into one mutable workspace was rejected because state coupling would make failures order-dependent and harder to diagnose.

### Gate fixture-template optimization on measured need

The first benchmark follows duplicate-run removal and balanced file splitting. If the local full-suite median remains above 60% of the recorded baseline, expensive upstream and initialized-workspace fixtures will be profiled and replaced with immutable templates plus isolated local clones. This avoids adding fixture complexity when process-level parallelism already meets the target.

### Expose full and focused commands with one canonical full gate

`npm test` remains the command that builds once and runs every test file. Additional scripts may target stable feature groups for local work, but they will reuse the same runner options and test files rather than define a second test inventory. CI continues to call the canonical full command.

### Use relative, repeatable performance evidence

Before and after measurements will use the same machine, Node version, warm dependency state, and three complete runs; the median is recorded. The target is at least a 40% reduction in local full-suite median and at least a 40% reduction in the cumulative CI `Test` plus `Pack dry run` duration. Performance measurements are acceptance evidence, not timing assertions embedded in tests.

## Risks / Trade-offs

- [Parallel Git operations saturate disk or CPU and make the suite slower] -> Benchmark bounded concurrency values of two and four, select the lower stable median, and keep the value explicit.
- [Splitting the suite accidentally drops cases] -> Record the baseline test count and names, then compare the post-split inventory before accepting behavioral edits.
- [Shared helpers introduce hidden mutable state] -> Keep helper module state immutable except for a worker-owned temporary-root registry; every writable repository remains test-owned.
- [Template repositories leak mutations between tests] -> Clone templates locally and add an isolation test that mutates refs and config in one clone without affecting another.
- [`--ignore-scripts` skips a packaging behavior that CI should validate] -> Run the full canonical test immediately before package inspection and retain lifecycle execution in real pack and publish flows.
- [Cleanup masks evidence needed after a failure] -> Include failed workspace paths in assertion diagnostics before cleanup and permit an opt-in environment variable to retain fixtures for debugging.
- [Current source, bundle, and tests are not synchronized when implementation starts] -> Build and pass the baseline suite before collecting timing data or reorganizing files; resolve unrelated baseline failures separately.

## Migration Plan

1. Establish a clean baseline build, test inventory, and three-run timing median on the supported local Node version; collect recent CI step timings.
2. Change CI and release package inspection to skip lifecycle scripts after the explicit full test, and verify real `prepack` behavior remains unchanged.
3. Extract shared test helpers and split one feature group at a time, comparing test names and running the affected group after each move.
4. Enable bounded file concurrency, benchmark two and four workers, and select the stable setting with the lower median.
5. Add focused local scripts and batched temporary-root cleanup.
6. Introduce immutable fixture templates only if the first optimization pass misses the local target, then repeat isolation and timing verification.
7. Run the full Node.js matrix and package dry-run verification and record final timings.

Rollback is straightforward: CI can remove `--ignore-scripts`, and test files can continue to run serially by setting concurrency to one. The production bundle and publish contract are unchanged.

## Open Questions

- Which file grouping produces the best balance after real durations are collected from the synchronized baseline?
- Does the hosted runner perform better with two or four concurrent test files under Git-heavy load?
- Is fixture-template reuse necessary after duplicate execution and file-level serialization are removed?
