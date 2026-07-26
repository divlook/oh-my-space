## 1. Baseline and Inventory

- [x] 1.1 Rebuild `dist/oms.js` on a clean, synchronized source/test baseline and require the existing full suite to pass before reorganizing tests; report and resolve unrelated baseline failures outside this change.
- [x] 1.2 Record the full test names and count, three-run local median on the development Node.js version, and representative `Test` and `Pack dry run` timings for both CI matrix entries.
- [x] 1.3 Classify test groups by duration and Git fixture usage, then choose an initial set of balanced feature-oriented files.

## 2. Remove Redundant CI Execution

- [x] 2.1 Update CI package inspection to run `npm pack --dry-run --ignore-scripts` only after the explicit `npm test` step succeeds.
- [x] 2.2 Apply the same non-duplicative package inspection to the release validation workflow while leaving `prepack: npm test` unchanged.
- [x] 2.3 Verify a normal package lifecycle still invokes `prepack`, while the CI dry-run command produces the expected package file list without invoking tests.

## 3. Split and Parallelize the Suite

- [x] 3.1 Extract shared CLI, environment, manifest, and Git fixture helpers from `tests/cli.test.js` into test helper modules without changing behavior.
- [x] 3.2 Move tests incrementally into the selected feature files and compare the resulting test-name inventory with the recorded baseline after each group.
- [x] 3.3 Allocate fixtures beneath worker-owned temporary roots, add batched cleanup with an opt-in fixture-retention environment variable, and include retained paths in failure diagnostics.
- [x] 3.4 Benchmark explicit test-file concurrency values of two and four on the same environment and configure the stable value with the lower three-run median.
- [x] 3.5 Run the complete suite repeatedly with the selected concurrency and verify no order dependence, shared mutable Git state, or intermittent failures.

## 4. Optimize Git Fixtures if Needed

- [x] 4.1 Compare the split-suite local median with the baseline and document whether it meets the requirement of no more than 60 percent of baseline duration.
- [x] 4.2 If the target is missed, profile fixture setup and introduce immutable upstream or initialized-workspace templates consumed through isolated local clones.
- [x] 4.3 If templates are introduced, add isolation coverage proving that refs and configuration mutated in one clone do not affect the template or another clone.

## 5. Local Developer Commands

- [x] 5.1 Add stable focused test scripts for the feature files while keeping `npm test` as the single command that builds once and runs the complete inventory.
- [x] 5.2 Document the full and focused commands, including the requirement to rebuild the bundle before directly invoking a focused black-box test.

## 6. Verification and Performance Acceptance

- [x] 6.1 Run the complete suite on Node.js 20.19.0 and the `.nvmrc` development version, then verify the package dry-run output on both versions.
- [x] 6.2 Repeat the local benchmark three times under the baseline conditions and confirm the optimized median is no more than 60 percent of the recorded baseline.
- [x] 6.3 Inspect a completed CI run and confirm cumulative `Test` plus `Pack dry run` duration is no more than 60 percent of the representative baseline for each matrix entry.
- [x] 6.4 Run `openspec validate optimize-test-execution --strict` and record the final test inventory, concurrency setting, timing evidence, and any fixture-template decision.
